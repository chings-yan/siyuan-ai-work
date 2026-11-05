import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
// @ts-expect-error -- runtime ESM module has no declaration.
import { createBridgeServer } from '../scripts/bridge.mjs';

const CAP = 'synthetic-capability-'.repeat(4);
const STUDIO = 'synthetic-studio-token';
const LEGACY = 'synthetic-legacy-token';
const SERVE = 'synthetic-serve-token';
const response = (body: unknown, status = 200) => Response.json(body, { status });
type Phase = 'request.start' | 'route.enter' | 'response.end' | 'response.headers' | 'response.json'
  | 'upstream.read' | 'upstream.abort' | 'upstream.headers' | 'upstream.body' | 'upstream.close' | 'watchdog.timeout';
function phaseTrace() {
  const started = performance.now();
  const events: Array<{ phase: Phase; ms: number }> = [];
  let omitted = 0;
  return {
    mark(phase: Phase) { if (events.length < 96) events.push({ phase, ms: Math.round(performance.now() - started) }); else omitted++; },
    snapshot: () => ({ events: [...events], omitted }),
  };
}
type Trace = ReturnType<typeof phaseTrace>;
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
async function withProbeClock<T>(run: (clock: { advanceTo(ms: number): void }) => Promise<T>): Promise<T> {
  const originalNow = Date.now, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const epoch = originalNow();
  let now = 0;
  const timers = new Map<ReturnType<typeof setTimeout>, { at: number; fire(): void }>();
  // Only the two synthetic shared-budget cases use this clock. Fixture and phase
  // watchdogs below retain saved real timers, including when no phase arrives.
  Date.now = () => epoch + now;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms = 0, ...args: any[]) => {
    const handle = {} as ReturnType<typeof setTimeout>;
    timers.set(handle, { at: now + Math.max(0, Number(ms) || 0), fire: () => callback(...args) });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    if (!timers.delete(handle)) originalClear(handle);
  }) as typeof clearTimeout;
  try {
    return await run({ advanceTo(target) {
      assert.ok(Number.isFinite(target) && target >= now, 'controlled time only advances');
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].fire();
      }
      now = target;
    } });
  } finally {
    // Abort races can leave injected 300ms reads pending; cancel their virtual
    // callbacks so they cannot write or schedule work after this scope returns.
    timers.clear(); Date.now = originalNow; globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
  }
}
function phaseBarrier() {
  let arrive!: () => void;
  const reached = new Promise<void>(resolve => { arrive = resolve; });
  return { arrive, wait: (trace: Trace) => fixtureDeadline(reached, trace) };
}
async function fixtureDeadline<T>(operation: Promise<T>, trace: Trace): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = realSetTimeout(() => { trace.mark('watchdog.timeout'); reject(new DOMException('Synthetic fixture deadline expired', 'TimeoutError')); }, 1500);
    })]);
  } catch (error) {
    if (error instanceof Error) Object.defineProperty(error, 'fixturePhases', { value: trace.snapshot(), enumerable: true, configurable: true });
    throw error;
  } finally { realClearTimeout(timer); }
}

// Invoke the real listener and consume its serialized JSON. The matrix asserts
// route semantics; dedicated HTTP cases below retain the native client hop.
async function inspectListener(listener: (req: any, res: any) => unknown, path: string, headers: Record<string, string>, trace = phaseTrace()) {
  trace.mark('request.start');
  return fixtureDeadline(new Promise<{ status: number; text: string; headers: Headers }>((resolve, reject) => {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url: path, headers });
    const res = Object.assign(new EventEmitter(), {
      headersSent: false, writableEnded: false, statusCode: 200, headers: new Headers(),
      writeHead(status: number, values: Record<string, string>) { this.statusCode = status; this.headers = new Headers(values); this.headersSent = true; return this; },
      end(text: string) { this.writableEnded = true; trace.mark('response.end'); resolve({ status: this.statusCode, text, headers: this.headers }); return this; },
      destroy(error: Error) { reject(error); },
    });
    trace.mark('route.enter');
    Promise.resolve().then(() => listener(req, res)).catch(reject);
  }).then(result => {
    const body = JSON.parse(result.text); trace.mark('response.json');
    return { status: result.status, headers: result.headers, body, states: body.data?.map((row: any) => row.state) };
  }), trace);
}
type Options = {
  fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>;
  ping?: () => Promise<unknown>; list?: () => Promise<unknown>;
  serveToken?: string; studioToken?: string | null; legacyToken?: string; profile?: string;
  studioBase?: string; hermesBase?: string; status?: unknown;
  tokenProvider?: () => Promise<string>; useDefaultGateway?: boolean; probeTimeoutMs?: number;
};

