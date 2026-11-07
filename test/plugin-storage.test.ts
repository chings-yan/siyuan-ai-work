import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { CheckedPluginStorage } from '../src/work/plugin-storage.ts';
import { AnswerAdoptionController, type AdoptionNative, type AdoptionSource, type AdoptionTarget } from '../src/work/answer-adoption.ts';
import { WorkStore } from '../src/work/store.ts';

const ROOT = '/data/storage/petal/siyuan-ai-collab/';
const KEY = 'answer-adoption-v1-operation-fixture';
const VALUE = { schema: 1, state: 'unknown', nested: { message: '虚构记录', ids: ['one', 'two'] } };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const ack = () => json({ code: 0, msg: '', data: null });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function kernel() {
  const files = new Map<string, string>();
  const calls: { url: string; init: RequestInit }[] = [];
  const request = (async (input, init) => {
    const url = String(input); calls.push({ url, init: init! });
    if (url === '/api/file/putFile') {
      const form = init!.body as FormData;
      files.set(String(form.get('path')), await (form.get('file') as Blob).text());
      return ack();
    }
    assert.equal(url, '/api/file/getFile');
    const path = JSON.parse(String(init!.body)).path;
    return files.has(path) ? new Response(files.get(path)) : json({ code: 404, msg: 'fictional missing', data: null }, 202);
  }) as typeof fetch;
  return { files, calls, request };
}
function timed<T>(value: Promise<T>) {
  return assert.rejects(value, error => {
    assert.ok(error instanceof Error);
    assert.doesNotMatch(error.message, /fictional-private|petal|\/data|raw-kernel/);
    return true;
  });
}

test('successful disk save verifies exact JSON and survives a new adapter instance', async () => {
  const k = kernel(), notices: unknown[] = [];
  const port = new CheckedPluginStorage({ request: k.request, onSaved: (key, value) => notices.push({ key, value }) });
  assert.equal(await port.loadData(KEY), undefined);
  await port.saveData(KEY, VALUE);
  assert.equal(k.calls.filter(call => call.url === '/api/file/putFile').length, 1);
  assert.equal(k.calls.filter(call => call.url === '/api/file/getFile').length, 2);
  assert.deepEqual(notices, [{ key: KEY, value: VALUE }]);
  assert.deepEqual(await new CheckedPluginStorage({ request: k.request }).loadData(KEY), VALUE);
  await port.saveData(KEY, 'fictional-operation-id');
  assert.equal(k.files.get(ROOT + KEY), '"fictional-operation-id"');
  assert.equal(await new CheckedPluginStorage({ request: k.request }).loadData(KEY), 'fictional-operation-id');
});

test('requests bind the fixed plugin directory and optional app without supplying credentials', async () => {
  const k = kernel(); let appReads = 0;
  const port = new CheckedPluginStorage({ request: k.request, appId: () => { appReads++; return 'fictional-app'; } });
  await port.saveData(KEY, VALUE);
  assert.equal(appReads, 1);
  for (const call of k.calls) {
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.cache, 'no-store');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.mode, 'same-origin');
    assert.equal(call.init.credentials, 'same-origin');
    assert.ok(call.init.signal instanceof AbortSignal);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
  }
  const form = k.calls[0].init.body as FormData;
  assert.deepEqual([...form.keys()].sort(), ['app', 'file', 'isDir', 'path']);
  assert.equal(form.get('path'), ROOT + KEY);
  assert.equal(form.get('isDir'), 'false');
  assert.equal(form.get('app'), 'fictional-app');
  const file = form.get('file') as File;
  assert.equal(file.type, 'application/json');
  assert.equal(file.name, KEY);
  assert.deepEqual(JSON.parse(await file.text()), VALUE);
  assert.deepEqual(JSON.parse(String(k.calls[1].init.body)), { path: ROOT + KEY });
  assert.equal(new Headers(k.calls[1].init.headers).get('content-type'), 'application/json');
  assert.equal(new Headers(k.calls[0].init.headers).has('content-type'), false);
  assert.equal(k.calls[0].init.signal, k.calls[1].init.signal);
});

