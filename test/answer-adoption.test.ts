import test from 'node:test';
import assert from 'node:assert/strict';
import { AnswerAdoptionController, type AdoptionSource, type AdoptionTarget, type AdoptionNative, type AdoptionPlan } from '../src/work/answer-adoption.ts';
import { WorkStore } from '../src/work/store.ts';

const source: AdoptionSource = { conversationKey:'synthetic-exact-connection/session/profile', messageId:'stable-answer', role:'assistant', complete:true, content:'完整虚构回答', documentId:'20990101000000-aaaaaaa' };
const target: AdoptionTarget = { kind:'append', documentId:source.documentId, title:'原文档' };
function fixture() {
 const values=new Map<string,unknown>(); let writes=0, reads=0, current=true, refuse=false, lose=false, verified=true;
 const storage={loadData:(key:string)=>structuredClone(values.get(key)),saveData:(key:string,value:unknown)=>{if(refuse)throw Error('storage');values.set(key,structuredClone(value));}};
 const store=new WorkStore(storage);
 const native:AdoptionNative={prepare:async(content,target,operationId)=>({operationId,target,preview:content,dom:'controlled-dom',markdown:'controlled-md',proof:{canonicalDigest:'a'.repeat(64),topIds:['20990101000001-bbbbbbb'],blocks:[{id:'20990101000001-bbbbbbb',ids:['20990101000001-bbbbbbb'],digest:'a'.repeat(64)}],root:target.kind==='append'?{rootID:target.documentId,box:'20990101000002-ccccccc',path:`/${target.documentId}.sy`}:null}}),checkTarget:async()=>{},write:async()=>{writes++;if(lose)throw Error('response lost');return {rootId:source.documentId};},verify:async()=>{reads++;if(!verified)throw Error('not verified');return {rootId:source.documentId};}};
 const controller=new AnswerAdoptionController({storage,pendingStore:store,native,isCurrent:()=>current});
 return {values,storage,store,native,controller,writes:()=>writes,reads:()=>reads,setCurrent:(v:boolean)=>current=v,setRefuse:(v:boolean)=>refuse=v,setLose:(v:boolean)=>lose=v,setVerified:(v:boolean)=>verified=v};
}
test('preview never writes; explicit confirmation performs one append and complete verification',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target);
 assert.equal(f.writes(),0);assert.equal(p.preview,source.content);
 const result=await f.controller.commit(p);assert.equal(result.state,'complete');assert.equal(f.writes(),1);assert.equal(f.reads(),1);assert.equal((await f.store.listPending()).length,0);
 assert.equal((await f.controller.commit(p)).state,'complete');assert.equal(f.writes(),1);
 const second=new AnswerAdoptionController({storage:f.storage,pendingStore:f.store,native:f.native,isCurrent:()=>true});
 await assert.rejects(second.prepare(source,target),/已采纳/);assert.equal(f.writes(),1);
});
test('only complete ordinary assistant text is eligible and source must remain current',async()=>{
 const f=fixture();for(const patch of [{role:'user' as const},{complete:false},{content:''},{conversationKey:''}])await assert.rejects(f.controller.prepare({...source,...patch},target));
 const p=await f.controller.prepare(source,target);f.setCurrent(false);await assert.rejects(f.controller.commit(p),/来源|视图/);assert.equal(f.writes(),0);
});
test('persisted pending fence must succeed before native write',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target);f.setRefuse(true);await assert.rejects(f.controller.commit(p));assert.equal(f.writes(),0);
});
test('a lost native response remains unknown across controllers and review never writes again',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target);f.setLose(true);const result=await f.controller.commit(p);assert.equal(result.state,'unknown');assert.equal(f.writes(),1);assert.equal((await f.store.listPending()).length,1);
 const second=new AnswerAdoptionController({storage:f.storage,pendingStore:f.store,native:f.native,isCurrent:()=>true});
 await assert.rejects(second.prepare(source,target),/核对/);assert.equal(f.writes(),1);
 assert.equal((await second.review(p.operationId)).state,'complete');assert.equal(f.writes(),1);assert.equal((await f.store.listPending()).length,0);
});
test('verification failure is unknown; exact full readback is necessary',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target);f.setVerified(false);
 assert.equal((await f.controller.commit(p)).state,'unknown');assert.equal(f.writes(),1);assert.equal((await f.controller.review(p.operationId)).state,'unknown');assert.equal(f.writes(),1);
});
test('two previews share one lock and cannot issue duplicate writes',async()=>{
 const f=fixture(),a=await f.controller.prepare(source,target),b=await f.controller.prepare(source,target);
 const all=await Promise.allSettled([f.controller.commit(a),f.controller.commit(b)]);assert.equal(f.writes(),1);assert.ok(all.some(x=>x.status==='rejected'));
});
test('newer pending replacement is preserved even after complete native verification',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target);f.native.verify=async()=>{const old=(await f.store.listPending())[0];await f.store.setPending({...old,details:'newer marker',updatedAt:'newer'});return {rootId:source.documentId};};
 assert.equal((await f.controller.commit(p)).state,'unknown');assert.equal((await f.store.listPending())[0].details,'newer marker');assert.equal(f.writes(),1);
});
test('mutating caller source, target, or public preview cannot change the frozen write',async()=>{
 const f=fixture(),s={...source},t={...target};const p=await f.controller.prepare(s,t);s.content='changed';t.documentId='20990101000003-ddddddd';
 let received:AdoptionPlan|undefined;f.native.write=async plan=>{received=plan;return {rootId:source.documentId};};await f.controller.commit(p);
 assert.equal(received?.preview,source.content);assert.deepEqual(received?.target,target);assert.ok(Object.isFrozen(p));
});
test('renaming a document cannot bypass persisted adoption deduplication',async()=>{
 const f=fixture();await f.controller.commit(await f.controller.prepare(source,target));await assert.rejects(f.controller.prepare(source,{...target,title:'新标题'}),/已采纳/);assert.equal(f.writes(),1);
});
test('the independent pending store must accept its fence, even when the ledger is writable',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target);f.store.setPending=async()=>{throw Error('pending unavailable');};await assert.rejects(f.controller.commit(p));assert.equal(f.writes(),0);
});
test('a scene change during target verification prevents any write; lock covers the entire commit',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target);f.native.checkTarget=async()=>{assert.equal(f.controller.isBusy,true);f.setCurrent(false);};await assert.rejects(f.controller.commit(p),/变化/);assert.equal(f.writes(),0);assert.equal(f.controller.isBusy,false);
});
test('same-content fallback without a remote message ID remains conservative across reload',async()=>{
 const f=fixture(),anonymous={...source,messageId:undefined};const p=await f.controller.prepare(anonymous,target);await f.controller.commit(p);
 const second=new AnswerAdoptionController({storage:f.storage,pendingStore:f.store,native:f.native,isCurrent:()=>true});await assert.rejects(second.prepare(anonymous,target),/已采纳/);assert.equal(f.writes(),1);
});
test('known pre-submit scene cancellation can release only its own fence without a native retry',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target),save=f.storage.saveData;
 f.storage.saveData=(key,value)=>{save(key,value);if(key.startsWith('answer-adoption-v1-source-'))f.setCurrent(false);};
 const result=await f.controller.commit(p);assert.equal(result.state,'unknown');assert.match(result.message,/未写入|没有写入/);assert.equal(f.writes(),0);assert.equal((await f.store.listPending()).length,0);
 f.storage.saveData=save;f.setCurrent(true);await f.controller.prepare(source,target);assert.equal(f.writes(),0);
});
test('a completed ledger missing its verified receipt is corruption, never a success',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target);await f.controller.commit(p);
 const key=`answer-adoption-v1-operation-${p.operationId}`,value=f.values.get(key) as Record<string,unknown>;delete value.receipt;
 await assert.rejects(f.controller.review(p.operationId),/记录|回执/);assert.equal(f.writes(),1);
});
test('I1: pointer persistence failure remains known unsent and reload review can release only that fence',async()=>{
 const f=fixture(),p=await f.controller.prepare(source,target),save=f.storage.saveData;
 f.storage.saveData=(key,value)=>{if(key.startsWith('answer-adoption-v1-source-'))throw Error('pointer persistence failed');save(key,value);};
 await assert.rejects(f.controller.commit(p),/pointer/);assert.equal(f.writes(),0);assert.equal((await f.store.listPending()).length,1);
 f.storage.saveData=save;f.setVerified(false);const reloaded=new AnswerAdoptionController({storage:f.storage,pendingStore:f.store,native:f.native,isCurrent:()=>true});
 const reviewed=await reloaded.review(p.operationId);assert.equal(reviewed.state,'unknown');assert.match(reviewed.message,/未写入/);assert.equal(f.reads(),0);assert.equal(f.writes(),0);assert.equal((await f.store.listPending()).length,0);
 await reloaded.prepare(source,target);assert.equal(f.writes(),0);
});