async function fixture(t: any, options: Options = {}) {
  const trace = phaseTrace();
  const dir = await mkdtemp(join(tmpdir(), 'unified-hermes-'));
  const tokenFile = join(dir, 'serve-token');
  const bindingsFile = join(dir, 'old.json');
  const bindingsV2File = join(dir, 'v2.json');
  await writeFile(tokenFile, options.serveToken ?? SERVE);
  // Deliberately opaque files: detection must neither interpret nor rewrite them.
  await writeFile(bindingsFile, 'synthetic binding bytes');
  await writeFile(bindingsV2File, 'synthetic v2 binding bytes');
  const before = await Promise.all([readFile(tokenFile), readFile(bindingsFile), readFile(bindingsV2File)]);
  const previous = process.env.API_SERVER_KEY;
  process.env.API_SERVER_KEY = options.legacyToken ?? LEGACY;
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const rpc: string[] = [];
  let closes = 0;
  const connections = { defaultConnectionId: 'serve-local', connections: [
    { id: 'serve-local', kind: 'serve', baseUrl: 'http://127.0.0.1:9119/', profile: options.profile ?? 'default', tokenFile },
    { id: 'studio-default', kind: 'studio', profile: 'default' },
    { id: 'legacy-api', kind: 'legacy-api', profile: 'default' },
  ] };
  const { server } = (createBridgeServer as any)({
    capability: CAP, bindingsFile, bindingsV2File, connections,
    studioBase: options.studioBase ?? 'http://127.0.0.1:8748', hermesBase: options.hermesBase ?? 'http://127.0.0.1:8642',
    studioToken: options.studioToken === null ? undefined : options.studioToken ?? STUDIO, tokenProvider: options.tokenProvider,
    // Protocol assertions need room for token-file I/O under the default parallel suite.
    // Deadline tests use an explicit 500ms budget; their 300ms steps each fit,
    // but two required reads cannot fit together. This also leaves token-file
    // setup enough room under parallel load to reach the asserted phase.
    probeTimeoutMs: options.probeTimeoutMs ?? 1000,
    fetchImpl: async (raw: string | URL, init: RequestInit) => {
      const url = new URL(raw); calls.push({ url, init });
      trace.mark('upstream.read');
      init.signal?.addEventListener('abort', () => trace.mark('upstream.abort'), { once: true });
      if (options.fetchImpl) return options.fetchImpl(url, init);
      if (url.pathname === '/api/status') return response(options.status ?? { install_id: 'synthetic-install' });
      if (url.pathname.startsWith('/api/studio/')) return response({ sessions: [], hasMore: false, offset: 0, limit: 1 });
      return response({ data: [] });
    },
    gatewayFactory: options.useDefaultGateway ? undefined : (input: any) => {
      assert.equal(input.profile, options.profile ?? 'default');
      assert.equal(input.token, SERVE);
      return {
        ping: async () => { rpc.push('gateway.ping'); return options.ping ? options.ping() : { ok: true }; },
        list: async () => { rpc.push('session.list'); return options.list ? options.list() : { sessions: [] }; },
        create: () => assert.fail('detection created a session'), resume: () => assert.fail('detection resumed a session'),
        submit: () => assert.fail('detection submitted a message'), interrupt: () => assert.fail('detection stopped a session'),
        close: () => { closes++; },
      };
    },
    studioRun: () => assert.fail('detection ran a Studio handshake'),
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previous === undefined) delete process.env.API_SERVER_KEY; else process.env.API_SERVER_KEY = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const listener = server.listeners('request')[0].bind(server);
  server.prependListener('request', (_req: any, res: any) => {
    trace.mark('route.enter'); res.once('finish', () => trace.mark('response.end'));
  });
  const inspect = (cap = CAP) => inspectListener(listener, '/connections', { 'x-siyuan-collab-token': cap }, trace);
  const inspectHTTP = async (cap = CAP) => {
    trace.mark('request.start');
    const signal = AbortSignal.timeout(1500);
    const onAbort = () => trace.mark('watchdog.timeout');
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(`${base}/connections`, { headers: { 'X-Siyuan-Collab-Token': cap }, signal });
      trace.mark('response.headers');
      const body = await res.json(); trace.mark('response.json');
      return { status: res.status, headers: res.headers, body, states: body.data?.map((row: any) => row.state) };
    } catch (error) {
      if (error instanceof Error) Object.defineProperty(error, 'fixturePhases', { value: trace.snapshot(), enumerable: true });
      throw error;
    } finally { signal.removeEventListener('abort', onAbort); }
  };
  const readStudio = async () => {
    const res = await fetch(`${base}/connections/studio-default/sessions`, { headers: { 'X-Siyuan-Collab-Token': CAP, 'X-Siyuan-Document-Root': '20261010123456-abcdefg' }, signal: AbortSignal.timeout(1500) });
    return { status: res.status, body: await res.json() };
  };
  const unchanged = async () => {
    assert.deepEqual((await readdir(dir)).sort(), ['old.json', 'serve-token', 'v2.json']);
    assert.deepEqual(await Promise.all([readFile(tokenFile), readFile(bindingsFile), readFile(bindingsV2File)]), before);
  };
  return { inspect, inspectHTTP, readStudio, unchanged, calls, rpc, closed: () => closes, dir, server, trace };
}

test('state matrix inspection reaches the actual Bridge listener without a listening client socket', async t => {
  const f = await fixture(t);
  await new Promise<void>(resolve => f.server.close(() => resolve()));
  const result = await f.inspect();
  assert.equal(result.status, 200);
  assert.deepEqual(result.states, ['ready', 'ready', 'ready']);
  assert.equal((await f.inspect('wrong')).status, 401);
  await f.unchanged();
});

test('listener inspection rejects a nonresponding handler at the retained fixture watchdog', async () => {
  await assert.rejects(inspectListener(() => {}, '/connections', { 'x-siyuan-collab-token': CAP }), { name: 'TimeoutError' });
});

test('controlled probe clock releases a 300ms step only at its deadline and restores real timers', async () => {
  const originalNow = Date.now, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  await withProbeClock(async clock => {
    const start = Date.now();
    let completed = false;
    const cancelled = setTimeout(() => assert.fail('a cleared controlled timer fired'), 100);
    clearTimeout(cancelled);
    const timer = setTimeout(() => { completed = true; }, 300);
    try {
      clock.advanceTo(299); assert.equal(completed, false);
      clock.advanceTo(300); assert.equal(completed, true);
      assert.equal(Date.now() - start, 300);
    } finally { clearTimeout(timer); }
  });
  assert.equal(Date.now, originalNow); assert.equal(globalThis.setTimeout, originalSet); assert.equal(globalThis.clearTimeout, originalClear);
  await fixtureDeadline(new Promise<void>(resolve => setTimeout(resolve, 0)), phaseTrace());
});

