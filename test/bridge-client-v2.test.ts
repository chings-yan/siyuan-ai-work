import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { HermesBridgeClient, createBridgeClient, BridgeError, readThreadMessages } from '../src/bridge.ts';

const ROOT = '20260923123456-abcdefg';
const CAP = 'c'.repeat(64);

async function mockBridge() {
  const seen: Array<{ path: string; token: string | undefined; root: string | undefined; body: any }> = [];
  let frames = ['event: run.queued\ndata: {}\n\n'];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ path: req.url || '', token: req.headers['x-siyuan-collab-token'] as string | undefined, root: req.headers['x-siyuan-document-root'] as string | undefined, body: raw ? JSON.parse(raw) : null });
    if (req.url === '/connections') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'serve-local', kind: 'serve', displayName: 'Hermes Serve', state: 'ready', profile: 'default', installId: 'install-1' }] })); return; }
    if (req.url === '/connections/serve-local/sessions') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'stored-1', title: 'A' }] })); return; }
    if (req.url === '/legacy-bindings') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [] })); return; }
    if (req.url === '/chats' || req.url === '/chats/bind') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ chat: { chatId: 'local-1', connectionId: 'serve-local', kind: 'serve', profile: 'default', documentRootId: ROOT, title: 'A', state: 'pending', storedSessionId: null, installId: 'install-1' } })); return; }
    if (req.url === '/chats/local-1/messages') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'row-1', role: 'user', content: '问' }] })); return; }
    if (req.url === '/chats/local-1/stop') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ state: 'not_running' })); return; }
    if (req.url === '/chats/local-1/chat/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const frame of frames) {
        const bytes = Buffer.from(frame);
        for (let i = 0; i < bytes.length; i += 2) res.write(bytes.subarray(i, i + 2));
      }
      res.end(); return;
    }
    res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'install_mismatch', message: '安全提示' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return { url: `http://127.0.0.1:${address.port}`, seen, setFrames: (value: string[]) => { frames = value; }, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('neutral routes attach token and scope correctly and preserve typed chat identity', async () => {
  const mock = await mockBridge();
  try {
    const noRoot = new HermesBridgeClient({ bridgeUrl: mock.url, capabilityToken: CAP });
    assert.equal((await noRoot.listConnections()).data[0].installId, 'install-1');
    await assert.rejects(noRoot.messagesForChat('local-1'), /思源文档/);
    const client = createBridgeClient({ bridgeUrl: mock.url, capabilityToken: CAP }, ROOT);
    assert.equal((await client.listCandidates('serve-local')).data[0].id, 'stored-1');
    assert.deepEqual(await client.legacyBindings(), { data: [] });
    assert.equal((await client.createChat('local-1', 'serve-local', 'A')).chat.installId, 'install-1');
    assert.equal((await client.bindChat('local-1', 'serve-local', 'stored-1', 'A')).chat.storedSessionId, null);
    assert.equal((await client.messagesForChat('local-1')).data[0].content, '问');
    assert.deepEqual(await client.stopChat('local-1'), { state: 'not_running' });
    assert.equal(mock.seen[0].root, undefined);
    assert.ok(mock.seen.every(x => x.token === CAP));
    assert.ok(mock.seen.slice(1).every(x => x.root === ROOT));
    assert.equal(mock.seen.find(x => x.path === '/chats/bind')?.body.confirm, true);
  } finally { await mock.close(); }
});

test('queued, unknown and broken stream never become complete; UTF-8 deltas survive byte splits', async () => {
  const mock = await mockBridge();
  try {
    const client = createBridgeClient({ bridgeUrl: mock.url, capabilityToken: CAP }, ROOT);
    assert.deepEqual(await client.streamChatForChat('local-1', '问', {}, () => {}), { state: 'queued', text: '' });
    const seen: string[] = []; const started: unknown[] = [];
    mock.setFrames(['event: run.started\ndata: {"userRowId":12}\n\n', 'event: message.delta\ndata: {"delta":"你好🌍"}\n\n', 'event: run.unknown\ndata: {}\n\n']);
    assert.deepEqual(await client.streamChatForChat('local-1', '问', {}, x => { if (x.delta) seen.push(x.delta); if (x.event === 'run.started') started.push(x.raw); }), { state: 'unknown', text: '你好🌍' });
    assert.deepEqual(seen, ['你好🌍']);
    assert.deepEqual(started, [{ userRowId: 12 }]);
    mock.setFrames(['event: message.delta\ndata: {"text":"旧形状增量"}\n\n', 'event: run.unknown\ndata: {}\n\n']);
    assert.deepEqual(await client.streamChatForChat('local-1', '问', {}, () => {}), { state: 'unknown', text: '旧形状增量' });
    mock.setFrames(['event: message.delta\ndata: {"delta":"半句"}\n\n']);
    assert.deepEqual(await client.streamChatForChat('local-1', '问', {}, () => {}), { state: 'unknown', text: '半句' });
    mock.setFrames(['event: run.completed\ndata: {"text":"完成"}\n\n']);
    assert.deepEqual(await client.streamChatForChat('local-1', '问', {}, () => {}), { state: 'complete', text: '完成' });
    mock.setFrames(['event: run.interrupted\ndata: {}\n\n']);
    assert.deepEqual(await client.streamChatForChat('local-1', '问', {}, () => {}), { state: 'interrupted', text: '' });
    mock.setFrames(['event: run.completed\ndata: {"state":"failed","text":"不可当成功"}\n\n']);
    assert.deepEqual(await client.streamChatForChat('local-1', '问', {}, () => {}), { state: 'unknown', text: '不可当成功' });
  } finally { await mock.close(); }
});

test('explicit new-route errors retain code without leaking upstream body as success', async () => {
  const mock = await mockBridge();
  try {
    const client = createBridgeClient({ bridgeUrl: mock.url, capabilityToken: CAP }, ROOT);
    await assert.rejects(client.messagesForChat('missing'), (error: unknown) => error instanceof BridgeError && error.code === 'install_mismatch');
  } finally { await mock.close(); }
});

test('history uses original Bridge and stored ID for confirmed legacy chats, local ID for neutral chats', async () => {
  const oldFetch = globalThis.fetch;
  const requests: Array<{ url: string; root: string | undefined }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), root: (init?.headers as Record<string, string>)['X-Siyuan-Document-Root'] });
    return new Response(JSON.stringify({ data: [{ id: 'row-1', role: 'user', content: '历史' }] }), { status: 200 });
  };
  try {
    const config = { bridgeUrl: 'http://127.0.0.1:8785', capabilityToken: CAP };
    const oldThread = { id: 'local-old', documentRootId: ROOT, adapter: 'studio' as const, state: 'ready' as const, connectionId: 'studio-default', legacyBridgeUrl: 'http://127.0.0.1:8784', storedSessionId: 'stored-old' };
    const newThread = { id: 'local-new', documentRootId: ROOT, adapter: 'serve' as const, state: 'pending' as const, connectionId: 'serve-local', storedSessionId: undefined };
    assert.equal((await readThreadMessages(oldThread, config))?.data[0].content, '历史');
    assert.equal((await readThreadMessages(newThread, config))?.data[0].content, '历史');
    assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/sessions/stored-old/messages', '/chats/local-new/messages']);
    assert.deepEqual(requests.map(x => new URL(x.url).origin), ['http://127.0.0.1:8784', 'http://127.0.0.1:8785']);
    assert.deepEqual(requests.map(x => x.root), [ROOT, ROOT]);
    assert.equal(await readThreadMessages({ ...oldThread, adapter: 'unresolved', state: 'source-unknown' }, config), null);
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = oldFetch; }
});