test('the default fetch closure keeps the browser receiver and reads the current global fetch', async () => {
  const original = globalThis.fetch, k = kernel();
  try {
    const port = new CheckedPluginStorage();
    globalThis.fetch = function (this: typeof globalThis, input, init) {
      assert.equal(this, globalThis);
      return k.request(input, init);
    } as typeof fetch;
    await port.saveData(KEY, VALUE);
    assert.deepEqual(await port.loadData(KEY), VALUE);
  } finally { globalThis.fetch = original; }
});

test('only explicit HTTP 202 or 404 with numeric code 404 means a missing file', async t => {
  for (const status of [202, 404]) await t.test(String(status), async () => {
    const port = new CheckedPluginStorage({ request: async () => json({ code: 404, msg: 'fictional-private-path', data: null }, status) });
    assert.equal(await port.loadData(KEY), undefined);
  });
});

test('read failures, empty files and API envelopes never become a missing file', async t => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ['network failure', () => Promise.reject(new Error('fictional-private-path raw-kernel'))],
    ['HTTP 500', () => json({ code: 404 }, 500)],
    ['HTTP 201', () => json(VALUE, 201)],
    ['HTTP 204', () => new Response(null, { status: 204 })],
    ['HTTP 202 forbidden', () => json({ code: 403, msg: 'fictional-private-path' }, 202)],
    ['HTTP 404 untyped', () => json({ error: 'missing' }, 404)],
    ['HTTP 404 string code', () => json({ code: '404' }, 404)],
    ['HTTP 200 error envelope', () => json({ code: 404, msg: 'fictional-private-path' })],
    ['HTTP 200 success envelope', () => json({ code: 0, msg: '', data: VALUE })],
    ['empty body', () => new Response('')],
    ['whitespace body', () => new Response('  \n')],
    ['invalid JSON', () => new Response('{fictional-private-path}')],
    ['HTML login page', () => new Response('<html>fictional-private-path</html>')],
    ['HTTP redirect', () => new Response(null, { status: 302 })],
    ['already redirected', () => { const r = json(VALUE); Object.defineProperty(r, 'redirected', { value: true }); return r; }],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    await timed(new CheckedPluginStorage({ request: async () => response() }).loadData(KEY));
  });
});

test('every read consults disk and cannot fall back to a successful prior value', async () => {
  const k = kernel(), port = new CheckedPluginStorage({ request: k.request });
  await port.saveData(KEY, VALUE);
  const changed = { schema: 1, state: 'complete' };
  k.files.set(ROOT + KEY, JSON.stringify(changed));
  assert.deepEqual(await port.loadData(KEY), changed);
  k.files.set(ROOT + KEY, '{corrupt disk record');
  await assert.rejects(port.loadData(KEY));
  k.files.delete(ROOT + KEY);
  assert.equal(await port.loadData(KEY), undefined);
});

test('fulfilled put errors cannot announce a save or issue readback', async t => {
  for (const code of [-3, -1, 400, 403, 404, '0', undefined]) await t.test(String(code), async () => {
    let calls = 0, saved = 0;
    const port = new CheckedPluginStorage({ request: async () => { calls++; return json({ code, msg: 'fictional-private-path raw-kernel' }); }, onSaved: () => { saved++; } });
    await timed(port.saveData(KEY, VALUE));
    assert.equal(calls, 1);
    assert.equal(saved, 0);
    await assert.rejects(port.saveData(KEY, VALUE));
    assert.equal(calls, 1, 'an unverified write must not be overwritten');
  });
});

test('put requires HTTP 200 and a valid zero-code JSON envelope', async t => {
  const cases: [string, () => Response][] = [
    ['202 zero', () => json({ code: 0 }, 202)], ['201 zero', () => json({ code: 0 }, 201)],
    ['500 zero', () => json({ code: 0 }, 500)], ['empty', () => new Response('')],
    ['invalid', () => new Response('{bad')], ['string', () => json('ok')],
    ['array', () => json([{ code: 0 }])],
    ['redirected', () => { const r = ack(); Object.defineProperty(r, 'redirected', { value: true }); return r; }],
  ];
  for (const [name, response] of cases) await t.test(name, async () => {
    let calls = 0;
    await assert.rejects(new CheckedPluginStorage({ request: async () => { calls++; return response(); } }).saveData(KEY, VALUE));
    assert.equal(calls, 1);
  });
});

