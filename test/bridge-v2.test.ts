import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- runtime ESM module has no declaration.
import { readChatBindings, writeChatBindingsAtomic, assertChatScope } from '../scripts/bridge-chat-store.mjs';
// @ts-expect-error -- runtime ESM module has no declaration.
import { createBridgeServer } from '../scripts/bridge.mjs';
import { createBridgeClient } from '../src/bridge.ts';

const ROOT = '20260923123456-abcdefg';
const OTHER_ROOT = '20260923123457-abcdefg';
const CAP = 'c'.repeat(64);
const validBinding = { chatId: 'a', connectionId: 'serve-local', kind: 'serve', profile: 'default', documentRootId: ROOT, title: 'A', state: 'pending', storedSessionId: null, installId: 'install-1', anchor: null };

async function fixture(options: { studioRun?: (input: any) => Promise<unknown>; failStudioRename?: boolean; strictProbeClose?: boolean; studioCandidate?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-v2-'));
  const legacyFile = join(dir, 'legacy.json');
  const v2File = join(dir, 'v2.json');
  const tokenFile = join(dir, 'serve-token');
  await writeFile(legacyFile, '{}');
  await writeFile(tokenFile, 'private-test-value');
  const fakeGateway = {
    createCalls: 0, submitCalls: 0, submittedTexts: [] as string[], historyCalls: 0, interruptCalls: 0, pingCalls: 0, pingThrows: false, listThrows: false,
    createWait: null as Promise<void> | null,
    submitWait: null as Promise<void> | null,
    submitAccepted: true,
    submitEvent: null as { type: string; payload: Record<string, unknown> } | null,
    historyError: null as Error | null,
    submitResult: { state: 'complete', text: '答复', userRowId: 12 } as { state: string; text: string; userRowId?: number },
    historyMessages: [{ role: 'user', text: '问题', row_id: 12 }],
    async list() { if (this.listThrows) throw new Error('probe unavailable'); return { sessions: [{ id: 'stored-1', title: 'Existing' }] }; },
    async ping() { this.pingCalls++; if (this.pingThrows) throw new Error('probe unavailable'); return { ok: true }; },
    async create() { this.createCalls++; if (this.createWait) await this.createWait; return { runtimeSessionId: `live-${this.createCalls}`, storedSessionId: `stored-${this.createCalls}` }; },
    async resume() { return 'live-1'; },
    async history() { this.historyCalls++; if (this.historyError) throw this.historyError; return { count: this.historyMessages.length, messages: this.historyMessages }; },
    async submit(_id?: string, _text?: string, { onAccepted, onEvent }: { onAccepted?: (value: any) => void; onEvent?: (value: any) => void } = {}) { this.submitCalls++; this.submittedTexts.push(String(_text ?? '')); if (this.submitAccepted) onAccepted?.({ status: 'streaming', userRowId: 12 }); if (this.submitEvent) onEvent?.(this.submitEvent); if (this.submitWait) await this.submitWait; return this.submitResult; },
    async interrupt() { this.interruptCalls++; return { status: 'interrupted' }; },
    close() {},
  };
  const connections = { defaultConnectionId: 'serve-local', connections: [
    { id: 'serve-local', kind: 'serve', baseUrl: 'http://127.0.0.1:9119/', profile: 'default', tokenFile },
    { id: 'serve-other', kind: 'serve', baseUrl: 'http://127.0.0.1:9120/', profile: 'default', tokenFile },
    { id: 'studio-default', kind: 'studio', profile: 'default' },
    { id: 'legacy-api', kind: 'legacy-api', profile: 'default' },
  ] };
  let installId = 'install-1';
  const { server } = createBridgeServer({ capability: CAP, bindingsFile: legacyFile, bindingsV2File: v2File, connections,
    gatewayFactory: () => {
      if (!options.strictProbeClose) return fakeGateway;
      let closed = false;
      const delayed = (value: unknown) => new Promise((resolve, reject) => setTimeout(() => closed ? reject(new Error('closed before RPC reply')) : resolve(value), 2));
      return { ...fakeGateway, ping: () => delayed({ ok: true }), list: () => delayed({ sessions: [{ id: 'stored-1', title: 'Existing' }] }), close: () => { closed = true; } };
    },
    ...(options.studioRun ? { studioRun: options.studioRun } : {}),
    fetchImpl: async (url: string | URL) => String(url).includes('/api/status')
      ? new Response(JSON.stringify({ install_id: installId }), { status: 200 })
      : options.failStudioRename && String(url).includes('/rename')
        ? new Response('{}', { status: 503 })
        : options.studioCandidate && String(url).includes('/api/studio/sessions')
          ? new Response(JSON.stringify({ sessions: [{ id: options.studioCandidate, title: '候选', profile: 'default' }], hasMore: false, offset: 0, limit: 200 }), { status: 200 })
        : new Response(JSON.stringify({ data: [], sessions: [] }), { status: 200 }),
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, method = 'GET', body?: unknown, root = ROOT, cap = CAP) => fetch(`${base}${path}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Siyuan-Collab-Token': cap, ...(root ? { 'X-Siyuan-Document-Root': root } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { call, base, fakeGateway, legacyFile, v2File, setInstallId: (id: string) => { installId = id; },
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); } };
}

test('v2 store treats missing as empty, refuses corrupt data and enforces scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'v2-store-'));
  try {
    const file = join(dir, 'bindings.json');
    assert.deepEqual(await readChatBindings(file), {});
    await writeChatBindingsAtomic(file, { a: validBinding });
    assert.equal(assertChatScope({ documentRootId: ROOT }, ROOT), true);
    assert.throws(() => assertChatScope({ documentRootId: ROOT }, OTHER_ROOT));
    await writeFile(file, '{broken');
    await assert.rejects(() => readChatBindings(file), /损坏|格式/);
    await assert.rejects(() => writeChatBindingsAtomic(file, {}), /损坏|格式/);
    assert.equal(await readFile(file, 'utf8'), '{broken');
    await writeFile(file, '{"bad":null}');
    await assert.rejects(() => readChatBindings(file), /损坏|格式/);
    await assert.rejects(() => writeChatBindingsAtomic(file, {}), /损坏|格式/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('connections requires capability but no document root', async () => {
  const f = await fixture();
  try {
    const response = await f.call('/connections', 'GET', undefined, '');
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.data));
    assert.deepEqual(Object.keys(body.data[0]).sort(), ['displayName', 'id', 'installId', 'kind', 'profile', 'state']);
    assert.equal(body.data[0].state, 'ready');
    assert.equal(body.data[0].installId, 'install-1');
    assert.equal(JSON.stringify(body).includes('private-test-value'), false);
    assert.equal((await f.call('/connections', 'GET', undefined, '', 'wrong')).status, 401);
  } finally { await f.close(); }
});

test('Serve cannot be ready or create a Chat when ping or list capability fails', async () => {
  for (const failure of ['pingThrows', 'listThrows'] as const) {
    const f = await fixture();
    try {
      f.fakeGateway[failure] = true;
      const connections = await (await f.call('/connections', 'GET', undefined, '')).json();
      assert.equal(connections.data[0].state, 'incompatible');
      assert.equal(connections.data[0].installId, null);
      const response = await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
      assert.equal(response.status, 503);
      assert.deepEqual(await readChatBindings(f.v2File), {});
      assert.equal(f.fakeGateway.createCalls, 0);
    } finally { await f.close(); }
  }
});

test('read-only probe waits for each RPC result before closing its Gateway', async () => {
  const f = await fixture({ strictProbeClose: true });
  try {
    const response = await f.call('/connections', 'GET', undefined, '');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].state, 'ready');
    assert.equal((await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' })).status, 200);
  } finally { await f.close(); }
});

test('repeated and concurrent chat creation stays pending without upstream creation', async () => {
  const f = await fixture();
  try {
    const body = { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' };
    const created = await f.call('/chats', 'POST', body);
    assert.equal(created.status, 200);
    assert.equal((await created.json()).chat.installId, 'install-1');
    assert.equal((await f.call('/chats', 'POST', body)).status, 200);
    const [a, b] = await Promise.all([
      f.call('/chats', 'POST', { chat_id: 'local-2', connection_id: 'serve-local', title: 'A' }),
      f.call('/chats', 'POST', { chat_id: 'local-3', connection_id: 'serve-local', title: 'B' }),
    ]);
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const rows = await readChatBindings(f.v2File);
    assert.deepEqual(Object.keys(rows).sort(), ['local-1', 'local-2', 'local-3']);
    assert.equal(rows['local-1'].state, 'pending');
    assert.equal(f.fakeGateway.createCalls, 0);
    assert.ok(f.fakeGateway.pingCalls >= 1);
    assert.equal(await readFile(f.legacyFile, 'utf8'), '{}');
  } finally { await f.close(); }
});

test('first stream creates once, confirms user row, and rejects wrong document root', async () => {
  const f = await fixture();
  try {
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    assert.equal((await f.call('/chats/local-1/messages', 'GET', undefined, OTHER_ROOT)).status, 403);
    assert.equal(f.fakeGateway.historyCalls, 0);
    const response = await f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(f.fakeGateway.createCalls, 1);
    assert.equal(f.fakeGateway.submitCalls, 1);
    assert.equal((await readChatBindings(f.v2File))['local-1'].state, 'ready');
    const messages = await (await f.call('/chats/local-1/messages')).json();
    assert.ok(Array.isArray(messages.data));
  } finally { await f.close(); }
});

test('Serve prompt.submit receives both frozen context and the user question', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/chats', 'POST', { chat_id: 'context-local', connection_id: 'serve-local', title: '资料测试' })).status, 200);
    const response = await f.call('/chats/context-local/chat/stream', 'POST', { message: '用户原问题', system_message: '【本轮冻结引用】关键资料正文' });
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(f.fakeGateway.submitCalls, 1);
    assert.match(f.fakeGateway.submittedTexts[0], /关键资料正文/);
    assert.match(f.fakeGateway.submittedTexts[0], /用户原问题/);
  } finally { await f.close(); }
});

test('Gateway text delta reaches the browser before an unknown terminal', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call('/chats', 'POST', { chat_id: 'delta-local', connection_id: 'serve-local', title: '增量测试' })).status, 200);
    f.fakeGateway.submitAccepted = false;
    f.fakeGateway.submitEvent = { type: 'message.delta', payload: { text: '已经收到的半句' } };
    f.fakeGateway.submitResult = { state: 'unknown', text: '' };
    const deltas: string[] = [];
    const client = createBridgeClient({ bridgeUrl: f.base, capabilityToken: CAP }, ROOT);
    const result = await client.streamChatForChat('delta-local', '问题', {}, event => { if (event.delta) deltas.push(event.delta); });
    assert.deepEqual(deltas, ['已经收到的半句']);
    assert.deepEqual(result, { state: 'unknown', text: '已经收到的半句' });
  } finally { await f.close(); }
});

test('real Bridge ChatView response includes kind for creation', async () => {
  const f = await fixture();
  try {
    const body = await (await f.call('/chats', 'POST', { chat_id: 'shape-local', connection_id: 'serve-local', title: '形状' })).json();
    assert.equal(body.chat.kind, 'serve');
    assert.equal(body.chat.installId, 'install-1');
  } finally { await f.close(); }
});

test('changed installation identity and unsupported legacy creation are rejected', async () => {
  const f = await fixture();
  try {
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    f.setInstallId('install-2');
    assert.equal((await f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' })).status, 409);
    assert.equal(f.fakeGateway.createCalls, 0);
    assert.equal((await f.call('/chats', 'POST', { chat_id: 'legacy-1', connection_id: 'legacy-api', title: 'No' })).status, 400);
  } finally { await f.close(); }
});

test('history anchor mismatch blocks the next send without submitting', async () => {
  const f = await fixture();
  try {
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    await (await f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' })).text();
    assert.equal((await f.call('/chats/local-1/messages')).status, 200);
    f.fakeGateway.historyMessages = [{ role: 'user', text: 'altered', row_id: 12 }];
    assert.equal((await f.call('/chats/local-1/chat/stream', 'POST', { message: '再次' })).status, 409);
    assert.equal(f.fakeGateway.submitCalls, 1);
  } finally { await f.close(); }
});

test('queued first turn stays pending and cannot be submitted again', async () => {
  const f = await fixture();
  try {
    f.fakeGateway.submitResult = { state: 'queued', text: '' };
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    const response = await f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /run\.queued/);
    assert.equal((await readChatBindings(f.v2File))['local-1'].state, 'pending');
    assert.equal((await f.call('/chats/local-1/chat/stream', 'POST', { message: '再次' })).status, 409);
    assert.equal(f.fakeGateway.createCalls, 1);
  } finally { await f.close(); }
});

test('unknown reply with a user row checks history once and stays unknown on the wire', async () => {
  const f = await fixture();
  try {
    f.fakeGateway.submitResult = { state:'unknown', text:'部分文字', userRowId:12 };
    f.fakeGateway.historyMessages = [{ role:'user', text:'问题', row_id:12 }];
    await f.call('/chats','POST',{chat_id:'local-1',connection_id:'serve-local',title:'测试'});
    const response=await f.call('/chats/local-1/chat/stream','POST',{message:'问题'});
    const body=await response.text();
    assert.match(body,/event: run\.unknown/);assert.doesNotMatch(body,/event: run\.failed/);
    assert.equal(f.fakeGateway.submitCalls,1);assert.equal(f.fakeGateway.historyCalls,1);
    assert.equal((await readChatBindings(f.v2File))['local-1'].state,'ready');
  } finally { await f.close(); }
});

test('stop during unaccepted submit reports unknown without interrupting', async () => {
  const f = await fixture();let release:()=>void=()=>{};
  try {
    f.fakeGateway.submitAccepted=false;f.fakeGateway.submitWait=new Promise<void>(resolve=>{release=resolve;});
    await f.call('/chats','POST',{chat_id:'local-1',connection_id:'serve-local',title:'测试'});
    const running=f.call('/chats/local-1/chat/stream','POST',{message:'问题'});
    for(let i=0;i<50&&f.fakeGateway.submitCalls===0;i++)await new Promise(resolve=>setTimeout(resolve,2));
    assert.equal(f.fakeGateway.submitCalls,1);
    assert.deepEqual(await (await f.call('/chats/local-1/stop','POST',{})).json(),{state:'unknown'});
    assert.equal(f.fakeGateway.interruptCalls,0);
    release();await (await running).text();
  } finally { release();await f.close(); }
});

test('unresolved creating intent becomes unknown after Bridge restart without upstream call', async () => {
  const f = await fixture();
  try {
    await writeChatBindingsAtomic(f.v2File, { 'local-1': { ...validBinding, chatId: 'local-1', title: '测试', state: 'creating' } });
    assert.equal((await f.call('/chats/local-1')).status, 200);
    assert.equal((await readChatBindings(f.v2File))['local-1'].state, 'unknown');
    assert.equal((await f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' })).status, 409);
    assert.equal(f.fakeGateway.createCalls, 0);
  } finally { await f.close(); }
});

test('same stored session can be bound under different connections and Studio pending is created locally', async () => {
  const f = await fixture();
  try {
    for (const [chatId, connectionId] of [['a', 'serve-local'], ['b', 'serve-other']]) {
      const response = await f.call('/chats/bind', 'POST', { chat_id: chatId, connection_id: connectionId, stored_session_id: 'stored-1', confirm: true });
      assert.equal(response.status, 200);
    }
    const rows = await readChatBindings(f.v2File);
    assert.equal(rows.a.storedSessionId, rows.b.storedSessionId);
    assert.notEqual(rows.a.connectionId, rows.b.connectionId);
    const studio = await f.call('/chats', 'POST', { chat_id: 'studio-1', connection_id: 'studio-default', title: 'Studio' });
    assert.equal(studio.status, 200);
    assert.equal((await readChatBindings(f.v2File))['studio-1'].state, 'pending');
    assert.notEqual(await readFile(f.legacyFile, 'utf8'), '{}');
    assert.equal((await f.call('/chats/studio-1/messages')).status, 200);
  } finally { await f.close(); }
});

test('concurrent same-root binding cannot claim one stored session for two Chat IDs', async () => {
  const f = await fixture();
  try {
    const body = (chat_id: string) => ({ chat_id, connection_id: 'serve-local', stored_session_id: 'stored-1', confirm: true });
    const responses = await Promise.all([f.call('/chats/bind', 'POST', body('first')), f.call('/chats/bind', 'POST', body('second'))]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const rows = await readChatBindings(f.v2File);
    assert.equal(Object.keys(rows).length, 1);
    const winner = Object.keys(rows)[0];
    assert.equal((await f.call('/chats/bind', 'POST', body(winner))).status, 200, 'same Chat ID remains idempotent');
  } finally { await f.close(); }
});

test('connection sessions, deterministic legacy classification, status and idle stop', async () => {
  const f = await fixture();
  try {
    const sessions = await f.call('/connections/serve-local/sessions');
    assert.equal(sessions.status, 200);
    assert.equal((await sessions.json()).data[0].id, 'stored-1');
    assert.equal((await f.call('/chats/bind', 'POST', { chat_id: 'x', connection_id: 'serve-local', stored_session_id: 'stored-1' })).status, 400);
    await f.call('/chats', 'POST', { chat_id: 'studio-1', connection_id: 'studio-default', title: 'Studio' });
    const classified = await f.call('/legacy-bindings');
    assert.equal(classified.status, 200);
    const legacyRows = (await classified.json()).data;
    assert.deepEqual(legacyRows.map((row: any) => row.connectionId), ['studio-default']);
    assert.deepEqual(Object.keys(legacyRows[0]).sort(), ['adapter', 'chatId', 'connectionId', 'documentRootId', 'installId', 'profile', 'storedSessionId']);
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    assert.deepEqual(await (await f.call('/chats/local-1/status')).json(), { chatId: 'local-1', state: 'pending', lastRunState: null });
    assert.deepEqual(await (await f.call('/chats/local-1/stop', 'POST', {})).json(), { state: 'not_running' });
    assert.equal(f.fakeGateway.interruptCalls, 0);
  } finally { await f.close(); }
});

test('status during an active first create keeps creating, rather than treating it as crash residue', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  try {
    f.fakeGateway.createWait = new Promise<void>(resolve => { release = resolve; });
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    const running = f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' });
    for (let i = 0; i < 50 && f.fakeGateway.createCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.fakeGateway.createCalls, 1);
    assert.equal((await (await f.call('/chats/local-1/status')).json()).state, 'creating');
    release();
    await (await running).text();
    assert.equal((await readChatBindings(f.v2File))['local-1'].state, 'ready');
  } finally { release(); await f.close(); }
});

test('stop interrupts only while this Bridge holds an active runtime ticket', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  try {
    f.fakeGateway.submitWait = new Promise<void>(resolve => { release = resolve; });
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    const running = f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' });
    for (let i = 0; i < 50 && f.fakeGateway.submitCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.fakeGateway.submitCalls, 1);
    assert.deepEqual(await (await f.call('/chats/local-1/stop', 'POST', {})).json(), { state: 'interrupted' });
    assert.equal(f.fakeGateway.interruptCalls, 1);
    release();
    await (await running).text();
    assert.deepEqual(await (await f.call('/chats/local-1/stop', 'POST', {})).json(), { state: 'not_running' });
    assert.equal(f.fakeGateway.interruptCalls, 1);
  } finally { release(); await f.close(); }
});

test('bind rejects a session claimed by another root, but accepts a retained colon Chat ID', async () => {
  const f = await fixture();
  try {
    const oldId = `siyuan:${ROOT}:20260923123456-1`;
    const first = await f.call('/chats/bind', 'POST', { chat_id: oldId, connection_id: 'serve-local', stored_session_id: 'stored-1', confirm: true });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).chat.installId, 'install-1');
    assert.equal((await f.call('/chats/bind', 'POST', { chat_id: 'other', connection_id: 'serve-local', stored_session_id: 'stored-1', confirm: true }, OTHER_ROOT)).status, 409);
    for (const bad of ['bad/slash', 'bad\nline', '']) {
      assert.equal((await f.call('/chats/bind', 'POST', { chat_id: bad, connection_id: 'serve-local', stored_session_id: 'stored-1', confirm: true })).status, 400);
    }
  } finally { await f.close(); }
});

test('Studio old binding claimed by another root is rejected before any v2 or old write', async () => {
  const f = await fixture();
  try {
    const previous = { [`${ROOT}:existing-studio`]: { id: 'existing-studio', title: 'Existing', documentRootId: ROOT, source: 'studio', profile: 'default' } };
    await writeFile(f.legacyFile, JSON.stringify(previous));
    const response = await f.call('/chats/bind', 'POST', { chat_id: 'local-1', connection_id: 'studio-default', stored_session_id: 'existing-studio', confirm: true }, OTHER_ROOT);
    assert.equal(response.status, 409);
    assert.deepEqual(JSON.parse(await readFile(f.legacyFile, 'utf8')), previous);
    assert.deepEqual(await readChatBindings(f.v2File), {});
  } finally { await f.close(); }
});

test('concurrent Studio pending chats keep both old bindings', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all(['studio-a', 'studio-b'].map(chat_id => f.call('/chats', 'POST', { chat_id, connection_id: 'studio-default', title: chat_id })));
    assert.deepEqual(responses.map(response => response.status), [200, 200]);
    assert.equal(Object.keys(JSON.parse(await readFile(f.legacyFile, 'utf8'))).length, 2);
  } finally { await f.close(); }
});

test('new route does not expose private filesystem paths on I/O failure', async () => {
  const f = await fixture();
  try {
    await mkdir(f.v2File);
    const response = await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.equal(body.includes(f.v2File), false);
    assert.equal(body.includes('private-test-value'), false);
  } finally { await f.close(); }
});

test('new route never echoes a forged safe code with an upstream secret message', async () => {
  const f = await fixture();
  try {
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    await (await f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' })).text();
    f.fakeGateway.historyError = Object.assign(new Error('PRIVATE_VALUE C:\\secret\\file'), { code: 'session_not_found', status: 404 });
    const response = await f.call('/chats/local-1/messages');
    assert.equal(response.status, 404);
    const body = await response.text();
    assert.equal(body.includes('PRIVATE_VALUE'), false);
    assert.equal(body.includes('secret\\file'), false);
  } finally { await f.close(); }
});

test('old and new Studio create routes share one legacy binding transaction', async () => {
  const f = await fixture();
  try {
    const responses = await Promise.all([
      f.call('/sessions', 'POST', { title: '旧一' }),
      f.call('/sessions', 'POST', { title: '旧二' }),
      f.call('/chats', 'POST', { chat_id: 'new-a', connection_id: 'studio-default', title: '新一' }),
      f.call('/chats', 'POST', { chat_id: 'new-b', connection_id: 'studio-default', title: '新二' }),
    ]);
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200, 200]);
    assert.equal(Object.keys(JSON.parse(await readFile(f.legacyFile, 'utf8'))).length, 4);
  } finally { await f.close(); }
});

test('legacy Studio finalize preserves a new Studio binding written during the run', async () => {
  let release: () => void = () => {};
  let entered = false;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ studioRun: async () => { entered = true; await wait; return { content: '完成' }; } });
  try {
    const key = `${ROOT}:old-simple`;
    await writeFile(f.legacyFile, JSON.stringify({ [key]: { id: 'old-simple', title: '旧', documentRootId: ROOT, source: 'studio', profile: 'default', pending: true } }));
    const running = f.call('/sessions/old-simple/chat', 'POST', { message: '问题' });
    for (let i = 0; i < 50 && !entered; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(entered, true);
    assert.equal((await f.call('/chats', 'POST', { chat_id: 'new-studio', connection_id: 'studio-default', title: '新' })).status, 200);
    release();
    assert.equal((await running).status, 200);
    const rows = JSON.parse(await readFile(f.legacyFile, 'utf8'));
    assert.equal(Object.keys(rows).length, 2);
    assert.equal(rows[key].pending, false);
  } finally { release(); await f.close(); }
});

test('legacy Studio bind and new Studio create preserve both records concurrently', async () => {
  const f = await fixture({ studioCandidate: 'desktop-1' });
  try {
    const [bound, created] = await Promise.all([
      f.call('/studio/bind', 'POST', { session_id: 'desktop-1' }),
      f.call('/chats', 'POST', { chat_id: 'new-studio', connection_id: 'studio-default', title: '新' }),
    ]);
    assert.deepEqual([bound.status, created.status], [200, 200]);
    const rows = JSON.parse(await readFile(f.legacyFile, 'utf8'));
    assert.equal(Object.keys(rows).length, 2);
    assert.ok(rows[`${ROOT}:desktop-1`]);
  } finally { await f.close(); }
});

test('POST /chats rejects a retained colon ID for a different document root', async () => {
  const f = await fixture();
  try {
    const chat_id = `siyuan:${OTHER_ROOT}:20260923123456-1`;
    assert.equal((await f.call('/chats', 'POST', { chat_id, connection_id: 'serve-local', title: '错误归属' }, ROOT)).status, 400);
    assert.deepEqual(await readChatBindings(f.v2File), {});
  } finally { await f.close(); }
});

test('stop does not interrupt before prompt acceptance is proven', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  try {
    f.fakeGateway.submitAccepted = false;
    f.fakeGateway.submitWait = new Promise<void>(resolve => { release = resolve; });
    await f.call('/chats', 'POST', { chat_id: 'local-1', connection_id: 'serve-local', title: '测试' });
    const running = f.call('/chats/local-1/chat/stream', 'POST', { message: '问题' });
    for (let i = 0; i < 50 && f.fakeGateway.submitCalls === 0; i++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(f.fakeGateway.submitCalls, 1);
    assert.deepEqual(await (await f.call('/chats/local-1/stop', 'POST', {})).json(), { state: 'unknown' });
    assert.equal(f.fakeGateway.interruptCalls, 0);
    release();
    await (await running).text();
  } finally { release(); await f.close(); }
});

for (const scenario of ['run', 'rename']) {
  test(`Studio ${scenario} uncertainty persists unknown and blocks automatic replay`, async () => {
    let calls = 0;
    const f = await fixture({ studioRun: async () => { calls++; if (scenario === 'run') throw new Error('uncertain'); return {}; }, failStudioRename: scenario === 'rename' });
    try {
      await f.call('/chats', 'POST', { chat_id: 'studio-1', connection_id: 'studio-default', title: 'Studio' });
      const first = await f.call('/chats/studio-1/chat/stream', 'POST', { message: '问题' });
      assert.equal(first.status, 200);
      assert.match(await first.text(), /run\.unknown/);
      assert.equal((await readChatBindings(f.v2File))['studio-1'].state, 'unknown');
      assert.equal((await f.call('/chats/studio-1/chat/stream', 'POST', { message: '重试' })).status, 409);
      assert.equal(calls, 1);
    } finally { await f.close(); }
  });
}

test('Studio rename failure cannot expose an earlier run.completed as final success', async()=>{
  const f=await fixture({studioRun:async({onEvent}:any)=>{onEvent('run.started',{});onEvent('run.completed',{text:'答复'});return {content:'答复'};},failStudioRename:true});
  try{
    await f.call('/chats','POST',{chat_id:'studio-1',connection_id:'studio-default',title:'Studio'});
    const stream=await (await f.call('/chats/studio-1/chat/stream','POST',{message:'问题'})).text();
    assert.match(stream,/event: run\.unknown/);assert.doesNotMatch(stream,/event: run\.completed/);
    assert.equal((await readChatBindings(f.v2File))['studio-1'].state,'unknown');
  }finally{await f.close();}
});