test('controlled probe clock restores after failure while missing phases and nonsettling listeners stay bounded', async () => {
  const originalNow = Date.now, originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  let lateCallback = false;
  await assert.rejects(withProbeClock(async () => {
    setTimeout(() => { lateCallback = true; }, 300);
    await Promise.all([
      assert.rejects(phaseBarrier().wait(phaseTrace()), { name: 'TimeoutError' }),
      assert.rejects(inspectListener(() => {}, '/connections', { 'x-siyuan-collab-token': CAP }), { name: 'TimeoutError' }),
    ]);
    assert.equal(lateCallback, false);
    throw new Error('synthetic clock scope failure');
  }), /synthetic clock scope failure/);
  assert.equal(Date.now, originalNow); assert.equal(globalThis.setTimeout, originalSet); assert.equal(globalThis.clearTimeout, originalClear);
  await fixtureDeadline(new Promise<void>(resolve => setTimeout(resolve, 0)), phaseTrace());
  assert.equal(lateCallback, false);
});

test('real client HTTP preserves ready JSON, response headers and authentication denial', async t => {
  const f = await fixture(t);
  const result = await f.inspectHTTP();
  assert.equal(result.status, 200);
  assert.deepEqual(result.states, ['ready', 'ready', 'ready']);
  assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(f.rpc, ['gateway.ping', 'session.list']);
  const calls = f.calls.length, rpc = f.rpc.length;
  const denied = await f.inspectHTTP('wrong');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'unauthorized');
  assert.equal(f.calls.length, calls); assert.equal(f.rpc.length, rpc);
  for (const privateValue of [STUDIO, LEGACY, SERVE, f.dir]) assert.equal(JSON.stringify(result.body).includes(privateValue), false);
  await f.unchanged();
});

test('real client HTTP keeps 302 incompatible for every configured protocol', async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response('synthetic upstream private error', { status: 302 }) });
  const result = await f.inspectHTTP();
  assert.equal(result.status, 200);
  assert.deepEqual(result.states, ['incompatible', 'incompatible', 'incompatible']);
  assert.equal(JSON.stringify(result.body).includes('synthetic upstream'), false);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.rpc, []);
  for (const { init } of f.calls) { assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal); }
  await f.unchanged();
});

test('configured protocols are probed independently when only Serve, only Studio, both or legacy are available', async t => {
  for (const ready of [new Set(['serve']), new Set(['studio']), new Set(['serve', 'studio']), new Set<string>(), new Set(['legacy'])]) {
    await t.test([...ready].join('+') || 'none', async t => {
      const f = await fixture(t, { fetchImpl: async url => {
        const kind = url.pathname === '/api/status' ? 'serve' : url.pathname.startsWith('/api/studio/') ? 'studio' : 'legacy';
        if (!ready.has(kind)) throw new Error('synthetic unavailable');
        return response(kind === 'serve' ? { install_id: 'synthetic-install', version: 'future-999' } : kind === 'studio' ? { sessions: [] } : { data: [] });
      } });
      const result = await f.inspect();
      assert.equal(result.status, 200);
      assert.deepEqual(result.states, ['serve', 'studio', 'legacy'].map(kind => ready.has(kind) ? 'ready' : 'offline'));
      assert.deepEqual(result.body.data.map((row: any) => [row.id, row.kind, row.profile, row.installId]), [
        ['serve-local', 'serve', 'default', ready.has('serve') ? 'synthetic-install' : null],
        ['studio-default', 'studio', 'default', null], ['legacy-api', 'legacy-api', 'default', null],
      ]);
      await f.unchanged();
    });
  }
});

test('ready performs only authenticated required reads, ignores versions and returns no bodies or secrets', async t => {
  const f = await fixture(t, { profile: 'custom-profile', fetchImpl: async url => response(url.pathname === '/api/status'
    ? { install_id: 'synthetic-install' }
    : url.pathname.startsWith('/api/studio/') ? { sessions: [{ id: 's', profile: 'default', title: 'synthetic private title', messages: [{ content: 'synthetic private body' }] }], version: 'next' }
    : { data: [{ id: 'legacy', title: 'synthetic private title' }] }) });
  const result = await f.inspect();
  assert.deepEqual(result.states, ['ready', 'ready', 'ready']);
  assert.equal(result.body.data[0].profile, 'custom-profile');
  assert.deepEqual(f.rpc, ['gateway.ping', 'session.list']); assert.equal(f.closed(), 2);
  assert.deepEqual(f.calls.map(({ url }) => url.pathname + url.search).sort(), [
    '/api/sessions?source=api_server&limit=200', '/api/status', '/api/studio/sessions', '/api/studio/sessions/hermes?offset=0&limit=1',
  ]);
  for (const { url, init } of f.calls) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual'); assert.ok(init.signal);
    const headers = init.headers as Record<string, string>;
    assert.equal(headers?.Authorization, url.pathname.startsWith('/api/studio/') ? `Bearer ${STUDIO}` : url.pathname === '/api/status' ? undefined : `Bearer ${LEGACY}`);
  }
  const publicText = JSON.stringify(result.body);
  for (const privateValue of [STUDIO, LEGACY, SERVE, f.dir, 'synthetic private title', 'synthetic private body']) assert.equal(publicText.includes(privateValue), false);
  await f.unchanged();
});

test('missing credentials do not contact any configured service', async t => {
  const f = await fixture(t, { serveToken: '', studioToken: '', legacyToken: '' });
  assert.deepEqual((await f.inspect()).states, ['auth_missing', 'auth_missing', 'auth_missing']);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.rpc, []); await f.unchanged();
});

