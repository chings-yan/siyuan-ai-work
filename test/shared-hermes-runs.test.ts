import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
// @ts-expect-error runtime ESM
import { createSessionRunCoordinator } from '../scripts/hermes-session-runs.mjs';
// @ts-expect-error runtime ESM
import { createBridgeServer } from '../scripts/bridge.mjs';
// @ts-expect-error runtime ESM
import { runStudioSocket } from '../scripts/studio-client.mjs';

const ROOT = '20260923123456-abcdefg';
const OTHER = '20260923123457-abcdefg';
const CAP = 'c'.repeat(64);
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
async function fixture(kind = 'studio', configure?: (options: any) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'shared-runs-'));
  const legacy = join(dir, 'legacy.json'), v2 = join(dir, 'v2.json'), tokenFile = join(dir, 'token');
  await writeFile(tokenFile, 'synthetic-token');
  const row = (chatId: string, root: string, connectionId = kind === 'studio' ? 'studio-default' : 'serve-one') => ({ chatId, documentRootId: root, connectionId, kind, profile: 'default', title: 'Synthetic', state: 'ready', storedSessionId: 'stored-1', installId: kind === 'serve' ? 'install-1' : null, anchor: null });
  await writeFile(v2, JSON.stringify({ a: row('a', ROOT), b: row('b', OTHER), c: row('c', OTHER, kind === 'serve' ? 'serve-two' : 'studio-default') }));
  await writeFile(legacy, JSON.stringify(kind === 'studio' ? { [`${ROOT}:stored-1`]: { id: 'stored-1', documentRootId: ROOT, title: 'Synthetic', source: 'studio', profile: 'default', pending: false } } : {}));
  const entered = deferred(), gate = deferred(), aborted = deferred(), historyEntered = deferred(), historyGate = deferred();
  let turnGate = gate;
  const events: Array<(event: unknown) => void> = [];
  const state = { calls: 0, interrupts: 0, hold: true, outcome: 'complete', renameFails: false, failRun: false, terminalFailure: false, holdHistory: false };
  const options = { capability: CAP, bindingsFile: legacy, bindingsV2File: v2, studioToken: 'synthetic',
    connections: { defaultConnectionId: 'studio-default', connections: [
      { id: 'studio-default', kind: 'studio', profile: 'default' },
      ...['serve-one','serve-two'].map(id => ({ id, kind: 'serve', profile: 'default', baseUrl: 'http://127.0.0.1:9199/', tokenFile })) ] },
    fetchImpl: async (url: any) => new Response(JSON.stringify(String(url).includes('/api/status') ? { install_id: 'install-1' } : { sessions: [{ id: 'stored-1', title: 'Synthetic', profile: 'default' }], messages: [{ id: 12, role: 'user', content: 'question' }], hasMore: false }), { status: state.renameFails && String(url).includes('/rename') ? 503 : 200 }),
    studioRun: async ({ onEvent, signal }: any) => { signal?.addEventListener('abort', () => aborted.resolve(), { once: true }); state.calls++; if (state.calls > 1) gate.resolve(); onEvent?.('run.started', {}); entered.resolve(); if (state.hold) await turnGate.promise; if (state.terminalFailure) { onEvent?.('run.failed', { error: 'synthetic rejection' }); throw new Error('synthetic rejection'); } if (state.failRun) throw new Error('synthetic lost connection'); onEvent?.('run.completed', { content: 'answer' }); return { content: 'answer' }; },
    gatewayFactory: () => ({ ping: async () => ({ ok: true }), list: async () => ({ sessions: [] }), history: async () => { if (state.holdHistory && state.calls > 0) { historyEntered.resolve(); await historyGate.promise; } return { messages: [{ row_id: 12, role: 'user', text: 'question' }] }; }, resume: async () => 'live-1',
      submit: async (_id: any, _text: any, { onAccepted, onEvent, signal }: any) => { events.push(onEvent); signal?.addEventListener('abort', () => aborted.resolve(), { once: true }); state.calls++; onAccepted?.({ status: 'streaming', userRowId: 12 }); entered.resolve(); if (state.hold) await turnGate.promise; return { state: state.outcome, text: 'answer', userRowId: 12 }; },
      interrupt: async () => { state.interrupts++; return { status: 'interrupted' }; }, close() {} }) };
  let server: any, base = '';
  const start = async () => { ({ server } = createBridgeServer(options)); await new Promise<void>(yes => server.listen(0, '127.0.0.1', yes)); base = `http://127.0.0.1:${server.address().port}`; };
  const stop = async () => { await new Promise<void>(yes => server.close(() => yes())); };
  configure?.(options);
  await start();
  return { legacy, v2, state, gate, entered, aborted, historyEntered, historyGate, row, options, events, nextTurn: () => { turnGate = deferred(); return turnGate; },
    call: (path: string, root = ROOT, body?: unknown, signal?: AbortSignal) => fetch(`${base}${path}`, { signal, method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Siyuan-Collab-Token': CAP, 'X-Siyuan-Document-Root': root }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    restart: async () => { await stop(); await start(); },
    close: async () => { gate.resolve(); turnGate.resolve(); historyGate.resolve(); await stop(); await rm(dir, { recursive: true, force: true }); } };
}

// Removing any route's shared admission must allow a second upstream business call and fail these races.
for (const first of ['/chats/a/chat/stream', '/sessions/stored-1/chat', '/sessions/stored-1/chat/stream']) {
  test(`shared Studio barrier: ${first} excludes every other entry`, async () => {
    const f = await fixture();
    try {
      const running = f.call(first, ROOT, { message: 'question' });
      await f.entered.promise;
      for (const path of ['/chats/b/chat/stream', '/sessions/stored-1/chat', '/sessions/stored-1/chat/stream']) {
        const response = await f.call(path, path.startsWith('/chats/b') ? OTHER : ROOT, { message: 'second' });
        // Release on regression so the fixture reports an assertion instead of hanging.
        if (response.status === 200) f.gate.resolve();
        assert.equal(response.status, 409);
        assert.equal((await response.json()).error.code, 'session_busy');
      }
      assert.equal(f.state.calls, 1);
      f.gate.resolve(); await (await running).text();
      assert.equal((await f.call('/chats/b/chat/stream', OTHER, { message: 'after completion' })).status, 200);
    } finally { await f.close(); }
  });
}

for (const outcome of ['queued', 'unknown']) test(`Serve ${outcome} survives reads and restart, even when user row exists`, async () => {
  const f = await fixture('serve');
  try {
    f.state.hold = false; f.state.outcome = outcome;
    await (await f.call('/chats/a/chat/stream', ROOT, { message: 'question' })).text();
    await (await f.call('/chats/a/messages')).text();
    await f.restart();
    const response = await f.call('/chats/b/chat/stream', OTHER, { message: 'second' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, outcome === 'queued' ? 'session_busy' : 'session_result_unknown');
    assert.equal(f.state.calls, 1);
    await (await f.call('/chats/a/stop', ROOT, { runId: 'stale' })).text();
    assert.equal(f.state.interrupts, 0);
    const status = await (await f.call('/chats/b/status', OTHER)).json();
    assert.equal(status.run.state, outcome);
    assert.equal(status.run.isOwner, false);
    assert.equal(JSON.stringify(status).includes(ROOT), false);
    assert.equal(JSON.stringify(status).includes('attemptId'), false);
    assert.equal((await f.call('/chats/c/chat/stream', OTHER, { message: 'other connection' })).status, 200);
    assert.equal(f.state.calls, 2);
  } finally { await f.close(); }
});

test('stop needs the current accepted owner ticket and never interrupts from another Chat', async () => {
  const f = await fixture('serve');
  try {
    const responsePromise = f.call('/chats/a/chat/stream', ROOT, { message: 'question' });
    await f.entered.promise;
    const response = await responsePromise;
    const reader = response.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    const start = JSON.parse(chunk.split('data: ')[1].split('\n')[0]);
    assert.equal(typeof start.runId, 'string');
    for (const [chat, root, runId] of [['a',ROOT,undefined],['a',ROOT,'stale'],['b',OTHER,start.runId]]) {
      await (await f.call(`/chats/${chat}/stop`, root, { runId })).text();
      assert.equal(f.state.interrupts, 0);
    }
    assert.equal((await (await f.call('/chats/a/stop', ROOT, { runId: start.runId })).json()).state, 'interrupted');
    assert.equal(f.state.interrupts, 1);
    f.gate.resolve(); while (!(await reader.read()).done) {}
    await (await f.call('/chats/a/stop', ROOT, { runId: start.runId })).text();
    assert.equal(f.state.interrupts, 1);
  } finally { await f.close(); }
});

for (const store of ['v2', 'legacy'] as const) test(`malformed ${store} run fails closed before upstream send`, async () => {
  const f = await fixture();
  try {
    f.state.hold = false;
    const rows = JSON.parse(await readFile(f[store], 'utf8'));
    rows[Object.keys(rows)[0]].run = { schemaVersion: 1, phase: 'completed' };
    await writeFile(f[store], JSON.stringify(rows));
    const response = await f.call('/chats/b/chat/stream', OTHER, { message: 'question' });
    assert.equal(response.status, 500);
    assert.equal(f.state.calls, 0);
    assert.deepEqual(JSON.parse(await readFile(f[store], 'utf8')), rows);
  } finally { await f.close(); }
});

for (const route of ['/sessions/stored-1/chat', '/sessions/stored-1/chat/stream']) test(`${route} unknown is preserved by rebinding and restart`, async () => {
  const f = await fixture();
  try {
    f.state.hold = false; f.state.failRun = true;
    await (await f.call(route, ROOT, { message: 'question' })).text();
    await (await f.call('/studio/bind', ROOT, { session_id: 'stored-1' })).text();
    await f.restart();
    const second = await f.call('/chats/b/chat/stream', OTHER, { message: 'second' });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error.code, 'session_result_unknown');
    assert.equal(f.state.calls, 1);
  } finally { await f.close(); }
});

test('legacy ambiguous queued state blocks a matching V2 identity without fabricating run', async () => {
  const f = await fixture();
  try {
    f.state.hold = false;
    const rows = JSON.parse(await readFile(f.legacy, 'utf8'));
    rows[`${ROOT}:stored-1`].lastRunState = 'queued';
    await writeFile(f.legacy, JSON.stringify(rows));
    assert.equal((await f.call('/chats/b/chat/stream', OTHER, { message: 'question' })).status, 409);
    assert.equal(f.state.calls, 0);
    assert.deepEqual(JSON.parse(await readFile(f.legacy, 'utf8')), rows);
  } finally { await f.close(); }
});

test('unrecognized Serve result cannot count as verified terminal failure', async () => {
  const f = await fixture('serve');
  try {
    f.state.hold = false; f.state.outcome = 'unexpected';
    const stream = await (await f.call('/chats/a/chat/stream', ROOT, { message: 'question' })).text();
    assert.match(stream, /event: run\.unknown/);
    assert.equal((await f.call('/chats/b/chat/stream', OTHER, { message: 'second' })).status, 409);
    assert.equal(f.state.calls, 1);
  } finally { await f.close(); }
});

for (const path of ['/sessions/stored-1/chat/stream', '/chats/a/chat/stream']) test(`${path} cannot expose completed before pending rename succeeds`, async () => {
  const f = await fixture();
  try {
    f.state.hold = false; f.state.renameFails = true;
    const rows = JSON.parse(await readFile(f.legacy, 'utf8'));
    rows[`${ROOT}:stored-1`].pending = true;
    await writeFile(f.legacy, JSON.stringify(rows));
    const stream = await (await f.call(path, ROOT, { message: 'question' })).text();
    assert.match(stream, /event: run\.unknown/);
    assert.doesNotMatch(stream, /event: run\.completed/);
    assert.equal((await f.call('/chats/b/chat/stream', OTHER, { message: 'second' })).status, 409);
    assert.equal(JSON.parse(await readFile(f.legacy, 'utf8'))[`${ROOT}:stored-1`].pending, true);
  } finally { await f.close(); }
});

for (const scenario of ['missing', 'ambiguous', 'source']) test(`legacy ${scenario} identity refuses sends without altering its binding`, async () => {
  const f = await fixture();
  try {
    f.state.hold = false;
    if (scenario === 'missing') f.options.connections.connections.splice(0, 1);
    if (scenario === 'ambiguous') f.options.connections.connections.push({ id: 'studio-other', kind: 'studio', profile: 'default' });
    if (scenario === 'source') {
      const rows = JSON.parse(await readFile(f.legacy, 'utf8')); rows[`${ROOT}:stored-1`].source = 'api_server';
      await writeFile(f.legacy, JSON.stringify(rows));
    }
    const before = await readFile(f.legacy, 'utf8');
    const response = await f.call('/sessions/stored-1/chat', ROOT, { message: 'question' });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'session_identity_unknown');
    assert.equal(f.state.calls, 0);
    assert.equal(await readFile(f.legacy, 'utf8'), before);
  } finally { await f.close(); }
});