test('save checks the whole readback structurally, including key sets, array order and types', async t => {
  const mismatches = [undefined, { ...VALUE, extra: true }, { schema: 1, state: 'unknown' },
    { ...VALUE, schema: '1' }, { ...VALUE, nested: { message: '虚构记录', ids: ['two', 'one'] } }];
  for (const [index, value] of mismatches.entries()) await t.test(String(index), async () => {
    let calls = 0, saved = 0;
    const port = new CheckedPluginStorage({ request: async () => ++calls === 1 ? ack() : value === undefined ? json({ code: 404 }, 202) : json(value), onSaved: () => { saved++; } });
    await assert.rejects(port.saveData(KEY, VALUE));
    assert.equal(calls, 2); assert.equal(saved, 0);
    await assert.rejects(port.saveData(KEY, VALUE));
    assert.equal(calls, 2);
  });
  let calls = 0;
  const reordered = { nested: { ids: ['one', 'two'], message: '虚构记录' }, state: 'unknown', schema: 1 };
  await new CheckedPluginStorage({ request: async () => ++calls === 1 ? ack() : json(reordered) }).saveData(KEY, VALUE);
  assert.equal(calls, 2, 'object property order is immaterial');
});

test('safe Windows filenames are checked before any request', async () => {
  let calls = 0;
  const port = new CheckedPluginStorage({ request: async () => { calls++; return json({ code: 404 }, 202); } });
  for (const key of ['', 'unsafe:key', '../other', 'some/file', 'some\\file', 'name.json', 'a b', 'A', 'é', 'a'.repeat(161), 'nul', 'con', 'prn', 'aux', 'com1', 'lpt9']) {
    await assert.rejects(port.loadData(key));
    await assert.rejects(port.saveData(key, VALUE));
  }
  assert.equal(calls, 0);
  assert.equal(await port.loadData('a'.repeat(160)), undefined);
  assert.equal(await port.loadData('work-pending-v1_2'), undefined);
});

test('save freezes its own deep snapshot before its first await', async () => {
  const k = kernel(), gate = deferred<Response>(), entered = deferred<void>();
  let puts = 0; const notices: unknown[] = [];
  const port = new CheckedPluginStorage({ request: async (input, init) => {
    if (String(input) === '/api/file/putFile') { puts++; entered.resolve(); await gate.promise; }
    return k.request(input, init);
  }, onSaved: (_key, value) => notices.push(value) });
  const value = structuredClone(VALUE), saving = port.saveData(KEY, value);
  await entered.promise;
  value.nested.message = 'later caller edit'; value.nested.ids.push('three');
  await assert.rejects(port.saveData(KEY, value));
  assert.equal(puts, 1, 'an in-flight write also excludes a second write');
  gate.resolve(ack()); await saving;
  assert.deepEqual(JSON.parse(k.files.get(ROOT + KEY)!), VALUE);
  assert.deepEqual(notices, [VALUE]);
  assert.ok(Object.isFrozen(notices[0]));
  assert.ok(Object.isFrozen((notices[0] as typeof VALUE).nested));
  assert.ok(Object.isFrozen((notices[0] as typeof VALUE).nested.ids));
});