test('Studio credential authority uses the supplied provider before the inline token', async t => {
  let reads = 0;
  const f = await fixture(t, { tokenProvider: async () => { reads++; return ''; } });
  assert.equal((await f.inspect()).states[1], 'auth_missing');
  assert.equal(reads, 1); assert.equal(f.calls.some(({ url }) => url.pathname.startsWith('/api/studio/')), false);
});

for (const status of [401, 403, 404, 405, 302, 503]) test(`HTTP ${status} has a truthful state for every configured protocol`, async t => {
  const f = await fixture(t, { fetchImpl: async () => new Response('synthetic upstream private error', { status }) });
  const result = await f.inspect();
  const state = [401, 403].includes(status) ? 'auth_failed' : [404, 405, 302].includes(status) ? 'incompatible' : 'offline';
  assert.deepEqual(result.states, [state, state, state]);
  assert.equal(JSON.stringify(result.body).includes('synthetic upstream'), false); await f.unchanged();
});

for (const malformed of [null, {}, { sessions: {} }, { sessions: [null] }, { sessions: [{ id: 2 }] }]) test(`Studio rejects malformed metadata ${JSON.stringify(malformed)}`, async t => {
  const f = await fixture(t, { fetchImpl: async url => response(url.pathname === '/api/status' ? { install_id: 'synthetic-install' } : url.pathname.startsWith('/api/studio/') ? malformed : { data: [] }) });
  assert.equal((await f.inspect()).states[1], 'incompatible');
});

test('Studio requires the canonical read even when its index succeeds', async t => {
  const f = await fixture(t, { fetchImpl: async url => url.pathname.endsWith('/hermes') ? response({}, 404) : response(url.pathname === '/api/status' ? { install_id: 'synthetic-install' } : { sessions: [], data: [] }) });
  assert.equal((await f.inspect()).states[1], 'incompatible');
});

test('Studio rejects unusable advancing pagination but accepts a complete empty list', async t => {
  const f = await fixture(t, { fetchImpl: async url => response(url.pathname === '/api/status' ? { install_id: 'synthetic-install' } : { data: [], sessions: [], hasMore: true, offset: 0, limit: 0 }) });
  assert.equal((await f.inspect()).states[1], 'incompatible');
});

for (const invalid of [undefined, null, {}, { sessions: {} }, { sessions: [null] }, { sessions: [{ id: 3 }] }]) test(`Serve rejects unusable list ${JSON.stringify(invalid)}`, async t => {
  const f = await fixture(t, { list: async () => invalid });
  assert.equal((await f.inspect()).states[0], 'incompatible'); await f.unchanged();
});

for (const invalid of [undefined, null, false, [], {}, { ok: false }, 'synthetic error']) test(`Serve rejects unusable ping ${JSON.stringify(invalid)}`, async t => {
  const f = await fixture(t, { ping: async () => invalid });
  assert.equal((await f.inspect()).states[0], 'incompatible');
});

for (const invalid of [{}, { install_id: '' }, { install_id: 3 }]) test(`Serve rejects invalid identity ${JSON.stringify(invalid)}`, async t => {
  const f = await fixture(t, { status: invalid });
  assert.equal((await f.inspect()).states[0], 'incompatible'); assert.deepEqual(f.rpc, []);
});

test('Serve rejects expired authentication without leaking RPC error details', async t => {
  const f = await fixture(t, { list: async () => { throw Object.assign(new Error(STUDIO), { status: 403 }); } });
  const result = await f.inspect(); assert.equal(result.states[0], 'auth_failed'); assert.equal(JSON.stringify(result.body).includes(STUDIO), false);
});

test('non-JSON bodies and legacy objects without a data array are incompatible', async t => {
  const f = await fixture(t, { fetchImpl: async url => url.pathname.startsWith('/api/studio/') ? new Response('not JSON') : response(url.pathname === '/api/status' ? { install_id: 'synthetic-install' } : { data: {} }) });
  assert.deepEqual((await f.inspect()).states, ['ready', 'incompatible', 'incompatible']);
});

test('non-loopback configured origins never receive tokens or requests', async t => {
  const f = await fixture(t, { studioBase: 'http://outside.example', hermesBase: 'http://user@127.0.0.1:8642' });
  assert.deepEqual((await f.inspect()).states, ['ready', 'incompatible', 'incompatible']);
  assert.deepEqual(f.calls.map(({ url }) => url.pathname), ['/api/status']);
});

for (const phase of ['headers', 'body', 'rpc']) test(`detection bounds stalled ${phase} even when an injected transport ignores abort`, async t => {
  let stalledReads = 0;
  const never = () => { stalledReads++; return new Promise<any>(() => {}); };
  const f = await fixture(t, phase === 'rpc' ? { probeTimeoutMs: 500, list: never } : { probeTimeoutMs: 500, fetchImpl: phase === 'headers' ? never : async () => ({ ok: true, status: 200, json: never } as any) });
  const started = performance.now();
  const result = await f.inspect();
  assert.ok(performance.now() - started < 1000);
  assert.deepEqual(result.states, phase === 'rpc' ? ['offline', 'ready', 'ready'] : ['offline', 'offline', 'offline']);
  assert.equal(stalledReads, phase === 'rpc' ? 1 : 3, 'inspection reached the intended stalled transport phase');
  if (phase === 'rpc') { assert.deepEqual(f.rpc, ['gateway.ping', 'session.list']); assert.equal(f.closed(), 2); }
  await f.unchanged();
});

test('unauthorized detection never probes services', async t => {
  const f = await fixture(t);
  assert.equal((await f.inspect('wrong')).status, 401); assert.deepEqual(f.calls, []); assert.deepEqual(f.rpc, []);
});

