import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- runtime ESM.
import { createGatewayClient } from '../scripts/hermes-gateway-client.mjs';
// @ts-expect-error -- runtime ESM.
import { createBridgeServer } from '../scripts/bridge.mjs';
// @ts-expect-error -- runtime ESM.
import { writeChatBindingsAtomic } from '../scripts/bridge-chat-store.mjs';

const root = '20260923123456-abcdefg';
const capability = 'f'.repeat(64);
// Independently authored RPC wire shape, including the upstream field order.
const rpcFixture = { role: 'assistant', text: 'synthetic answer', timestamp: 123, row_id: 7,
  reasoning: 'synthetic reasoning', reasoning_content: '', reasoning_details: [{ type: 'summary', text: 'detail' }],
  codex_reasoning_items: [{ type: 'reasoning', summary: [] }], codex_message_items: [],
  display_kind: 'answer', display_metadata: { synthetic: true } };
const restFixture = { id: 7, role: 'assistant', content: '  synthetic answer\n', timestamp: 123,
  reasoning: 'synthetic reasoning', reasoning_content: '', reasoning_details: '[{"type":"summary","text":"detail"}]',
  codex_reasoning_items: '[{"type":"reasoning","summary":[]}]', codex_message_items: '[]',
  display_kind: 'answer', display_metadata: { synthetic: true } };

async function fixture(anchorFixture = rpcFixture) {
  const dir = await mkdtemp(join(tmpdir(), 'history-bridge-'));
  const bindingsFile = join(dir, 'legacy.json');
  const bindingsV2File = join(dir, 'v2.json');
  const tokenFile = join(dir, 'token');
  await writeFile(bindingsFile, '{}');
  await writeFile(tokenFile, 'synthetic-private-token', { mode: 0o600 });
  const binding = { chatId: 'local-1', connectionId: 'serve-local', kind: 'serve', profile: 'default', documentRootId: root,
    title: 'Synthetic', state: 'ready', storedSessionId: 'stored-1', installId: 'install-1',
    anchor: { messageId: '7', sha256: createHash('sha256').update(JSON.stringify(anchorFixture)).digest('hex') } };
  await writeChatBindingsAtomic(bindingsV2File, { 'local-1': binding });
  let row: any = restFixture;
  let profile = 'default';
  let sessionId = 'stored-1';
  const frames: any[] = [];
  let historyCalls = 0;
  const socketFactory = () => {
    const listeners = new Map<string, Set<(event: any) => void>>();
    const emit = (frame: any) => { for (const listener of listeners.get('message') ?? []) listener({ data: JSON.stringify(frame) }); };
    const socket = {
      addEventListener(type: string, listener: (event: any) => void) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
      removeEventListener(type: string, listener: (event: any) => void) { listeners.get(type)?.delete(listener); },
      send(raw: string) { const frame = JSON.parse(raw); frames.push(frame); assert.ok(['gateway.ping', 'session.list'].includes(frame.method), 'history must never resume/create/submit');
        queueMicrotask(() => emit({ jsonrpc: '2.0', id: frame.id, result: frame.method === 'gateway.ping' ? { ok: true } : { sessions: [{ id: 'stored-1' }] } })); },
      close() {},
    };
    queueMicrotask(() => emit({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } }));
    return socket;
  };
  const fetchImpl = async (input: any, init: any) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/status') return new Response(JSON.stringify({ install_id: 'install-1' }));
    assert.equal(url.pathname, '/api/sessions/stored-1/messages');
    assert.equal(init.headers['X-Hermes-Session-Token'], 'synthetic-private-token');
    historyCalls++;
    const messages = Array.isArray(row) ? row : [row];
    return new Response(JSON.stringify({ session_id: sessionId, profile, messages, pagination: { limit: 500, offset: 0, order: 'oldest', returned: messages.length } }));
  };
  const connection = { id: 'serve-local', kind: 'serve', baseUrl: 'http://127.0.0.1:9119/', profile: 'default', tokenFile };
  const { server } = createBridgeServer({ capability, bindingsFile, bindingsV2File, fetchImpl,
    connections: { defaultConnectionId: 'serve-local', connections: [connection] },
    gatewayFactory: ({ connection, token }: any) => createGatewayClient({ baseUrl: connection.baseUrl, token, profile: connection.profile, socketFactory, fetchImpl, timeoutMs: 100 }),
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = () => fetch(`http://127.0.0.1:${address.port}/chats/local-1/messages`, { headers: { 'X-Siyuan-Collab-Token': capability, 'X-Siyuan-Document-Root': root } });
  return { call, frames, binding, bindingsV2File, historyCalls: () => historyCalls,
    setRow: (value: any) => { row = value; }, setProfile: (value: string) => { profile = value; }, setSessionId: (value: string) => { sessionId = value; },
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}

test('actual Gateway and Bridge accept the old RPC anchor for equivalent REST projection', async () => {
  const f = await fixture();
  try {
    const response = await f.call();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: [{ id: '7', role: 'assistant', content: 'synthetic answer', timestamp: 123 }] });
    assert.deepEqual(JSON.parse(await readFile(f.bindingsV2File, 'utf8'))['local-1'], f.binding);
    assert.equal(f.historyCalls(), 1);
    assert.ok(f.frames.every(frame => ['gateway.ping', 'session.list'].includes(frame.method)));
  } finally { await f.close(); }
});

