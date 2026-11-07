import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkStore } from '../src/work/store.ts';
const link={chatId:'chat-a',workId:null,documentRootId:'document-a',connectionId:'studio-default',adapter:'studio',profile:'default',storedSessionId:'session-a',installId:null,title:'虚构会话',state:'ready'};
function fixture(seed:unknown,legacy?:unknown){const data=new Map([['work-formal-v2',seed],['work-formal-v1',legacy]]);let writes=0;const store=new WorkStore({loadData:key=>data.get(key),saveData:(key,value)=>{writes++;data.set(key,value);}});return {store,data,get writes(){return writes;}};}
test('reply enumeration reads validated modern links without mutating formal storage',async()=>{
 const seed={schema:2,works:[],chats:[link],tasks:[],pins:{}};const f=fixture(seed);const rows=await f.store.listAllChatsReadOnly();assert.deepEqual(rows,[link]);rows[0].title='caller mutation';assert.equal(seed.chats[0].title,'虚构会话');assert.equal(f.writes,0);
});
test('reply enumeration does not trigger existing v1 migration or save empty formal storage',async()=>{
 const legacy={schema:1,works:['work-a'],chats:[{chatId:'old-chat',workId:'work-a',documentRootId:'document-a',connectionId:'legacy-address'}],tasks:[],pins:{}};
 const f=fixture(undefined,legacy);const rows=await f.store.listAllChatsReadOnly();assert.equal(rows.length,1);assert.equal(rows[0].state,'source-unknown');assert.equal(rows[0].adapter,'unresolved');assert.equal(f.writes,0);assert.equal(f.data.get('work-formal-v2'),undefined);
 const empty=fixture(undefined);assert.deepEqual(await empty.store.listAllChatsReadOnly(),[]);assert.equal(empty.writes,0);
});
test('malformed modern storage never becomes an empty successful enumeration or migration',async()=>{
 const f=fixture({schema:2,works:[],chats:[{...link,profile:17}],tasks:[],pins:{}});await assert.rejects(f.store.listAllChatsReadOnly(),/损坏|兼容/);assert.equal(f.writes,0);
});

test('strict reply enumeration uses only the supplied uncached reader including legacy fallback',async()=>{
 const f=fixture({schema:2,works:[],chats:[link],tasks:[],pins:{}});let reads=0;
 await assert.rejects(f.store.listAllChatsReadOnly({loadData:()=>{reads++;throw Error('disk unreadable');},saveData:()=>assert.fail('read-only')}),/disk unreadable/);assert.equal(reads,1);assert.equal(f.writes,0);
});
test('verified pending port shares mutation ordering and preserves unrelated pending records',async()=>{
 const f=fixture(undefined),item={id:'adoption-a',kind:'write' as const,workId:null,state:'unknown' as const,details:'frozen',updatedAt:'now'},other={...item,id:'other'};
 let unblock!:()=>void,started!:()=>void;const startedPromise=new Promise<void>(r=>started=r);const held=new Promise<void>(r=>unblock=r);let strictReads=0,strictWrites=0;
 const strict={loadData:async(key:string)=>{strictReads++;return f.data.get(key);},saveData:async(key:string,value:unknown)=>{strictWrites++;started();await held;f.data.set(key,value);}};
 const port=f.store.pendingPort(strict);const first=port.setPending(item,{ifAbsent:true});await startedPromise;const second=f.store.setPending(other);await Promise.resolve();assert.equal(f.writes,0);unblock();await Promise.all([first,second]);assert.equal(strictWrites,1);assert.deepEqual((await port.listPending()).map(x=>x.id),['adoption-a','other']);
 await assert.rejects(port.setPending(item,{ifAbsent:true}),/未决/);assert.equal(await port.clearPending(item.id,{...item,details:'different'}),false);assert.equal(await port.clearPending(item.id,item),true);assert.deepEqual((await port.listPending()).map(x=>x.id),['other']);assert.ok(strictReads>=5);
});