for(const state of ['unknown','complete'] as const){
 for(const [from,to,label] of [
  [undefined,'history-message','missing-to-known'],
  ['stream-message',undefined,'known-to-missing'],
  ['first-remote-message','second-remote-message','different-known-ids'],
 ] as const){
  test(`content dedup survives ${label} and reload after ${state}`,async()=>{
   const f=fixture(),initial={...source,messageId:from},later={...source,messageId:to};
   if(state==='unknown')f.setLose(true);
   const preview=await f.controller.prepare(initial,target);
   assert.equal((await f.controller.commit(preview)).state,state);assert.equal(f.writes(),1);
   const pendingBefore=await f.store.listPending();assert.equal(pendingBefore.length,state==='unknown'?1:0);
   const reloaded=new AnswerAdoptionController({storage:f.storage,pendingStore:f.store,native:f.native,isCurrent:()=>true});
   await assert.rejects(reloaded.prepare(later,target),state==='unknown'?/核对/:/已采纳/);
   assert.equal(f.writes(),1);assert.deepEqual(await f.store.listPending(),pendingBefore);
   if(state==='unknown'){
    assert.equal((await reloaded.review(preview.operationId)).state,'complete');assert.equal(f.writes(),1);
    await assert.rejects(reloaded.prepare(later,target),/已采纳/);assert.equal(f.writes(),1);
   }
  });
 }
}
test('content dedup still permits explicitly different content, target, or conversation',async()=>{
 const f=fixture();await f.controller.commit(await f.controller.prepare(source,target));assert.equal(f.writes(),1);
 const changed=await f.controller.prepare({...source,content:'明确修改后的完整回答'},target);assert.equal(f.writes(),1);
 await f.controller.commit(changed);assert.equal(f.writes(),2);
 const otherTarget:AdoptionTarget={kind:'note',notebookId:'20990101000002-ccccccc',title:'明确选择的独立笔记'};
 const separate=await f.controller.prepare(source,otherTarget);assert.equal(f.writes(),2);await f.controller.commit(separate);assert.equal(f.writes(),3);
 await f.controller.prepare({...source,conversationKey:'another-exact-connection/session/profile'},target);assert.equal(f.writes(),3);
});
test('the optional real message ID still reaches frozen source-current verification',async()=>{
 const f=fixture();const observed:AdoptionSource[]=[];
 const controller=new AnswerAdoptionController({storage:f.storage,pendingStore:f.store,native:f.native,isCurrent:value=>{observed.push(structuredClone(value));return true;}});
 await controller.commit(await controller.prepare(source,target));assert.ok(observed.length>0);assert.ok(observed.every(value=>value.messageId===source.messageId));assert.equal(f.writes(),1);
});
test('the unified content key retains the exact original no-ID serialization',async()=>{
 const f=fixture();f.setLose(true);await f.controller.commit(await f.controller.prepare(source,target));
 const serialized=JSON.stringify({conversation:source.conversationKey,messageId:null,content:source.content,target:{kind:'append',documentId:source.documentId}});
 const expected=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(serialized)))].map(value=>value.toString(16).padStart(2,'0')).join('');
 assert.equal((await f.store.listPending())[0].id,`answer-adoption-v1:${expected}`);assert.equal(f.writes(),1);
});
for(const state of ['unknown','complete'] as const){
 test(`Windows-safe physical storage names support ${state} and reloaded deduplication`,async()=>{
  const f=fixture(),names:string[]=[];
  const checkName=(name:string)=>{assert.doesNotMatch(name,/[<>:"/\\|?*\u0000-\u001f]|[. ]$/,'physical plugin storage names must be legal single Windows filenames');names.push(name);};
  const windowsStorage={loadData:(name:string)=>{checkName(name);return f.storage.loadData(name);},saveData:(name:string,value:unknown)=>{checkName(name);return f.storage.saveData(name,value);}};
  const store=new WorkStore(windowsStorage),controller=new AnswerAdoptionController({storage:windowsStorage,pendingStore:store,native:f.native,isCurrent:()=>true});
  if(state==='unknown')f.setLose(true);
  const preview=await controller.prepare(source,target);assert.equal((await controller.commit(preview)).state,state);assert.equal(f.writes(),1);
  assert.ok(names.some(name=>/^answer-adoption-v1-operation-[a-f0-9-]+$/.test(name)));
  assert.ok(names.some(name=>/^answer-adoption-v1-source-[a-f0-9]{64}$/.test(name)));
  const reloaded=new AnswerAdoptionController({storage:windowsStorage,pendingStore:store,native:f.native,isCurrent:()=>true});
  await assert.rejects(reloaded.prepare({...source,messageId:undefined},target),state==='unknown'?/核对/:/已采纳/);assert.equal(f.writes(),1);
  if(state==='unknown'){
   assert.match((await store.listPending())[0].id,/^answer-adoption-v1:/);
   assert.equal((await reloaded.pending()).length,1);assert.equal((await reloaded.review(preview.operationId)).state,'complete');assert.equal(f.writes(),1);
  }
 });
}