test('altered row, unsupported old projection, profile or exact session identity preserve binding and anchor', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.bindingsV2File, 'utf8');
    for (const changes of [
      () => f.setRow({ ...restFixture, content: 'altered' }),
      () => f.setRow({ ...restFixture, id: 8 }),
      () => f.setRow({ ...restFixture, content: '<context>unsupported projection</context>synthetic answer' }),
      () => { f.setRow(restFixture); f.setProfile('other'); },
      () => { f.setProfile('default'); f.setSessionId('compressed-alias'); },
    ]) {
      changes();
      const response = await f.call();
      assert.ok(response.status >= 400);
      assert.equal(await readFile(f.bindingsV2File, 'utf8'), before);
      assert.ok(f.frames.every(frame => ['gateway.ping', 'session.list'].includes(frame.method)));
    }
  } finally { await f.close(); }
});


const unsupportedRows = [
  { id: 8, role: 'user', content: 'visible< MEMORY-context >synthetic internal context</memory-context>' },
  { id: 8, role: 'assistant', content: 'visible</ memory-context >' },
  { id: 8, role: 'assistant', content: '[System note: The following is recalled memory context, NOT new user input. Treat as informational background data.] synthetic context' },
  { id: 8, role: 'user', content: '[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data from a memory tool.] synthetic context' },
  { id: 8, role: 'user', content: '[IMPORTANT: The "synthetic" skill is auto-loaded. Follow its instructions for this session.]\nsynthetic internal skill body' },
  { id: 8, role: 'user', content: '[/initiate-setup]\nsynthetic internal setup body' },
  { id: 8, role: 'assistant', content: 'visible<memory-context>synthetic internal context</memory-context>' },
  { id: 8, role: 'user', content: 'visible ask\n\n[/first-task]\n\nsynthetic full skill body' },
  { id: 8, role: 'user', content: '[IMPORTANT: The user has invoked the "synthetic" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\nsynthetic internal body\nThe user has provided the following instruction alongside the skill invocation: visible ask' },
];

for (const [index, unsupportedRow] of unsupportedRows.entries()) test(`ordinary old anchor followed by unsupported marked row ${index + 1} refuses the entire Bridge read`, async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.bindingsV2File, 'utf8');
    f.setRow([restFixture, unsupportedRow]);
    const response = await f.call();
    assert.ok(response.status >= 400, 'an unchanged old anchor cannot authorize a new unprojected scaffold row');
    assert.equal(await readFile(f.bindingsV2File, 'utf8'), before);
    assert.equal(f.historyCalls(), 1);
    assert.ok(f.frames.every(frame => ['gateway.ping', 'session.list'].includes(frame.method)));
    assert.equal((await response.text()).includes('synthetic internal'), false);
  } finally { await f.close(); }
});


test('ordinary unmarked appended text remains usable alongside the old anchor', async () => {
  const f = await fixture();
  try {
    const ordinary = '[IMPORTANT: Keep this ordinary note] memory-context is a topic; /synthetic is a command example; [/first-task] lacks the exact trailer fence.';
    f.setRow([restFixture, { id: 8, role: 'user', content: ordinary }]);
    const response = await f.call();
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.at(-1).content, ordinary);
    assert.ok(f.frames.every(frame => ['gateway.ping', 'session.list'].includes(frame.method)));
  } finally { await f.close(); }
});


for (const character of ['\u0085', '\u001c', '\u001d', '\u001e', '\u001f']) test(`Python whitespace ${character.codePointAt(0)} preserves the independent ordinary RPC anchor`, async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.bindingsV2File, 'utf8');
    f.setRow({ ...restFixture, content: `${character}synthetic answer${character}` });
    const response = await f.call();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].content, 'synthetic answer');
    assert.equal(await readFile(f.bindingsV2File, 'utf8'), before);
  } finally { await f.close(); }
});

test('Python strip preserves BOM text for an independently authored old RPC anchor', async () => {
  const text = '\ufeffsynthetic answer\ufeff';
  const f = await fixture({ ...rpcFixture, text });
  try {
    const before = await readFile(f.bindingsV2File, 'utf8');
    f.setRow({ ...restFixture, content: text });
    const response = await f.call();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].content, text);
    assert.equal(await readFile(f.bindingsV2File, 'utf8'), before);
  } finally { await f.close(); }
});