test('unsupported, cyclic or lossy JSON values cannot start a write', async () => {
  let calls = 0;
  const port = new CheckedPluginStorage({ request: async () => { calls++; return ack(); } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [undefined, { missing: undefined }, { bad: NaN }, { bad: Infinity }, { bad: 1n }, { bad: () => 1 }, cycle, { code: 0, data: VALUE }]) {
    await assert.rejects(port.saveData(KEY, value));
  }
  assert.equal(calls, 0);
});

test('hanging fetch ignores abort yet load and save still settle and abort', { timeout: 2000 }, async () => {
  for (const saving of [false, true]) {
    let signal: AbortSignal | null | undefined;
    const port = new CheckedPluginStorage({ timeoutMs: 25, request: async (_input, init) => { signal = init!.signal; return new Promise<Response>(() => {}); } });
    const start = performance.now();
    await assert.rejects(saving ? port.saveData(KEY, VALUE) : port.loadData(KEY));
    assert.ok(performance.now() - start < 500);
    assert.equal(signal?.aborted, true);
  }
});

test('late put headers after timeout cannot start readback or unlock the key', { timeout: 2000 }, async () => {
  const gate = deferred<Response>(); let calls = 0, saved = 0;
  const port = new CheckedPluginStorage({ timeoutMs: 25, request: async () => { calls++; return gate.promise; }, onSaved: () => { saved++; } });
  await assert.rejects(port.saveData(KEY, VALUE));
  gate.resolve(ack()); await setImmediate();
  assert.equal(calls, 1); assert.equal(saved, 0);
  await assert.rejects(port.saveData(KEY, VALUE));
  assert.equal(calls, 1);
});

test('hung or late bodies cannot outlive the operation or cause a later request', { timeout: 2000 }, async t => {
  for (const stage of ['load', 'put', 'readback']) await t.test(stage, async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>, calls = 0, saved = 0;
    let signal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel() { return new Promise(() => {}); } });
    const port = new CheckedPluginStorage({ timeoutMs: 25, request: async (_input, init) => {
      calls++; signal = init!.signal;
      return stage === 'readback' && calls === 1 ? ack() : new Response(body);
    }, onSaved: () => { saved++; } });
    await assert.rejects(stage === 'load' ? port.loadData(KEY) : port.saveData(KEY, VALUE));
    assert.equal(signal?.aborted, true);
    try { controller.enqueue(new TextEncoder().encode(JSON.stringify(stage === 'put' ? { code: 0 } : VALUE))); controller.close(); } catch { /* cancellation may close the stream */ }
    await setImmediate();
    assert.equal(calls, stage === 'readback' ? 2 : 1); assert.equal(saved, 0);
    if (stage !== 'load') { await assert.rejects(port.saveData(KEY, VALUE)); assert.equal(calls, stage === 'readback' ? 2 : 1); }
  });
});

test('put and readback share one deadline instead of receiving fresh timeout windows', { timeout: 2000 }, async () => {
  let calls = 0, signal: AbortSignal | null | undefined;
  const port = new CheckedPluginStorage({ timeoutMs: 80, request: async (_input, init) => {
    calls++; signal = init!.signal;
    await new Promise(resolve => setTimeout(resolve, 55));
    return calls === 1 ? ack() : json(VALUE);
  } });
  const start = performance.now();
  await assert.rejects(port.saveData(KEY, VALUE));
  assert.ok(performance.now() - start < 500);
  assert.equal(signal?.aborted, true);
});

test('a synchronous parse that spends the deadline cannot start a readback', async () => {
  const original = JSON.parse; let calls = 0, signal: AbortSignal | null | undefined;
  const text = '{"code":0,"msg":"fictional-slow-parse","data":null}';
  JSON.parse = ((input: string, reviver?: any) => {
    if (input === text) { const end = performance.now() + 45; while (performance.now() < end) { /* model a blocked parser */ } }
    return original(input, reviver);
  }) as typeof JSON.parse;
  try {
    const port = new CheckedPluginStorage({ timeoutMs: 20, request: async (_input, init) => { calls++; signal = init!.signal; return new Response(text); } });
    await assert.rejects(port.saveData(KEY, VALUE));
    assert.equal(calls, 1); assert.equal(signal?.aborted, true);
  } finally { JSON.parse = original; }
});

test('JSON parsing also has a bounded work budget within a longer operation deadline', async () => {
  const original = JSON.parse; let calls = 0;
  const text = '{"code":0,"msg":"fictional-expensive-json","data":null}';
  JSON.parse = ((input: string, reviver?: any) => {
    if (input === text) { const end = performance.now() + 120; while (performance.now() < end) { /* bounded parser overrun */ } }
    return original(input, reviver);
  }) as typeof JSON.parse;
  try {
    const port = new CheckedPluginStorage({ timeoutMs: 1000, request: async () => ++calls === 1 ? new Response(text) : json(VALUE) });
    await assert.rejects(port.saveData(KEY, VALUE));
    assert.equal(calls, 1);
  } finally { JSON.parse = original; }
});

