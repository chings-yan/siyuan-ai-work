import test from 'node:test';
import assert from 'node:assert/strict';
const A='20990101000000-aaaaaaa',B='20990101000001-bbbbbbb',KEY='ai-work-document-task-links-v1';
const guard={checkCurrent(){},async validate(){}};
async function fixture(initial?:unknown){
  const path='../src/task/document-links.ts';
  const module=await import(path).catch((error:any)=>{if(error.code==='ERR_MODULE_NOT_FOUND')return {};throw error;});
  assert.equal(typeof module.DocumentTaskLinks,'function','ordinary documents need independent task reference persistence');
  const values=new Map<string,unknown>([['existing-work-relations',{untouched:true}],...(initial===undefined?[]:[[KEY,initial]] as [string,unknown][])]);let writes=0;
  const storage={loadData:async(key:string)=>structuredClone(values.get(key)),saveData:async(key:string,value:unknown)=>{writes++;values.set(key,structuredClone(value));}};
  return {values,storage,store:new module.DocumentTaskLinks(storage),restart:()=>new module.DocumentTaskLinks(storage),writes:()=>writes};
}
test('ordinary document task references persist independently of Work and native task data',async()=>{
  const f=await fixture();await f.store.link(A,'task-one',guard);await f.store.link(B,'task-one',guard);await f.store.link(A,'task-two',guard);
  assert.deepEqual(await f.restart().list(A),[{documentId:A,taskId:'task-one',connectionId:'siyuan-native-local'},{documentId:A,taskId:'task-two',connectionId:'siyuan-native-local'}]);
  assert.deepEqual(await f.restart().list(B),[{documentId:B,taskId:'task-one',connectionId:'siyuan-native-local'}]);
  assert.deepEqual(f.values.get('existing-work-relations'),{untouched:true});assert.deepEqual([...f.values.keys()].sort(),[KEY,'existing-work-relations'].sort());
});
test('repeated and queued links retain every distinct relation exactly once',async()=>{
  const f=await fixture();await Promise.all([f.store.link(A,'task-one',guard),f.store.link(A,'task-one',guard),f.store.link(A,'task-two',guard)]);
  assert.equal(f.writes(),2);assert.equal((await f.store.list(A)).length,2);
  const list=await f.store.list(A);list[0].taskId='mutated';assert.equal((await f.store.list(A))[0].taskId,'task-one');
});
test('removing a supplemental reference preserves other documents and original stores',async()=>{
  const f=await fixture();await f.store.link(A,'task-one',guard);await f.store.link(B,'task-one',guard);await f.store.unlink(A,'task-one',guard);await f.store.unlink(A,'task-one',guard);
  assert.deepEqual(await f.store.list(A),[]);assert.equal((await f.store.list(B)).length,1);assert.equal(f.writes(),3);assert.deepEqual(f.values.get('existing-work-relations'),{untouched:true});
});
test('invalid identities are rejected before any stored relation changes',async()=>{
  const f=await fixture();for(const [doc,task] of [['bad-root','task-one'],[A,''],[A,' task-one'],[A,'task\nother']])await assert.rejects(f.store.link(doc,task,guard));
  assert.equal(f.writes(),0);await assert.rejects(f.store.list('bad-root'));
});
test('unknown schemas, malformed records and duplicates are not overwritten',async()=>{
  const entry={documentId:A,taskId:'task-one',connectionId:'siyuan-native-local'};
  for(const initial of [{schema:2,links:[]},{schema:1,links:'invalid'},{schema:1,links:[entry,entry]},{schema:1,links:[{...entry,connectionId:'foreign'}]},{schema:1,links:[],future:true}]){
    const f=await fixture(initial);await assert.rejects(f.store.list(A));await assert.rejects(f.store.link(A,'task-two',guard));assert.equal(f.writes(),0);assert.deepEqual(f.values.get(KEY),initial);
  }
});
test('queued mutation rechecks scene after validation and retains preexisting links',async()=>{
  const f=await fixture();await f.store.link(A,'task-one',guard);let current=true;
  await assert.rejects(f.store.link(A,'task-two',{checkCurrent(){if(!current)throw Error('stale document');},async validate(){current=false;}}),/stale document/);
  assert.equal(f.writes(),1);assert.equal((await f.store.list(A)).length,1);
});
test('task validation failure cannot write, and does not poison the next explicit operation',async()=>{
  const f=await fixture();await assert.rejects(f.store.link(A,'task-one',{checkCurrent(){},async validate(){throw Error('task changed');}}),/task changed/);
  await f.store.link(A,'task-two',guard);assert.equal(f.writes(),1);assert.equal((await f.store.list(A))[0].taskId,'task-two');
});
test('failed load or save and unequal readback remain errors without automatic retry',async()=>{
  for(const mode of ['load','save','readback']){
    const f=await fixture();let saves=0,loads=0;
    f.storage.loadData=async()=>{loads++;if(mode==='load')throw Error('unreadable');return undefined;};
    f.storage.saveData=async()=>{saves++;if(mode==='save')throw Error('write failed');};
    await assert.rejects(f.store.link(A,'task-one',guard));assert.equal(saves,mode==='load'?0:1);assert.ok(loads>=1);
  }
});