test('real loopback redirects do not forward Studio or legacy credentials', async t => {
  let redirectedReads = 0;
  const destination = createServer((_req, res) => { redirectedReads++; res.end('{}'); });
  const upstream = createServer((_req, res) => { res.writeHead(302, { Location: `http://127.0.0.1:${(destination.address() as any).port}/outside` }); res.end(); });
  for (const server of [destination, upstream]) {
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  }
  const base = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const f = await fixture(t, { studioBase: base, hermesBase: base, fetchImpl: async (url, init) => url.pathname === '/api/status' ? response({ install_id: 'synthetic-install' }) : fetch(url, init) });
  assert.deepEqual((await f.inspect()).states, ['ready', 'incompatible', 'incompatible']);
  assert.equal(redirectedReads, 0); await f.unchanged();
});

for (const endpoint of ['/api/status', '/api/studio/sessions', '/api/sessions']) test(`already-followed response is rejected for ${endpoint}`, async t => {
  const f = await fixture(t, { fetchImpl: async url => url.pathname === endpoint
    ? ({ ok: true, status: 200, redirected: true, json: async () => ({ install_id: 'synthetic-install', sessions: [], data: [] }) } as any)
    : response({ install_id: 'synthetic-install', sessions: [], data: [] }) });
  const result = await f.inspect();
  assert.equal(result.states[endpoint === '/api/status' ? 0 : endpoint.startsWith('/api/studio') ? 1 : 2], 'incompatible');
});

// Exercise the default Bridge ping boundary rather than only the injected factory.
test('default Serve ping refuses a matching ID in an invalid JSON-RPC envelope', async t => {
  const OriginalWebSocket = globalThis.WebSocket;
  class SyntheticSocket extends EventTarget {
    constructor(_url: string | URL) {
      super();
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } }) })));
    }
    send(raw: string) {
      const frame = JSON.parse(raw);
      const result = frame.method === 'gateway.ping' ? { ok: true } : { sessions: [] };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: frame.method === 'gateway.ping' ? 'invalid' : '2.0', id: frame.id, result }) })));
    }
    close() { queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  globalThis.WebSocket = SyntheticSocket as any;
  t.after(() => { globalThis.WebSocket = OriginalWebSocket; });
  const f = await fixture(t, { useDefaultGateway: true });
  assert.equal((await f.inspect()).states[0], 'incompatible');
});

test('Studio provider timeout is bounded and never starts upstream reads', async t => {
  let providerReads = 0;
  const f = await fixture(t, { probeTimeoutMs: 500, tokenProvider: () => { providerReads++; return new Promise(() => {}); } });
  assert.equal((await f.inspect()).states[1], 'auth_missing');
  assert.equal(providerReads, 1);
  assert.equal(f.calls.some(({ url }) => url.pathname.startsWith('/api/studio/')), false);
});