test('unknown writes remain quarantined after later successful reads, but other keys remain usable', async () => {
  const k = kernel(); let first = true;
  const port = new CheckedPluginStorage({ request: async (input, init) => {
    const response = await k.request(input, init);
    if (first) { first = false; throw new Error('fictional response lost'); }
    return response;
  } });
  await assert.rejects(port.saveData(KEY, VALUE));
  assert.deepEqual(await port.loadData(KEY), VALUE);
  const before = k.calls.length;
  await assert.rejects(port.saveData(KEY, { state: 'complete' }));
  assert.equal(k.calls.length, before);
  await port.saveData('other-safe-key', VALUE);
  assert.deepEqual(await port.loadData('other-safe-key'), VALUE);
});

test('oversized stored bodies and writes fail before parsing or making another request', async () => {
  const size = 8 * 1024 * 1024;
  const announced = new Response(new ReadableStream(), { headers: { 'content-length': String(size + 1) } });
  await assert.rejects(new CheckedPluginStorage({ request: async () => announced }).loadData(KEY));
  const oversized = new Uint8Array(size + 1).fill(32);
  await assert.rejects(new CheckedPluginStorage({ request: async () => new Response(oversized) }).loadData(KEY));
  let calls = 0;
  await assert.rejects(new CheckedPluginStorage({ request: async () => { calls++; return ack(); } }).saveData(KEY, { large: 'x'.repeat(size) }));
  assert.equal(calls, 0);
});

test('app identity failure is pre-submit and does not quarantine a key', async () => {
  const k = kernel(); let identityReady = false;
  const port = new CheckedPluginStorage({ request: k.request, appId: () => {
    if (!identityReady) throw new Error('fictional-private-app-identity');
    return 'fictional-app';
  } });
  await timed(port.saveData(KEY, VALUE)); assert.equal(k.calls.length, 0);
  assert.equal(await port.loadData(KEY), undefined, 'reads never ask for app identity');
  identityReady = true;
  await port.saveData(KEY, VALUE);
  assert.deepEqual(await port.loadData(KEY), VALUE);
});

test('a failed or corrupt readback after a zero-code put cannot report persistence', async t => {
  const cases: [string, () => Response | Promise<Response>][] = [
    ['read failure', () => Promise.reject(new Error('fictional-private-path'))],
    ['HTTP error', () => json({ code: 500 }, 500)],
    ['invalid JSON', () => new Response('{damaged')],
    ['missing', () => json({ code: 404 }, 404)],
    ['API envelope', () => json({ code: 0, data: VALUE })],
  ];
  for (const [name, result] of cases) await t.test(name, async () => {
    let calls = 0, notices = 0;
    const port = new CheckedPluginStorage({ request: async () => ++calls === 1 ? ack() : result(), onSaved: () => { notices++; } });
    await timed(port.saveData(KEY, VALUE));
    assert.equal(calls, 2); assert.equal(notices, 0);
    await assert.rejects(port.saveData(KEY, VALUE)); assert.equal(calls, 2);
  });
});

test('unusable timeout settings cannot silently disable the deadline', () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 2_147_483_648]) assert.throws(() => new CheckedPluginStorage({ timeoutMs }));
});

