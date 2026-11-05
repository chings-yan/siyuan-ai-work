import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, HermesBridgeClient, createBridgeClient, syncDocumentSessions } from '../src/bridge.ts';
import { chatSession, streamChatSession } from '../src/provider.ts';

const ROOT = '20260826094850-kronins';
const TOKEN = 'token';
const snapshot = { documentId: ROOT, title: 't', focusBlockId: 'b', selection: '', nearby: [], recent: [], contextText: '', createdAt: 'now', degraded: true } as any;

function jsonResponse(data: unknown) { return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } }); }

async function captureRequests(run: () => Promise<unknown>) {
  const original = globalThis.fetch;
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/chat/stream')) {
      return new Response('data: {"delta":"ok"}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (String(url).endsWith('/sessions')) return jsonResponse({ data: [], session: { id: 'created', title: 'created' } });
    if (String(url).includes('/messages')) return jsonResponse({ data: [] });
    if (String(url).includes('/chat')) return jsonResponse({ message: { role: 'assistant', content: 'ok' } });
    return jsonResponse({ ok: true, service: 'bridge' });
  };
  try { await run(); } finally { globalThis.fetch = original; }
  return requests;
}

function assertScoped(requests: { init?: RequestInit }[]) {
  assert.ok(requests.length > 0);
  for (const request of requests) {
    const headers = request.init?.headers as Record<string, string>;
    assert.equal(headers['X-Siyuan-Collab-Token'], TOKEN);
    assert.equal(headers['X-Siyuan-Document-Root'], ROOT);
  }
}

test('plugin sync, load, and create paths use one document-scoped client', async () => {
  const client = createBridgeClient({ bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: TOKEN }, ROOT);
  const requests = await captureRequests(async () => {
    await client.listSessions();
    await client.messages('session');
    await client.createSession('new');
  });
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/sessions', '/sessions/session/messages', '/sessions']);
  assertScoped(requests);
});

test('legacy chat and v2 stream provider paths send document scope header', async () => {
  const requests = await captureRequests(async () => {
    await chatSession('session', 'q', snapshot, { bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: TOKEN });
    await streamChatSession('session', 'q', snapshot, { bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: TOKEN }, () => undefined);
  });
  assert.deepEqual(requests.map(x => new URL(x.url).pathname), ['/sessions/session/chat', '/chats/session/chat/stream']);
  assertScoped(requests);
});

test('every Hermes bridge client operation sends document scope header', async () => {
  const client = new HermesBridgeClient({ bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: TOKEN, documentRootId: ROOT });
  const requests = await captureRequests(async () => {
    await client.listSessions(); await client.messages('s'); await client.createSession('t'); await client.chat('s', 'q');
    await assert.rejects(client.streamChat('s', 'q'), (error: unknown) => error instanceof BridgeError && error.code === 'chat_result_unknown');
  });
  assertScoped(requests);
});

test('Chinese placeholder document roots fail closed before Chromium constructs headers', async () => {
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (_url, init) => {
    fetchCalls++;
    new Headers(init?.headers);
    return jsonResponse({ data: [] });
  };
  try {
    const client = new HermesBridgeClient({ bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: TOKEN, documentRootId: '未识别文档' });
    await assert.rejects(() => client.listSessions(), (error: unknown) => error instanceof BridgeError && error.code === 'invalid_document_root' && /思源文档/.test(error.message));
    await assert.rejects(() => client.streamChat('session', 'q'), (error: unknown) => error instanceof BridgeError && error.code === 'invalid_document_root');
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = original; }
});

test('health remains available without a valid document root and sync is health-only', async () => {
  const requests = await captureRequests(async () => {
    const result = await syncDocumentSessions({ bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: TOKEN }, '未识别文档');
    assert.deepEqual(result, { data: [], documentScoped: false });
  });
  assert.deepEqual(requests.map(request => new URL(request.url).pathname), ['/health']);
  const headers = requests[0].init?.headers as Record<string, string>;
  assert.equal(headers['X-Siyuan-Collab-Token'], undefined);
  assert.equal(headers['X-Siyuan-Document-Root'], undefined);
});

test('all outgoing header values reject non-ByteString and CRLF content before fetch', async () => {
  const original = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return jsonResponse({ data: [] }); };
  try {
    for (const capabilityToken of ['中文密钥', 'safe\r\nInjected: yes']) {
      const client = new HermesBridgeClient({ bridgeUrl: 'http://127.0.0.1:8782', capabilityToken, documentRootId: ROOT });
      await assert.rejects(() => client.listSessions(), (error: unknown) => error instanceof BridgeError && error.code === 'invalid_header_value');
    }
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = original; }
});