// The adversarial transport keeps the body live while the production race still
// returns offline. The validator must distinguish that from actual cancellation.
async function unfinishedBodyFixture(t: any, discardSignal = false) {
  const observations = new Map<string, { signal?: AbortSignal; bodyStarted: boolean; aborted: boolean; closed: boolean; finished: boolean; closure: Promise<void> }>();
  let requests = 0;
  const upstream = createServer((req, res) => {
    requests++;
    const path = new URL(req.url!, 'http://synthetic').pathname;
    let resolveClose!: () => void;
    const closure = new Promise<void>(resolve => { resolveClose = resolve; });
    const observation = { bodyStarted: false, aborted: false, closed: false, finished: false, closure };
    observations.set(path, observation);
    res.on('finish', () => { observation.finished = true; });
    res.on('close', () => { observation.closed = true; observation.finished ||= res.writableFinished; f.trace.mark('upstream.close'); resolveClose(); });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{');
  });
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(upstream.address() as any).port}`;
  const f = await fixture(t, { probeTimeoutMs: 500, studioBase: base, hermesBase: base, fetchImpl: async (url, init) => {
    if (url.pathname === '/api/status') return response({ install_id: 'synthetic-install' });
    const result = await fetch(url, discardSignal ? { ...init, signal: undefined } : init);
    f.trace.mark('upstream.headers');
    const observation = observations.get(url.pathname)!;
    observation.signal = init.signal!;
    init.signal!.addEventListener('abort', () => { observation.aborted = true; }, { once: true });
    const json = result.json.bind(result);
    result.json = () => { observation.bodyStarted = true; f.trace.mark('upstream.body'); return json(); };
    return result;
  } });
  return { f, observations, requests: () => requests };
}

async function assertBodyCancelled(body: Awaited<ReturnType<typeof unfinishedBodyFixture>>) {
  await fixtureDeadline((async () => {
    assert.equal(body.requests(), 2);
    assert.deepEqual([...body.observations.keys()].sort(), ['/api/sessions', '/api/studio/sessions']);
    for (const row of body.observations.values()) {
      assert.equal(row.bodyStarted, true, 'the intended real body read started before timeout');
      assert.equal(row.signal?.aborted, true);
      assert.equal(row.aborted, true, 'the original signal aborted after body reading began');
    }
    // Remote close can arrive after the Bridge result. Await it before any fixture
    // cleanup; a good offline state alone cannot prove native transport cancelled.
    await Promise.all([...body.observations.values()].map(row => row.closure));
    for (const row of body.observations.values()) {
      assert.equal(row.closed, true);
      assert.equal(row.finished, false, 'the unfinished body was cancelled, not normally completed');
    }
  })(), body.f.trace);
}

test('body cancellation validator rejects a transport that discards the original abort signal before cleanup', async t => {
  const body = await unfinishedBodyFixture(t, true);
  assert.deepEqual((await body.f.inspect()).states, ['ready', 'offline', 'offline']);
  assert.equal(body.requests(), 2);
  await assert.rejects(assertBodyCancelled(body), { name: 'TimeoutError' });
  assert.equal([...body.observations.values()].filter(row => row.closed).length, 0);
  await body.f.unchanged();
});

test('real loopback response bodies are aborted at the detection deadline', async t => {
  const body = await unfinishedBodyFixture(t);
  const f = body.f;
  assert.deepEqual((await f.inspect()).states, ['ready', 'offline', 'offline']);
  assert.equal(body.requests(), 2); await f.unchanged();
  await assertBodyCancelled(body);
});

test('real client HTTP retains the unfinished body deadline and proves upstream cancellation before cleanup', async t => {
  const body = await unfinishedBodyFixture(t);
  assert.deepEqual((await body.f.inspectHTTP()).states, ['ready', 'offline', 'offline']);
  assert.equal(body.requests(), 2); await body.f.unchanged();
  await assertBodyCancelled(body);
});

test('each connection shares one deadline across all required reads', async t => {
  await withProbeClock(async clock => {
    const first = phaseBarrier(), second = phaseBarrier();
    const firstReads = new Set<string>(), secondReads = new Set<string>();
    let canonicalSignal: AbortSignal | undefined;
    const delay = async (value: unknown) => { await new Promise(resolve => setTimeout(resolve, 300)); return value; };
    const f = await fixture(t, {
      probeTimeoutMs: 500,
      fetchImpl: async (url, init) => {
        if (url.pathname === '/api/studio/sessions/hermes') {
          canonicalSignal = init.signal!; secondReads.add('canonical');
          if (secondReads.size === 2) second.arrive();
        } else { firstReads.add(url.pathname); if (firstReads.size === 3) first.arrive(); }
        return delay(response(url.pathname === '/api/status' ? { install_id: 'synthetic-install' } : { sessions: [], data: [] })) as Promise<Response>;
      },
      ping: () => { secondReads.add('ping'); if (secondReads.size === 2) second.arrive(); return delay({ ok: true }); },
    });
    let settled = false;
    const inspected = f.inspect();
    void inspected.then(() => { settled = true; }, () => { settled = true; });
    await first.wait(f.trace);
    assert.deepEqual([...firstReads].sort(), ['/api/sessions', '/api/status', '/api/studio/sessions']);
    clock.advanceTo(300);
    await second.wait(f.trace);
    assert.deepEqual([...secondReads].sort(), ['canonical', 'ping']);
    clock.advanceTo(499);
    assert.equal(settled, false); assert.equal(canonicalSignal?.aborted, false);
    clock.advanceTo(500);
    assert.equal(canonicalSignal?.aborted, true, 'canonical read uses the original shared 500ms deadline');
    assert.deepEqual((await inspected).states, ['offline', 'offline', 'ready']);
    assert.deepEqual(f.rpc, ['gateway.ping']);
    assert.ok(f.calls.some(({ url }) => url.pathname === '/api/studio/sessions/hermes'));
    assert.equal(f.closed(), 1); await f.unchanged();
  });
});

test('default Serve ping socket closes when its overall inspection deadline expires', async t => {
  const OriginalWebSocket = globalThis.WebSocket;
  let closes = 0;
  class SyntheticSocket extends EventTarget {
    constructor(_url: string | URL) {
      super();
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready' } }) })));
    }
    send(_raw: string) {}
    close() { closes++; queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  globalThis.WebSocket = SyntheticSocket as any;
  t.after(() => { globalThis.WebSocket = OriginalWebSocket; });
  const f = await fixture(t, { probeTimeoutMs: 500, useDefaultGateway: true });
  assert.equal((await f.inspect()).states[0], 'offline');
  assert.equal(closes, 1);
});

test('Studio detection reads only its configured token file through existing load authority', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'unified-studio-token-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, STUDIO);
  const previous = process.env.HERMES_STUDIO_TOKEN_FILE;
  process.env.HERMES_STUDIO_TOKEN_FILE = tokenFile;
  t.after(async () => {
    if (previous === undefined) delete process.env.HERMES_STUDIO_TOKEN_FILE; else process.env.HERMES_STUDIO_TOKEN_FILE = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const f = await fixture(t, { studioToken: null });
  assert.equal((await f.inspect()).states[1], 'ready');
  const studioReads = f.calls.filter(({ url }) => url.pathname.startsWith('/api/studio/'));
  assert.equal(studioReads.length, 2);
  for (const { init } of studioReads) assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${STUDIO}`);
  assert.equal(await readFile(tokenFile, 'utf8'), STUDIO);
});