function adoption(request: typeof fetch) {
  let nativeWrites = 0, legacyCalls = 0;
  const storage = new CheckedPluginStorage({ request });
  const store = new WorkStore({ loadData: () => { legacyCalls++; throw new Error('legacy cache must not supply evidence'); }, saveData: () => { legacyCalls++; throw new Error('legacy port must not save'); } });
  const source: AdoptionSource = { conversationKey: 'fictional-connection/session/profile', messageId: 'fictional-message', role: 'assistant', complete: true, content: '虚构待采纳正文', documentId: '20990101000000-aaaaaaa' };
  const target: AdoptionTarget = { kind: 'append', documentId: source.documentId, title: '虚构目标' };
  const native: AdoptionNative = {
    prepare: async (content, destination, operationId) => ({ operationId, target: destination, preview: content, dom: 'fixture-dom', markdown: 'fixture-md',
      proof: { canonicalDigest: 'a'.repeat(64), topIds: ['20990101000001-bbbbbbb'], blocks: [{ id: '20990101000001-bbbbbbb', ids: ['20990101000001-bbbbbbb'], digest: 'a'.repeat(64) }],
        root: { rootID: source.documentId, box: '20990101000002-ccccccc', path: `/${source.documentId}.sy` } } }),
    checkTarget: async () => {}, write: async () => { nativeWrites++; return { rootId: source.documentId }; }, verify: async () => ({ rootId: source.documentId }),
  };
  const controller = new AnswerAdoptionController({ storage, pendingStore: store.pendingPort(storage), native, isCurrent: () => true });
  return { storage, store, source, target, native, controller, writes: () => nativeWrites, legacyCalls: () => legacyCalls };
}

test('actual adoption controller and shared pending port stop before native write on strict storage failures', async t => {
  for (const failure of ['ledger-put', 'ledger-readback', 'pending-put', 'pending-readback', 'pointer-put', 'initial-read']) await t.test(failure, async () => {
    const k = kernel(); let faulted = false;
    const f = adoption(async (input, init) => {
      const writing = String(input) === '/api/file/putFile';
      const path = writing ? String((init!.body as FormData).get('path')) : JSON.parse(String(init!.body)).path as string;
      const pending = path === ROOT + 'work-pending-v1';
      const ledger = path.startsWith(ROOT + 'answer-adoption-v1-operation-');
      const pointer = path.startsWith(ROOT + 'answer-adoption-v1-source-');
      if ((failure === 'initial-read' && !writing) || (failure === 'ledger-put' && writing && ledger)
        || (failure === 'pending-put' && writing && pending) || (failure === 'pointer-put' && writing && pointer)) {
        faulted = true; return json({ code: 400, msg: 'fictional-private-error', data: null });
      }
      if (!writing && k.files.has(path) && ((failure === 'ledger-readback' && ledger) || (failure === 'pending-readback' && pending))) {
        faulted = true; throw new Error('fictional-private-read-error');
      }
      return k.request(input, init);
    });
    if (failure === 'initial-read') await assert.rejects(f.controller.prepare(f.source, f.target));
    else {
      const preview = await f.controller.prepare(f.source, f.target);
      await assert.rejects(f.controller.commit(preview));
    }
    assert.equal(faulted, true, 'the failing disk API stage was reached');
    assert.equal(f.writes(), 0);
    assert.equal(f.legacyCalls(), 0, 'legacy cached storage cannot satisfy the strict workflow');
  });
});

test('actual adoption persists its ledger and pending fence before one native write and deduplicates after reload', async () => {
  const k = kernel(), f = adoption(k.request);
  const originalWrite = f.native.write;
  f.native.write = async plan => {
    const pending = JSON.parse(k.files.get(ROOT + 'work-pending-v1')!);
    assert.equal(pending.items.length, 1);
    const ledger = JSON.parse(k.files.get(ROOT + 'answer-adoption-v1-operation-' + plan.operationId)!);
    assert.equal(ledger.state, 'unknown');
    assert.equal(ledger.pending.id, pending.items[0].id);
    assert.ok([...k.files.keys()].some(path => path.startsWith(ROOT + 'answer-adoption-v1-source-')));
    return originalWrite(plan);
  };
  const preview = await f.controller.prepare(f.source, f.target);
  assert.equal((await f.controller.commit(preview)).state, 'complete');
  assert.equal(f.writes(), 1); assert.equal(f.legacyCalls(), 0);
  assert.deepEqual(JSON.parse(k.files.get(ROOT + 'work-pending-v1')!).items, []);
  const reloaded = adoption(k.request);
  await assert.rejects(reloaded.controller.prepare({ ...f.source, messageId: undefined }, f.target), /已采纳/);
  assert.equal(reloaded.writes(), 0); assert.equal(reloaded.legacyCalls(), 0);
});