test('verified Studio failure ends its barrier while keeping unrelated bindings unchanged', async () => {
  const f = await fixture();
  try {
    f.state.hold = false; f.state.terminalFailure = true;
    const before = await readFile(f.v2, 'utf8');
    const stream = await (await f.call('/sessions/stored-1/chat/stream', ROOT, { message: 'question' })).text();
    assert.match(stream, /event: run\.failed/);
    assert.match(stream, /\"error\":\"synthetic rejection\"/);
    assert.ok(stream.indexOf('event: run.started') < stream.indexOf('event: run.failed'));
    assert.equal(await readFile(f.v2, 'utf8'), before);
    assert.equal(JSON.parse(await readFile(f.legacy, 'utf8'))[`${ROOT}:stored-1`].run.phase, 'failed');
    f.state.terminalFailure = false;
    assert.equal((await f.call('/chats/b/chat/stream', OTHER, { message: 'after rejection' })).status, 200);
  } finally { await f.close(); }
});

test('plain pending Studio binding sends once and retains original source and unrelated fields', async () => {
  const f = await fixture();
  try {
    f.state.hold = false;
    const rows = JSON.parse(await readFile(f.legacy, 'utf8'));
    rows[`${ROOT}:stored-1`].pending = true; rows[`${ROOT}:stored-1`].custom = { marker: 'retain' };
    await writeFile(f.legacy, JSON.stringify(rows));
    const response = await f.call('/sessions/stored-1/chat', ROOT, { message: 'question' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { session_id: 'stored-1', message: { role: 'assistant', content: 'answer' } });
    const row = JSON.parse(await readFile(f.legacy, 'utf8'))[`${ROOT}:stored-1`];
    assert.equal(row.pending, false); assert.equal(row.source, 'studio'); assert.deepEqual(row.custom, { marker: 'retain' });
    assert.equal(row.run.phase, 'completed'); assert.equal(f.state.calls, 1);
  } finally { await f.close(); }
});

// File writes are real except this narrowly injected OS rename error; reads and the surviving barrier remain real.
for (const stage of ['intent', 'completed']) test(`${stage} persistence failure prevents send or preserves unknown without success`, async t => {
  const f = await fixture();
  const rename = fsPromises.rename;
  try {
    f.state.hold = false;
    t.mock.method(fsPromises, 'rename', async (from: any, to: any) => {
      if (to === f.v2) {
        const rows = JSON.parse(await readFile(from, 'utf8'));
        if (rows.a.run?.phase === stage) throw Object.assign(new Error('synthetic rename denied'), { code: 'EACCES' });
      }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    const response = await f.call('/chats/a/chat/stream', ROOT, { message: 'question' });
    const body = await response.text();
    if (stage === 'intent') {
      assert.equal(response.status, 500); assert.equal(f.state.calls, 0);
      assert.equal(Object.hasOwn(JSON.parse(await readFile(f.v2, 'utf8')).a, 'run'), false);
    } else {
      assert.doesNotMatch(body, /event: run\.completed/); assert.match(body, /event: run\.unknown/);
      assert.equal(f.state.calls, 1);
      assert.equal(JSON.parse(await readFile(f.v2, 'utf8')).a.run.phase, 'unknown');
      assert.equal((await f.call('/chats/b/chat/stream', OTHER, { message: 'second' })).status, 409);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});

test('coordinator release and stale transitions cannot clear a new owner or restart barrier', async () => {
  const f = await fixture('serve');
  try {
    const paths = { bindingsV2File: f.v2, bindingsFile: f.legacy };
    const runs = createSessionRunCoordinator(paths);
    const identity = { connectionId: 'serve-one', kind: 'serve', profile: 'default', storedSessionId: 'stored-1', installId: 'install-1' };
    const a = { kind: 'v2', chatId: 'a', documentRootId: ROOT }, b = { kind: 'v2', chatId: 'b', documentRootId: OTHER };
    const first = await runs.begin(a, identity);
    await runs.transition(first, 'streaming');
    await assert.rejects(() => runs.transition(first, 'completed'), /证据/);
    await runs.transition(first, 'completed', { source: 'serve', terminal: 'completed', verified: true });
    runs.release(first);
    const second = await runs.begin(b, identity);
    await runs.transition(second, 'streaming');
    assert.equal(await runs.transition(first, 'unknown'), false);
    assert.equal(await runs.transition({ ...second }, 'completed', { source: 'serve', terminal: 'completed', verified: true }), false);
    assert.deepEqual(await runs.inspect(identity, b), { state: 'streaming', isOwner: true });
    runs.release(second);
    assert.deepEqual(await runs.inspect(identity, a), { state: 'streaming', isOwner: false });
    await assert.rejects(() => createSessionRunCoordinator(paths).begin(a, identity), { code: 'session_busy' });
  } finally { await f.close(); }
});

test('independent coordinator instances serialize check and persistent intent across both files', async () => {
  const f = await fixture();
  try {
    const paths = { bindingsV2File: f.v2, bindingsFile: f.legacy };
    const identity = { connectionId: 'studio-default', kind: 'studio', profile: 'default', storedSessionId: 'stored-1', installId: null };
    const results = await Promise.allSettled([
      createSessionRunCoordinator(paths).begin({ kind: 'v2', chatId: 'a', documentRootId: ROOT }, identity),
      createSessionRunCoordinator(paths).begin({ kind: 'legacy-studio', sessionId: 'stored-1', documentRootId: ROOT }, identity),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'session_busy').length, 1);
    const rows = [...Object.values(JSON.parse(await readFile(f.v2, 'utf8'))), ...Object.values(JSON.parse(await readFile(f.legacy, 'utf8')))];
    assert.equal(rows.filter((row: any) => row.run?.phase === 'intent').length, 1);
  } finally { await f.close(); }
});

for (const mutation of ['owner', 'identity', 'receipt', 'content', 'phase', 'attempt-type']) test(`stored run ${mutation} corruption cannot reopen or send`, async () => {
  const f = await fixture('serve');
  try {
    f.state.hold = false;
    const rows = JSON.parse(await readFile(f.v2, 'utf8'));
    const run: any = { schemaVersion: 1, attemptId: '11111111-1111-4111-8111-111111111111', phase: 'intent', owner: { kind: 'v2', chatId: 'a', documentRootId: ROOT }, identity: { connectionId: 'serve-one', kind: 'serve', profile: 'default', storedSessionId: 'stored-1', installId: 'install-1' } };
    if (mutation === 'attempt-type') run.attemptId = [run.attemptId];
    if (mutation === 'owner') run.owner.documentRootId = OTHER;
    if (mutation === 'identity') run.identity.connectionId = 'serve-two';
    if (mutation === 'receipt') { run.phase = 'completed'; run.receipt = { source: 'serve', terminal: 'completed', verified: false }; }
    if (mutation === 'content') run.input = 'must not be stored';
    if (mutation === 'phase') run.phase = 'anything';
    rows.a.run = run; await writeFile(f.v2, JSON.stringify(rows));
    assert.equal((await f.call('/chats/b/chat/stream', OTHER, { message: 'question' })).status, 500);
    assert.equal(f.state.calls, 0);
    assert.deepEqual(JSON.parse(await readFile(f.v2, 'utf8')), rows);
  } finally { await f.close(); }
});

test('previous accepted ticket cannot interrupt a later attempt from the same Chat', async () => {
  const f = await fixture('serve');
  try {
    const firstResponse = await f.call('/chats/a/chat/stream', ROOT, { message: 'question' });
    const firstReader = firstResponse.body!.getReader();
    const firstStart = JSON.parse(new TextDecoder().decode((await firstReader.read()).value).split('data: ')[1].split('\n')[0]);
    f.gate.resolve(); while (!(await firstReader.read()).done) {}
    const next = f.nextTurn();
    const secondResponse = await f.call('/chats/a/chat/stream', ROOT, { message: 'question' });
    const secondReader = secondResponse.body!.getReader();
    const secondStart = JSON.parse(new TextDecoder().decode((await secondReader.read()).value).split('data: ')[1].split('\n')[0]);
    assert.notEqual(firstStart.runId, secondStart.runId);
    f.events[0]({ type: 'message.complete', payload: { status: 'complete' } });
    await (await f.call('/chats/a/stop', ROOT, { runId: firstStart.runId })).text();
    assert.equal(f.state.interrupts, 0);
    assert.equal((await (await f.call('/chats/a/stop', ROOT, { runId: secondStart.runId })).json()).state, 'interrupted');
    assert.equal(f.state.interrupts, 1);
    next.resolve(); while (!(await secondReader.read()).done) {}
  } finally { await f.close(); }
});

for (const kind of ['studio', 'serve']) test(`${kind} stream loss retains unknown even when a late completion arrives`, async () => {
  const f = await fixture(kind);
  try {
    const response = await f.call('/chats/a/chat/stream', ROOT, { message: 'question' });
    const reader = response.body!.getReader();
    await reader.read(); await reader.cancel();
    await f.aborted.promise;
    f.gate.resolve();
    let phase;
    for (let count = 0; count < 100; count++) {
      phase = JSON.parse(await readFile(f.v2, 'utf8')).a.run.phase;
      if (phase === 'unknown') break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(phase, 'unknown');
    assert.equal((await f.call('/chats/b/chat/stream', OTHER, { message: 'second' })).status, 409);
    assert.equal(f.state.calls, 1);
  } finally { await f.close(); }
});

test('legacy same-ID create cannot erase unknown run evidence or reset pending and title', async () => {
  const f = await fixture();
  try {
    f.state.hold = false; f.state.failRun = true;
    const created = await (await f.call('/sessions', ROOT, { title: 'Original' })).json();
    const id = created.session.id;
    assert.ok(id.startsWith(`siyuan:${ROOT}:`));
    await (await f.call(`/sessions/${encodeURIComponent(id)}/chat`, ROOT, { message: 'question' })).text();
    const before = JSON.parse(await readFile(f.legacy, 'utf8'));
    assert.equal(before[`${ROOT}:${id}`].run.phase, 'unknown');
    const repeated = await f.call('/sessions', ROOT, { title: 'Replacement', session_id: id });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).session.title, 'Original');
    assert.deepEqual(JSON.parse(await readFile(f.legacy, 'utf8')), before);
    assert.equal((await f.call(`/sessions/${encodeURIComponent(id)}/chat/stream`, ROOT, { message: 'second' })).status, 409);
    assert.equal(f.state.calls, 1);
  } finally { await f.close(); }
});

test('Serve unknown result retires its accepted stop ticket before history reconciliation', async () => {
  const f = await fixture('serve');
  try {
    f.state.outcome = 'unknown'; f.state.holdHistory = true;
    const response = await f.call('/chats/a/chat/stream', ROOT, { message: 'question' });
    const reader = response.body!.getReader();
    const started = JSON.parse(new TextDecoder().decode((await reader.read()).value).split('data: ')[1].split('\n')[0]);
    f.gate.resolve(); await f.historyEntered.promise;
    const stopped = await f.call('/chats/a/stop', ROOT, { runId: started.runId });
    assert.equal((await stopped.json()).state, 'unknown');
    assert.equal(f.state.interrupts, 0);
    f.historyGate.resolve(); while (!(await reader.read()).done) {}
    assert.equal(JSON.parse(await readFile(f.v2, 'utf8')).a.run.phase, 'unknown');
  } finally { await f.close(); }
});

for (const firstRoute of ['/chat', '/chat/stream']) test(`legacy ${firstRoute} unresolved owner survives a unique registry ID change across restart`, async () => {
  const f = await fixture();
  try {
    f.state.hold = false; f.state.failRun = true;
    f.options.connections.connections[0].id = 'studio-original';
    await (await f.call(`/sessions/stored-1${firstRoute}`, ROOT, { message: 'question' })).text();
    const before = await readFile(f.legacy, 'utf8');
    const original = JSON.parse(before)[`${ROOT}:stored-1`].run;
    assert.equal(original.phase, 'unknown');
    assert.equal(original.identity.connectionId, 'studio-original');
    assert.equal(f.state.calls, 1);

    f.options.connections.connections[0].id = 'studio-renamed';
    await f.restart();
    for (const retryRoute of ['/chat', '/chat/stream']) {
      const response = await f.call(`/sessions/stored-1${retryRoute}`, ROOT, { message: 'must not send' });
      const body = await response.text();
      assert.equal(f.state.calls, 1, 'Changing the registry ID cannot authorize another upstream send');
      assert.equal(response.status, 409);
      assert.equal(JSON.parse(body).error.code, 'session_identity_unknown');
      assert.equal(await readFile(f.legacy, 'utf8'), before, 'Keep the complete unresolved owner row and attempt byte-for-byte');
    }
    f.options.connections.connections[0].id = 'studio-original';
    await f.restart();
    const restored = await f.call('/sessions/stored-1/chat', ROOT, { message: 'still unresolved' });
    assert.equal(restored.status, 409);
    assert.equal((await restored.json()).error.code, 'session_result_unknown');
    assert.equal(f.state.calls, 1);
    assert.equal(await readFile(f.legacy, 'utf8'), before);
  } finally { await f.close(); }
});

test('distinct legacy owner rows retain independent connection identities despite an unresolved attempt', async () => {
  const f = await fixture();
  try {
    const rows = JSON.parse(await readFile(f.legacy, 'utf8'));
    rows[`${OTHER}:stored-1`] = { id: 'stored-1', documentRootId: OTHER, title: 'Other owner', source: 'studio', profile: 'default', pending: false };
    await writeFile(f.legacy, JSON.stringify(rows));
    f.state.hold = false; f.state.failRun = true;
    f.options.connections.connections[0].id = 'studio-original';
    await (await f.call('/sessions/stored-1/chat', ROOT, { message: 'question' })).text();
    const original = JSON.parse(await readFile(f.legacy, 'utf8'))[`${ROOT}:stored-1`];
    assert.equal(original.run.phase, 'unknown');

    f.options.connections.connections[0].id = 'studio-renamed';
    f.state.failRun = false;
    await f.restart();
    const response = await f.call('/sessions/stored-1/chat', OTHER, { message: 'independent identity' });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message.content, 'answer');
    assert.equal(f.state.calls, 2);
    const after = JSON.parse(await readFile(f.legacy, 'utf8'));
    assert.deepEqual(after[`${ROOT}:stored-1`], original);
    assert.equal(after[`${OTHER}:stored-1`].run.identity.connectionId, 'studio-renamed');
    assert.equal(after[`${OTHER}:stored-1`].run.phase, 'completed');
    assert.notEqual(after[`${OTHER}:stored-1`].run.attemptId, original.run.attemptId);
  } finally { await f.close(); }
});

test('legacy Studio failed event waits for terminal persistence and retains its original error payload',async t=>{
 const f=await fixture(),writing=deferred(),persist=deferred();const rename=fsPromises.rename;let body='';
 try{
  f.state.hold=false;f.state.terminalFailure=true;
  t.mock.method(fsPromises,'rename',async(from:any,to:any)=>{
   if(to===f.legacy&&JSON.parse(await readFile(from,'utf8'))[`${ROOT}:stored-1`].run?.phase==='failed'){writing.resolve();await persist.promise;}
   return rename(from,to);
  });syncBuiltinESMExports();
  const response=await f.call('/sessions/stored-1/chat/stream',ROOT,{message:'synthetic'});const reading=(async()=>{const reader=response.body!.getReader(),decoder=new TextDecoder();try{while(true){const chunk=await reader.read();if(chunk.done)break;body+=decoder.decode(chunk.value,{stream:true});}}finally{reader.releaseLock();}})();
  await writing.promise;assert.doesNotMatch(body,/event: run\.failed/);assert.equal(JSON.parse(await readFile(f.legacy,'utf8'))[`${ROOT}:stored-1`].run.phase,'streaming');
  assert.equal(f.state.calls,1);persist.resolve();await reading;
  assert.match(body,/event: run\.started/);assert.match(body,/event: run\.failed\ndata: {"error":"synthetic rejection"}/);assert.ok(body.indexOf('run.started')<body.indexOf('run.failed'));assert.equal(JSON.parse(await readFile(f.legacy,'utf8'))[`${ROOT}:stored-1`].run.phase,'failed');
 }finally{persist.resolve();t.mock.restoreAll();syncBuiltinESMExports();await f.close();}
});

// These routes use the production adapter; only the external Studio socket is synthetic.
for (const route of ['/chats/a/chat/stream', '/sessions/stored-1/chat/stream']) for (const stage of ['token', 'connect', 'sent', 'persisting', 'persistence-failed', 'accepted', 'terminal', 'auth-sent', 'auth-accepted', 'reconnect-sent', 'reconnect-accepted']) test(`production Studio ${route} cancellation at ${stage} preserves ownership`, async t => {
  const entered = deferred(), tokenGate = deferred(), settled = deferred(), cancelled = deferred();
  const listeners = new Map<string, Function>(), emitted: string[] = [];
  const socket = { on(event: string, cb: Function) { listeners.set(event, cb); }, off() {}, removeAllListeners() {}, disconnect() {}, emit(event: string) { emitted.push(event); if (event === 'abort') queueMicrotask(() => listeners.get('abort.completed')?.({})); } };
  const f = await fixture('studio', options => { options.studioRun = async (args: any) => {
    args.signal.addEventListener('abort', () => cancelled.resolve(), { once: true });
    entered.resolve();
    try { return await runStudioSocket({ ...args, tokenProvider: async () => { if (stage === 'token') await tokenGate.promise; return 'synthetic'; }, socketFactory: () => socket, abortGraceMs: 20 }); }
    finally { settled.resolve(); }
  }; });
  const controller = new AbortController(), writing = deferred(), persist = deferred();
  const rename = fsPromises.rename;
  if (['persisting', 'persistence-failed'].includes(stage)) {
    t.mock.method(fsPromises, 'rename', async (from: any, to: any) => {
      if (to === (route.startsWith('/chats/') ? f.v2 : f.legacy)) {
        const rows = JSON.parse(await readFile(from, 'utf8'));
        if (Object.values(rows).some((row: any) => row.run?.phase === 'streaming')) {
          writing.resolve(); await persist.promise;
          if (stage === 'persistence-failed') throw new Error('synthetic streaming persistence failure');
        }
      }
      return rename(from, to);
    }); syncBuiltinESMExports();
  }
  try {
    const beforeV2 = JSON.parse(await readFile(f.v2, 'utf8')), beforeLegacy = JSON.parse(await readFile(f.legacy, 'utf8'));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const response = f.call(route, ROOT, { message: 'synthetic' }, controller.signal).catch(() => undefined);
    await entered.promise; await new Promise(r => setImmediate(r));
    if (['sent', 'persisting', 'persistence-failed', 'accepted', 'terminal', 'auth-sent', 'auth-accepted', 'reconnect-sent', 'reconnect-accepted'].includes(stage)) listeners.get('connect')?.();
    if (['persisting', 'persistence-failed'].includes(stage)) {
      listeners.get('run.started')?.({}); await writing.promise;
      if (stage === 'persistence-failed') { persist.resolve(); await settled.promise; }
    }
    if (['accepted', 'terminal', 'auth-accepted', 'reconnect-accepted'].includes(stage)) {
      listeners.get('run.started')?.({});
      const stream = await response; assert.ok(stream);
      reader = stream.body!.getReader();
      await reader.read(); // acceptance persisted and delivered by the real route
    }
    if (stage === 'terminal') { listeners.get('run.completed')?.({ content: 'synthetic' }); while (!(await reader!.read()).done) {} }
    if (stage.startsWith('auth-')) { await listeners.get('connect_error')?.(new Error('synthetic token expired')); listeners.get('connect')?.(); }
    if (stage.startsWith('reconnect-')) listeners.get('connect')?.();
    controller.abort();
    if (stage === 'persisting') await cancelled.promise;
    tokenGate.resolve(); persist.resolve(); await response; await settled.promise;
    const isV2 = route.startsWith('/chats/');
    let rows: any;
    for (let count = 0; count < 100; count++) {
      rows = JSON.parse(await readFile(isV2 ? f.v2 : f.legacy, 'utf8'));
      if (['unknown', 'completed'].includes(rows[isV2 ? 'a' : `${ROOT}:stored-1`].run?.phase)) break;
      await new Promise(r => setTimeout(r, 5));
    }
    const run = rows[isV2 ? 'a' : `${ROOT}:stored-1`].run;
    assert.equal(run.phase, stage === 'terminal' ? 'completed' : 'unknown');
    if (stage !== 'terminal') assert.equal(run.receipt, undefined);
    assert.equal(run.owner.kind, isV2 ? 'v2' : 'legacy-studio');
    assert.equal(run.identity.storedSessionId, 'stored-1');
    assert.deepEqual(JSON.parse(await readFile(isV2 ? f.legacy : f.v2, 'utf8')), isV2 ? beforeLegacy : beforeV2);
    const snapshot = await readFile(isV2 ? f.v2 : f.legacy, 'utf8');
    listeners.get('connect')?.(); listeners.get('run.started')?.({}); listeners.get('run.completed')?.({});
    await new Promise(r => setImmediate(r));
    assert.equal(await readFile(isV2 ? f.v2 : f.legacy, 'utf8'), snapshot);
    assert.equal(emitted.filter(event => event === 'abort').length, stage === 'accepted' ? 1 : 0);
    assert.equal(emitted.filter(event => event === 'run').length, ['sent', 'persisting', 'persistence-failed', 'accepted', 'terminal', 'auth-sent', 'auth-accepted', 'reconnect-sent', 'reconnect-accepted'].includes(stage) ? 1 : 0);
    if (stage !== 'terminal') {
      const blocked = await f.call('/chats/b/chat/stream', OTHER, { message: 'must not send' });
      assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error.code, 'session_result_unknown');
    }
  } finally { controller.abort(); tokenGate.resolve(); persist.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); await f.close(); }
});
