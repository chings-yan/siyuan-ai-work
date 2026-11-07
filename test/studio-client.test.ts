import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error runtime ESM helper has no declaration
import { normalizeStudioSessions, normalizeStudioMessages, buildRunPayload, validateDocumentTitle, runStudioSocket, fetchStudioMessagesPaginated } from '../scripts/studio-client.mjs';
import { HermesBridgeClient } from '../src/bridge.ts';

test('Studio sessions are reduced to safe default-profile metadata', () => {
  assert.deepEqual(normalizeStudioSessions({ sessions: [{ id:'s1', title:'Work', preview:'hello', last_active:'2026-01-01', message_count:3, profile:'default', messages:[{content:'secret'}] }, { id:'s2', profile:'other', title:'No' }] }), [{ id:'s1', title:'Work', preview:'hello', last_active:'2026-01-01', message_count:3, source:'studio', profile:'default' }]);
});

test('Studio messages normalize to the bridge data contract', () => {
  assert.deepEqual(normalizeStudioMessages({ messages:[{id:'m1', role:'user', content:'q'}, {id:'m2', role:'assistant', content:'a'}] }, 's1'), { session_id:'s1', data:[{id:'m1', role:'user', content:'q'}, {id:'m2', role:'assistant', content:'a'}] });
});

test('run payload keeps actual input in all official message fields', () => {
  assert.deepEqual(buildRunPayload({ sessionId:'s1', input:'question', instructions:'frozen context' }), { input:'question', display_input:'question', storage_message:'question', session_id:'s1', profile:'default', instructions:'frozen context' });
});

test('document titles reject newlines and excessive length', () => {
  assert.equal(validateDocumentTitle('文档'), true);
  assert.equal(validateDocumentTitle('a\nb'), false);
  assert.equal(validateDocumentTitle('x'.repeat(201)), false);
});

test('bridge client exposes explicit Studio list and bind operations', async () => {
  const seen: Array<[string, RequestInit]> = [];
  const client=new HermesBridgeClient({bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'c'.repeat(64),documentRootId:'20260826094850-kronins'});
  // @ts-expect-error test transport injection
  client.request=async (path, init={}) => { seen.push([path,init]); return path === '/studio/sessions' ? {data:[]} : {binding:{id:'s1'}}; };
  assert.deepEqual(await client.listStudioSessions(), {data:[]});
  assert.deepEqual(await client.bindStudioSession('s1'), {binding:{id:'s1'}});
  assert.equal(seen[1][1].method,'POST');
});

test('Stop waits for Studio abort confirmation before settling and cleans up once', async () => {
  const listeners = new Map<string, Set<Function>>();
  const emitted: Array<[string, unknown]> = [];
  const socket = { on(event:string, cb:Function){(listeners.get(event) ?? (listeners.set(event,new Set()),listeners.get(event)!)).add(cb);return this;}, off(event:string, cb:Function){listeners.get(event)?.delete(cb);return this;}, removeAllListeners(){for(const set of listeners.values())set.clear();return this;}, emit(event:string,data:unknown){emitted.push([event,data]);return this;}, disconnect(){emitted.push(['disconnect',undefined]);} };
  const controller = new AbortController();
  const promise = runStudioSocket({ studioBase:'http://studio', token:'t', payload:{session_id:'s'}, socketFactory:()=>socket, signal:controller.signal, timeoutMs:1000 });
  await new Promise(r=>setImmediate(r));
  listeners.get('connect')?.forEach(cb=>cb()); listeners.get('run.started')?.forEach(cb=>cb({})); controller.abort();
  let settled = false; promise.then(()=>{settled=true},()=>{settled=true}); await new Promise(r=>setImmediate(r));
  assert.equal(settled,false); assert.equal(emitted.filter(([e])=>e==='abort').length,1);
  listeners.get('abort.completed')?.forEach(cb=>cb({})); await assert.rejects(promise, (e:any)=>e.name==='AbortError');
  assert.equal(emitted.filter(([e])=>e==='disconnect').length,1); assert.equal([...listeners.values()].every(set=>set.size===0),true);
});

test('Studio paginated messages aggregate formal offset pages in order and deduplicate', async () => {
  const calls:number[]=[];
  const result = await fetchStudioMessagesPaginated({ sessionId:'s', limit:2, fetchPage: async (offset:number, limit:number) => { calls.push(offset); return offset===0 ? {messages:[{id:'1',role:'user',content:'a'},{id:'2',role:'assistant',content:'b'}],total:3,offset,limit,hasMore:true} : {messages:[{id:'2',role:'assistant',content:'b'},{id:'3',role:'assistant',content:'c'}],total:3,offset,limit,hasMore:false}; }});
  assert.deepEqual(calls,[0,2]); assert.deepEqual(result.messages.map((m:any)=>m.id),['1','2','3']);
});

test('Studio pagination has a bounded max-page guard', async () => {
  await assert.rejects(() => fetchStudioMessagesPaginated({ sessionId:'s', limit:1, maxPages:2, fetchPage: async (offset:number, limit:number) => ({messages:[{id:String(offset),role:'user',content:'x'}],total:99,offset,limit,hasMore:true}) }), /maximum page limit/);
});