// Expected list rows are explicit independent fixtures. The real adapter keeps
// index-first metadata and never supplies profile to unknown canonical rows.
const studioMergeCases = [
  { name: 'missing canonical profile is established by exact index ID', index: [{ id: 'known', profile: 'default', title: 'index title' }], canonical: [{ id: 'known', title: 'canonical title' }], state: 'ready', visible: [['known', 'default', 'index title']] },
  { name: 'a known other-profile canonical row stays excluded', index: [{ id: 'hidden', profile: 'other' }, { id: 'visible', profile: 'default' }], canonical: [{ id: 'hidden' }], state: 'ready', visible: [['visible', 'default', '']] },
  { name: 'explicit canonical profiles preserve default-only filtering', index: [{ id: 'known', profile: 'default', title: 'index title' }], canonical: [{ id: 'known', profile: 'default', title: 'other title' }, { id: 'new', profile: 'default', title: 'canonical new' }, { id: 'hidden', profile: 'other' }], state: 'ready', visible: [['known', 'default', 'index title'], ['new', 'default', 'canonical new']] },
  { name: 'complete empty lists need no inferred profile or paging fields', index: [], canonical: [], state: 'ready', visible: [] },
  { name: 'an unknown canonical ID without profile is not assigned default even when titles match', index: [{ id: 'known', profile: 'default', title: 'Same title' }], canonical: [{ id: 'unknown', title: 'Same title' }], state: 'ready', visible: [['known', 'default', 'Same title']] },
  { name: 'an explicit contradictory canonical profile is refused', index: [{ id: 'known', profile: 'default' }], canonical: [{ id: 'known', profile: 'other' }], state: 'incompatible', visible: [['known', 'default', '']] },
  { name: 'index other-profile evidence cannot be replaced by canonical default', index: [{ id: 'known', profile: 'other' }], canonical: [{ id: 'known', profile: 'default' }], state: 'incompatible', visible: [] },
  { name: 'explicit null profile differs from an absent profile', index: [{ id: 'known', profile: 'default' }], canonical: [{ id: 'known', profile: null }], state: 'incompatible', visible: [['known', 'default', '']] },
  { name: 'explicit empty profile differs from an absent profile', index: [{ id: 'known', profile: 'default' }], canonical: [{ id: 'known', profile: '' }], state: 'incompatible', visible: [['known', 'default', '']] },
  { name: 'numeric canonical profile is malformed', index: [{ id: 'known', profile: 'default' }], canonical: [{ id: 'known', profile: 2 }], state: 'incompatible', visible: [['known', 'default', '']] },
  { name: 'index missing profile cannot establish canonical ownership', probeCanonical: false, index: [{ id: 'known' }], canonical: [{ id: 'known' }], state: 'incompatible', visible: [] },
  { name: 'conflicting duplicate index profiles do not establish ownership', probeCanonical: false, index: [{ id: 'known', profile: 'default' }, { id: 'known', profile: 'other' }], canonical: [{ id: 'known', profile: 'default' }], state: 'incompatible', visible: [['known', 'default', '']] },
  { name: 'conflicting canonical-only duplicates are refused', index: [], canonical: [{ id: 'new', profile: 'default' }, { id: 'new', profile: 'other' }], state: 'incompatible', visible: [['new', 'default', '']] },
];

