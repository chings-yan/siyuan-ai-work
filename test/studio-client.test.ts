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
  listeners.get('connect')?.forEach(cb=>cb()); controller.abort();
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