// A session-level abort before this socket has accepted a run can stop another owner.
for (const stage of ['token', 'connect', 'sent', 'expired', 'terminal', 'already-aborted']) test(`Studio cancellation at ${stage} never emits an unowned abort`, async () => {
  const listeners = new Map<string, Function>(), emitted: string[] = [];
  let releaseToken!: (value: string) => void;
  const token = new Promise<string>(yes => { releaseToken = yes; });
  const socket = { on(event: string, cb: Function) { listeners.set(event, cb); }, off() {}, removeAllListeners() {}, disconnect() {}, emit(event: string) { emitted.push(event); } };
  const controller = new AbortController();
  if (stage === 'already-aborted') controller.abort();
  const promise = runStudioSocket({ studioBase: 'http://synthetic.invalid', tokenProvider: () => token, payload: { session_id: 'synthetic-shared-session' }, socketFactory: () => socket, signal: controller.signal, canAbort: () => stage !== 'expired', timeoutMs: 1000, abortGraceMs: 20 });
  const outcome = promise.then(() => 'completed', (error: Error) => error.name);
  if (stage !== 'token') { releaseToken('synthetic'); await new Promise(r => setImmediate(r)); }
  if (['sent', 'expired', 'terminal'].includes(stage)) listeners.get('connect')?.();
  if (['expired', 'terminal'].includes(stage)) listeners.get('run.started')?.({});
  if (stage === 'terminal') listeners.get('run.completed')?.({});
  controller.abort();
  releaseToken('synthetic');
  await outcome;
  // Saved callbacks model a delayed transport callback after local cleanup.
  listeners.get('connect')?.(); listeners.get('run.started')?.({}); controller.abort();
  assert.equal(emitted.filter(event => event === 'abort').length, 0);
  assert.equal(emitted.filter(event => event === 'run').length, ['sent', 'expired', 'terminal'].includes(stage) ? 1 : 0);
});

test('Studio auth failure retires the old accepted socket without a delayed reattachment', async () => {
  const listeners = new Map<string, Function>(), emitted: string[] = [];
  let release!: (token: string) => void, reads = 0;
  const token = new Promise<string>(yes => { release = yes; });
  const socket = { on(event: string, cb: Function) { listeners.set(event, cb); }, off() {}, removeAllListeners() {}, disconnect() {}, emit(event: string) { emitted.push(event); } };
  const controller = new AbortController();
  const result = runStudioSocket({ studioBase: 'http://synthetic.invalid', tokenProvider: () => ++reads === 1 ? 'synthetic' : token, payload: { session_id: 's' }, socketFactory: () => socket, signal: controller.signal, abortGraceMs: 20 }).catch((error: Error) => error.name);
  await new Promise(r => setImmediate(r));
  listeners.get('connect')?.(); listeners.get('run.started')?.({});
  const retry = listeners.get('connect_error')?.(new Error('synthetic token expired'));
  listeners.get('run.started')?.({}); // stale callback from the detached transport
  controller.abort(); release('synthetic-new'); await retry; await result;
  assert.equal(emitted.filter(event => event === 'abort').length, 0);
  assert.equal(emitted.filter(event => event === 'run').length, 1);
});

for (const stage of ['auth-sent', 'auth-accepted', 'reconnect-sent', 'reconnect-accepted', 'auth-preparing']) test(`Studio ${stage} never replays an emitted run`, async () => {
  const listeners = new Map<string, Function>(), emitted: string[] = [];
  let tokenReads = 0;
  const socket = { on(event: string, cb: Function) { listeners.set(event, cb); }, off() {}, removeAllListeners() {}, disconnect() {}, emit(event: string) { emitted.push(event); } };
  const controller = new AbortController();
  const outcome = runStudioSocket({ studioBase: 'http://synthetic.invalid', tokenProvider: () => { tokenReads++; return 'synthetic'; }, payload: { session_id: 's' }, socketFactory: () => socket, signal: controller.signal, abortGraceMs: 20 }).then(() => 'complete', (error: Error) => error.name);
  await new Promise(r => setImmediate(r));
  if (stage !== 'auth-preparing') listeners.get('connect')?.();
  if (stage.endsWith('accepted')) listeners.get('run.started')?.({});
  if (stage.startsWith('auth-')) await listeners.get('connect_error')?.(new Error('synthetic token expired'));
  listeners.get('connect')?.();
  if (stage === 'auth-preparing') { listeners.get('run.started')?.({}); listeners.get('run.completed')?.({}); }
  controller.abort(); await outcome;
  assert.equal(emitted.filter(event => event === 'run').length, 1);
  assert.equal(emitted.filter(event => event === 'abort').length, 0);
  assert.equal(tokenReads, stage === 'auth-preparing' ? 2 : 1);
});

for (const outcome of ['failed', 'late']) test(`Studio preparation token refresh ${outcome} settles without reviving transport`, async () => {
  const listeners = new Map<string, Function>(), emitted: string[] = [];
  let reads = 0, sockets = 0, release!: (value: string) => void;
  const refresh = new Promise<string>(yes => { release = yes; });
  const socket = { on(event: string, cb: Function) { listeners.set(event, cb); }, off() {}, removeAllListeners() {}, disconnect() {}, emit(event: string) { emitted.push(event); } };
  const controller = new AbortController();
  const result = runStudioSocket({ studioBase: 'http://synthetic.invalid', tokenProvider: () => { if (++reads === 1) return 'synthetic'; return outcome === 'failed' ? Promise.reject(new Error('synthetic refresh read failed')) : refresh; }, payload: { session_id: 's' }, socketFactory: () => { sockets++; return socket; }, signal: controller.signal }).then(() => 'complete', (error: Error) => error.message);
  try {
    await new Promise(r => setImmediate(r));
    const retry = listeners.get('connect_error')?.(new Error('synthetic token expired'));
    if (outcome === 'late') { controller.abort(); release('synthetic-new'); }
    await assert.doesNotReject(async () => await retry);
    assert.match(await result, outcome === 'failed' ? /refresh read failed/ : /aborted/);
    assert.equal(sockets, 1); assert.deepEqual(emitted, []);
  } finally { controller.abort(); release('synthetic-new'); await result; }
});