for (const example of studioMergeCases) test(`Studio merge contract: ${example.name}`, async t => {
  const f = await fixture(t, { fetchImpl: async url => {
    if (url.pathname === '/api/status') return response({ install_id: 'synthetic-install' });
    if (url.pathname === '/api/studio/sessions') return response({ sessions: example.index });
    if (url.pathname === '/api/studio/sessions/hermes') return response({ sessions: example.canonical });
    return response({ data: [] });
  } });
  const detection = await f.inspect();
  // Verify the production reading path even when diagnostic validation refuses
  // ambiguous metadata; it must still never invent default-profile ownership.
  const listed = await f.readStudio();
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.map((row: any) => [row.id, row.profile, row.title]), example.visible);
  assert.equal(detection.states[1], example.state);
  assert.equal(detection.body.data[1].profile, 'default');
  assert.equal(detection.body.data[1].installId, null);
  const reads = f.calls.filter(({ url }) => url.pathname.startsWith('/api/studio/'));
  assert.deepEqual(reads.map(({ url }) => url.pathname + url.search), [
    '/api/studio/sessions', '/api/studio/sessions/hermes?offset=0&limit=1',
    '/api/studio/sessions', '/api/studio/sessions/hermes?offset=0&limit=200',
  ].filter((_, position) => 'probeCanonical' in example && example.probeCanonical === false ? position !== 1 : true));
  for (const { url, init } of f.calls) {
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.body, undefined);
    assert.ok(['/api/status', '/api/sessions', '/api/studio/sessions', '/api/studio/sessions/hermes'].includes(url.pathname));
  }
  for (const { init } of reads) assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${STUDIO}`);
  // Detection enforces manual redirects. The existing list adapter is outside
  // this fix and uses fetch's default GET/redirect settings on successful reads.
  for (const { url, init } of reads.filter(({ init }) => init.signal)) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.ok(url.pathname === '/api/studio/sessions' || url.pathname === '/api/studio/sessions/hermes');
  }
  for (const privateValue of [STUDIO, LEGACY, SERVE, f.dir, 'index title', 'canonical title']) assert.equal(JSON.stringify(detection.body).includes(privateValue), false);
  await f.unchanged();
});

for (const omitProfile of [false, true]) for (const paging of [{ hasMore: null }, { offset: null }, { limit: null }, { hasMore: false, offset: 1, limit: 1 }, { hasMore: false, offset: '0', limit: '1' }, { hasMore: true, offset: 0, limit: 0 }]) test(`Studio omitted-profile=${omitProfile} read rejects malformed paging ${JSON.stringify(paging)}`, async t => {
  const f = await fixture(t, { fetchImpl: async url => url.pathname === '/api/status' ? response({ install_id: 'synthetic-install' })
    : url.pathname === '/api/studio/sessions' ? response({ sessions: [{ id: 'known', profile: 'default' }] })
    : url.pathname === '/api/studio/sessions/hermes' ? response({ sessions: [omitProfile ? { id: 'known' } : { id: 'known', profile: 'default' }], ...paging }) : response({ data: [] }) });
  assert.equal((await f.inspect()).states[1], 'incompatible');
  await f.unchanged();
});

test('Studio omitted-profile read preserves real adapter paging and default-only ownership', async t => {
  const f = await fixture(t, { fetchImpl: async url => {
    if (url.pathname === '/api/status') return response({ install_id: 'synthetic-install' });
    if (url.pathname === '/api/studio/sessions') return response({ sessions: [{ id: 'known', profile: 'default', title: 'Index' }] });
    if (url.pathname !== '/api/studio/sessions/hermes') return response({ data: [] });
    const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
    return response(offset === 0 ? { sessions: [{ id: 'known' }], hasMore: true, offset, limit }
      : { sessions: [{ id: 'later', profile: 'default', title: 'Later' }, { id: 'unknown-later' }, { id: 'hidden', profile: 'other' }], hasMore: false, offset, limit });
  } });
  const detected = await f.inspect();
  const listed = await f.readStudio();
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data.map((row: any) => [row.id, row.profile, row.title]), [['known', 'default', 'Index'], ['later', 'default', 'Later']]);
  assert.equal(detected.states[1], 'ready');
  assert.equal(detected.body.data[1].readWarning, undefined, 'sample does not claim later-page evidence');
  assert.equal(listed.body.readWarning, 'studio_sessions_unresolved');
  assert.deepEqual(f.calls.filter(({ url }) => url.pathname.endsWith('/hermes')).map(({ url }) => url.search), ['?offset=0&limit=1', '?offset=0&limit=200', '?offset=200&limit=200']);
  await f.unchanged();
});

test('Studio omitted-profile evidence is scoped to the current detection rather than reused from a previous index', async t => {
  let known = true;
  const f = await fixture(t, { fetchImpl: async url => url.pathname === '/api/status' ? response({ install_id: 'synthetic-install' })
    : url.pathname === '/api/studio/sessions' ? response({ sessions: known ? [{ id: 'known', profile: 'default' }] : [] })
    : url.pathname === '/api/studio/sessions/hermes' ? response({ sessions: [{ id: 'known' }] }) : response({ data: [] }) });
  assert.equal((await f.inspect()).states[1], 'ready');
  known = false;
  // Unknown rows no longer disable verified service reads; they remain unowned.
  const refreshed = await f.inspect();
  assert.equal(refreshed.states[1], 'ready');
  assert.equal(refreshed.body.data[1].readWarning, 'studio_sessions_unresolved');
  assert.deepEqual((await f.readStudio()).body.data, []);
  await f.unchanged();
});

test('Studio omitted-profile inspection keeps one budget across index and canonical body', async t => {
  await withProbeClock(async clock => {
    const first = phaseBarrier(), canonical = phaseBarrier();
    let canonicalSignal: AbortSignal | undefined;
    const f = await fixture(t, { probeTimeoutMs: 500, fetchImpl: async (url, init) => {
      if (!url.pathname.startsWith('/api/studio/')) return response(url.pathname === '/api/status' ? { install_id: 'synthetic-install' } : { data: [] });
      if (url.pathname === '/api/studio/sessions') first.arrive();
      else { canonicalSignal = init.signal!; canonical.arrive(); }
      await new Promise(resolve => setTimeout(resolve, 300));
      return response({ sessions: url.pathname === '/api/studio/sessions' ? [{ id: 'known', profile: 'default' }] : [{ id: 'known' }] });
    } });
    const started = performance.now();
    let settled = false;
    const inspected = f.inspect();
    void inspected.then(() => { settled = true; }, () => { settled = true; });
    await first.wait(f.trace);
    clock.advanceTo(300);
    await canonical.wait(f.trace);
    clock.advanceTo(499);
    assert.equal(settled, false); assert.equal(canonicalSignal?.aborted, false);
    clock.advanceTo(500);
    assert.equal(canonicalSignal?.aborted, true, 'canonical body uses the original shared 500ms deadline');
    assert.equal((await inspected).states[1], 'offline');
    assert.ok(f.calls.some(({ url }) => url.pathname === '/api/studio/sessions/hermes'), 'canonical read started before the shared deadline expired');
    assert.ok(performance.now() - started < 1000);
    await f.unchanged();
  });
});


test('HTTP watchdog observer detaches after real successful inspection before late abort', async t => {
  const f = await fixture(t); const controller = new AbortController(); const original = AbortSignal.timeout;
  AbortSignal.timeout = ms => { assert.equal(ms, 1500); return controller.signal; };
  try {
    const result = await fixtureDeadline(f.inspectHTTP(), f.trace); assert.equal(result.status, 200); assert.deepEqual(result.states, ['ready', 'ready', 'ready']);
    assert.equal(f.trace.snapshot().events.filter(row => row.phase === 'watchdog.timeout').length, 0);
    controller.abort(new DOMException('Synthetic late watchdog', 'TimeoutError'));
    assert.equal(f.trace.snapshot().events.filter(row => row.phase === 'watchdog.timeout').length, 0, 'a completed request cannot append a later timeout to its shared trace');
    await f.unchanged();
  } finally { AbortSignal.timeout = original; controller.abort(); }
});

test('HTTP watchdog observer still records an abort while the real request is incomplete', async t => {
  const f = await fixture(t); const entered = phaseBarrier(); f.server.removeAllListeners('request'); f.server.on('request', () => entered.arrive());
  const controller = new AbortController(), original = AbortSignal.timeout;
  AbortSignal.timeout = ms => { assert.equal(ms, 1500); return controller.signal; };
  let rejected: Promise<void> | undefined;
  try {
    rejected = assert.rejects(f.inspectHTTP(), (error: any) => {
      assert.equal(error.name, 'TimeoutError'); assert.equal(error.fixturePhases.events.filter((row: any) => row.phase === 'watchdog.timeout').length, 1); return true;
    });
    void rejected.catch(() => {}); await entered.wait(f.trace);
    controller.abort(new DOMException('Synthetic active watchdog', 'TimeoutError')); await rejected;
    assert.equal(f.trace.snapshot().events.filter(row => row.phase === 'watchdog.timeout').length, 1); await f.unchanged();
  } finally { AbortSignal.timeout = original; controller.abort(new DOMException('Synthetic cleanup watchdog', 'TimeoutError')); if (rejected) await rejected; }
});
