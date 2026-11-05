import test from 'node:test';
import assert from 'node:assert/strict';
import * as creation from '../src/work/create.ts';
import { WorkStore } from '../src/work/store.ts';
import { WorkService } from '../src/work/service.ts';
import { SiYuanWorkHost } from '../src/work/siyuan-host.ts';

const doc = '20260929120000-abcdef0', box = '20260929120001-abcdef0';
function fixture() {
  const disk = new Map<string, unknown>(), attrs = new Map<string, Record<string,string>>(), children = new Map<string,string[]>(), md = new Map<string,string>();
  let creates = 0, timeout = false, matches: string[] | undefined, failSave = false, failClearPending = false, failFormalRead = false;
  const host = {
    listNotebooks: async () => [{id:box,name:'测试本'}], getDocumentNotebook: async () => box,
    getDocumentTitle: async () => '原文档', getDocumentPath: async (id:string) => `/${id}.sy`,
    searchDocuments: async () => [],
    getAttrs: async (id:string) => attrs.get(id) || {}, setAttrs: async (id:string,a:Record<string,string>) => {attrs.set(id,{...attrs.get(id),...a});},
    getChildren: async (id:string) => children.get(id) || [], getBlockMarkdown: async (id:string) => md.get(id) || '',
    appendMarkdown: async (id:string,text:string) => { const child=`goal${md.size}`; children.set(id,[...(children.get(id)||[]),child]); md.set(child,text); attrs.set(child,{'custom-ai-work-role':text.match(/custom-ai-work-role="([^"]+)/)?.[1]||'','custom-ai-work-document-id':text.match(/custom-ai-work-document-id="([^"]+)/)?.[1]||''}); },
    prependMarkdown: async (id:string,text:string) => { const child=`goal${md.size}`; children.set(id,[child,...(children.get(id)||[])]); md.set(child,text); attrs.set(child,{'custom-ai-work-role':text.match(/custom-ai-work-role="([^"]+)/)?.[1]||''}); },
    getDocumentIdsByPath: async () => [] as string[],
    createDocument: async (_box:string,_title:string,op:string) => { creates++; attrs.set(doc,{'custom-ai-work-create-op':op}); if(timeout)throw new Error('timeout');return doc; },
    findCreatedDocuments: async (_box:string,op:string) => matches ?? (attrs.get(doc)?.['custom-ai-work-create-op']===op?[doc]:[]),
  };
  const store = new WorkStore({loadData:key=>{if(failFormalRead&&key==='work-formal-v2')throw new Error('formal read failed');return structuredClone(disk.get(key));},saveData:(key,value)=>{if(failSave)throw new Error('disk failed');if(failClearPending&&key==='work-pending-v1'&&(value as {items:unknown[]}).items.length===0)throw new Error('clear failed');disk.set(key,structuredClone(value));}});
  const tasks = {listRecent:async()=>({kind:'unavailable' as const,reason:'offline'}),getTask:async(_id:string):Promise<any>=>({kind:'missing'})};
  const service = new WorkService(host,store);
  const make = () => new creation.WorkCreator(host,store,service,tasks);
  return {host,store,service,tasks,make,disk,attrs,children,get creates(){return creates;},set timeout(v:boolean){timeout=v;},set matches(v:string[]){matches=v;},set failSave(v:boolean){failSave=v;},set failClearPending(v:boolean){failClearPending=v;},set failFormalRead(v:boolean){failFormalRead=v;}};
}
const blank = {mode:'blank' as const,title:'新工作',goal:'验收目标',notebookId:box,documentId:null,taskId:null};

test('confirmed repair completes the original existing-document operation without duplicating its document',async()=>{
  const f=fixture(),id='work-create:repair';f.attrs.set(doc,{'custom-ai-work-v0':'1','custom-ai-work-status':'paused'});
  f.children.set(doc,['original']);
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  const creator=f.make() as any;
  await assert.rejects(creator.repairExistingCreation(id,false),/确认/);
  assert.deepEqual(f.children.get(doc),['original']);
  const result=await creator.repairExistingCreation(id,true);
  assert.equal(result.kind,'complete');assert.equal(result.work?.id,doc);assert.equal(result.work?.status,'paused');
  assert.equal(f.creates,0);assert.equal(f.children.get(doc)?.length,2);assert.equal(f.children.get(doc)?.[1],'original');
  assert.equal((await creator.pending()).length,0);
});

test('repair keeps pending after an uncertain write and resume reads back instead of inserting again',async()=>{
  const f=fixture(),id='work-create:repair-unknown';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  const prepend=f.host.prependMarkdown;f.host.prependMarkdown=async(parentId:string,text:string)=>{await prepend(parentId,text);throw Error('timeout after write');};
  const creator=f.make() as any,first=await creator.repairExistingCreation(id,true);
  assert.equal(first.kind,'pending');assert.equal((await creator.pending()).length,1);assert.equal(f.children.get(doc)?.length,1);
  assert.equal(JSON.parse((await creator.pending())[0].details).repairAttempted,true);
  const resumed=await f.make().resume(id);assert.equal(resumed.kind,'complete');assert.equal(f.children.get(doc)?.length,1);assert.equal(f.creates,0);
});

test('unknown Goal write remains fenced after restart and cannot be sent a second time',async()=>{
  const f=fixture(),id='work-create:repair-delayed';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  let sent=0;f.host.prependMarkdown=async()=>{sent++;throw Error('unknown write result');};
  const first=await (f.make() as any).repairExistingCreation(id,true);
  assert.equal(first.kind,'pending');assert.equal(sent,1);
  const second=await (f.make() as any).repairExistingCreation(id,true);
  assert.equal(second.kind,'pending');assert.equal(sent,1);
  assert.equal(JSON.parse((await f.store.listPending())[0].details).repairAttempted,true);
});

test('ordinary resume cannot bypass an uncertain repair when its Goal is absent or different',async()=>{
  const f=fixture(),id='work-create:repair-resume-guard';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false,repairAttempted:true}),updatedAt:'2026-09-30'});
  const absent=await f.make().resume(id);assert.equal(absent.kind,'pending');assert.equal(f.children.get(doc),undefined);
  f.attrs.set(doc,{});
  const unmarked=await f.make().resume(id);assert.equal(unmarked.kind,'pending');assert.equal(f.children.get(doc),undefined);
  f.attrs.set(doc,{'custom-ai-work-v0':'1'});f.children.set(doc,['other-goal']);
  f.attrs.set('other-goal',{'custom-ai-work-role':'goal'});
  const original=f.host.getBlockMarkdown;f.host.getBlockMarkdown=async(blockId:string)=>blockId==='other-goal'?'**目标**：另一个目标':original(blockId);
  const changed=await f.make().resume(id);assert.equal(changed.kind,'pending');
  assert.equal((await f.store.listPending()).length,1);assert.deepEqual(f.children.get(doc),['other-goal']);
});

test('a failed prewrite fence save does not permanently block a repair that was never sent',async()=>{
  const f=fixture(),id='work-create:repair-fence-save';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  const write=f.store.setPending.bind(f.store);let writes=0;
  f.store.setPending=async operation=>{if(++writes===2)throw Error('disk failed before native write');await write(operation);};
  const creator=f.make() as any,first=await creator.repairExistingCreation(id,true);
  assert.equal(first.kind,'pending');assert.equal(f.children.get(doc),undefined);
  assert.equal(JSON.parse((await creator.pending())[0].details).repairAttempted,undefined);
  f.store.setPending=write;
  const second=await creator.repairExistingCreation(id,true);
  assert.equal(second.kind,'complete');assert.equal(f.children.get(doc)?.length,1);
});

test('repaired Work remains visible as partial when only its optional task is unavailable',async()=>{
  const f=fixture(),id='work-create:repair-task-offline';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  f.tasks.getTask=async()=>({kind:'unavailable',reason:'任务服务失联'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc,taskId:'task-1'},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  const creator=f.make() as any,result=await creator.repairExistingCreation(id,true);
  assert.equal(result.kind,'partial');assert.equal(result.work?.id,doc);
  assert.match(result.message,/任务服务失联/);assert.equal(f.children.get(doc)?.length,1);
  assert.equal((await f.store.listPending()).length,1);
  f.tasks.getTask=async()=>({kind:'found',value:{id:'task-1',title:'测试任务',completed:false}});
  const resumed=await f.make().resume(id);
  assert.equal(resumed.kind,'complete');assert.equal(f.children.get(doc)?.length,1);
});

test('repair cannot write when recovery state cannot be saved or points to a different document',async()=>{
  const f=fixture(),id='work-create:repair-guard';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  f.failSave=true;const held=await (f.make() as any).repairExistingCreation(id,true);f.failSave=false;
  assert.equal(held.kind,'pending');assert.equal(f.children.get(doc),undefined);
  await assert.rejects((f.make() as any).repairExistingCreation('work-create:wrong',true),/待核对/);
  assert.equal((await f.store.listPending()).length,1);
});

test('new and already marked Work can be used without a Goal',async()=>{
  const newWork=fixture();
  const created=await newWork.make().submit({...blank,goal:''});
  assert.equal(created.kind,'complete');assert.equal(created.work?.goal,'');
  assert.equal(newWork.children.get(doc),undefined);assert.equal(newWork.creates,1);
  const existing=fixture();existing.attrs.set(doc,{'custom-ai-work-v0':'1'});
  const reused=await existing.make().submit({...blank,mode:'current',documentId:doc,goal:''});
  assert.equal(reused.kind,'complete');assert.equal(reused.work?.goal,'');assert.equal(existing.creates,0);
  assert.equal(existing.children.get(doc),undefined);
});

test('old saved Goal is omitted only by explicit choice, with relations preserved',async()=>{
  const f=fixture(),id='work-create:old-goal';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  f.children.set(doc,['original']);await f.store.registerWork(doc);
  await f.store.linkTask({taskId:'existing-task',workId:doc,connectionId:'siyuan-native-local'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  const creator=f.make();const blocked=await creator.resume(id);
  assert.equal(blocked.kind,'pending');assert.match(blocked.message,/目标|明确/);
  await assert.rejects(creator.continueWithoutGoal(id,false),/确认/);
  const done=await creator.continueWithoutGoal(id,true);
  assert.equal(done.kind,'complete');assert.equal(done.work?.goal,'');
  assert.deepEqual(f.children.get(doc),['original']);
  assert.deepEqual((await f.store.listTasks(doc)).map(x=>x.taskId),['existing-task']);
  assert.equal((await f.store.listPending()).length,0);assert.equal(f.creates,0);
});

test('unknown previous Goal write cannot be bypassed by choosing no Goal',async()=>{
  const f=fixture(),id='work-create:uncertain-goal';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false,repairAttempted:true}),updatedAt:'2026-09-30'});
  await assert.rejects(f.make().continueWithoutGoal(id,true),/核对|上次修复/);
  assert.equal((await f.store.listPending()).length,1);
});

test('a Goal can be added later to a goal-less Work without changing its identity',async()=>{
  const f=fixture();await f.make().submit({...blank,goal:''});
  const before=structuredClone(f.disk.get('work-formal-v2'));
  await assert.rejects(f.make().addGoal(doc,'后补目标',false),/确认/);
  const added=await f.make().addGoal(doc,'后补目标',true);
  assert.equal(added.kind,'complete');assert.equal(added.work?.goal,'后补目标');
  assert.equal(f.children.get(doc)?.length,1);
  const repeated=await f.make().addGoal(doc,'后补目标',true);
  assert.equal(repeated.kind,'complete');assert.equal(f.children.get(doc)?.length,1);
  assert.deepEqual(f.disk.get('work-formal-v2'),before);
  assert.equal((await f.store.listPending()).length,0);
});

test('later Goal write with unknown result stays fenced after restart',async()=>{
  const f=fixture();await f.make().submit({...blank,goal:''});
  let sent=0;f.host.prependMarkdown=async()=>{sent++;throw Error('unknown write result');};
  const first=await f.make().addGoal(doc,'后补目标',true);
  assert.equal(first.kind,'pending');assert.equal(sent,1);
  const pending=(await f.store.listPending())[0];assert.equal(pending.id,`work-goal:${doc}`);
  assert.equal(JSON.parse(pending.details).attempted,true);
  const second=await f.make().addGoal(doc,'后补目标',true);
  assert.equal(second.kind,'pending');assert.equal(sent,1);
  await assert.rejects(f.make().addGoal(doc,'另一个目标',true),/待核对|不一致/);
});

test('another window cannot replay an unfinished Goal record before the native write',async()=>{
  const f=fixture();await f.make().submit({...blank,goal:''});
  await f.store.setPending({id:`work-goal:${doc}`,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,goal:'后补目标',attempted:false}),updatedAt:'2026-10-01'});
  let writes=0;f.host.prependMarkdown=async()=>{writes++;};
  const result=await f.make().addGoal(doc,'后补目标',true);
  assert.equal(result.kind,'pending');assert.match(result.message,/不会.*再次写入/);assert.equal(writes,0);
});

test('a failed prewrite Goal check clears only its own partial fence and allows a safe retry',async()=>{
  const f=fixture();await f.make().submit({...blank,goal:''});
  const readPath=f.host.getDocumentPath;let unavailable=true,writes=0;
  f.host.getDocumentPath=async(id:string)=>{if(unavailable){unavailable=false;throw Error('temporary path read failure');}return readPath(id);};
  const prepend=f.host.prependMarkdown;
  f.host.prependMarkdown=async(id:string,markdown:string)=>{writes++;await prepend(id,markdown);};
  await assert.rejects(f.make().addGoal(doc,'后补目标',true),/尚未写入目标.*temporary path read failure/);
  assert.equal((await f.store.listPending()).length,0);assert.equal(writes,0);
  const retried=await f.make().addGoal(doc,'后补目标',true);
  assert.equal(retried.kind,'complete');assert.equal(writes,1);
});

test('a second WorkCreator observes the browser mutation lock during Goal writes',async()=>{
  const f=fixture();await f.make().submit({...blank,goal:''});
  const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  let held=false,entered!:()=>void,release!:()=>void;
  const enteredPromise=new Promise<void>(resolve=>{entered=resolve;});
  const releasePromise=new Promise<void>(resolve=>{release=resolve;});
  const prepend=f.host.prependMarkdown;let writes=0;
  f.host.prependMarkdown=async(id:string,markdown:string)=>{writes++;entered();await releasePromise;await prepend(id,markdown);};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:async(_name:string,_options:unknown,callback:(lock:object|null)=>Promise<unknown>)=>{
    if(held)return callback(null);
    held=true;try{return await callback({});}finally{held=false;}
  }}}});
  try{
    const first=f.make().addGoal(doc,'后补目标',true);await enteredPromise;
    await assert.rejects(f.make().addGoal(doc,'后补目标',true),/另一窗口/);
    release();assert.equal((await first).kind,'complete');assert.equal(writes,1);
  }finally{
    release();if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);
    else Reflect.deleteProperty(globalThis,'navigator');
  }
});

test('browser Work mutations stop when cross-window locks are unavailable',async()=>{
  const f=fixture();await f.make().submit({...blank,goal:''});
  const originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');
  const originalNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  Object.defineProperty(globalThis,'window',{configurable:true,value:{}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{}});
  try{
    await assert.rejects(f.make().addGoal(doc,'后补目标',true),/安全.*锁|不支持.*锁/);
    assert.equal(f.children.get(doc),undefined);
  }finally{
    if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');
    if(originalNavigator)Object.defineProperty(globalThis,'navigator',originalNavigator);else Reflect.deleteProperty(globalThis,'navigator');
  }
});

test('a completed operation in another window does not leave a ghost pending record',async()=>{
  const f=fixture();f.timeout=true;f.matches=[];
  const first=f.make();assert.equal((await first.submit(blank)).kind,'pending');
  assert.equal((await first.pending()).length,1);
  f.matches=[doc];f.timeout=false;
  const resumed=await f.make().resume((await first.pending())[0].id);
  assert.equal(resumed.kind,'complete');assert.equal((await first.pending()).length,0);
});

test('an unfinished Work creation blocks a separate Goal write on the same document',async()=>{
  const f=fixture(),id='work-create:old';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  await assert.rejects(f.make().addGoal(doc,'另一个目标',true),/先核对|待核对/);
  assert.equal((await f.store.listPending()).length,1);assert.equal(f.children.get(doc),undefined);
});

test('a conflicting Goal pending record is preserved instead of overwritten',async()=>{
  const f=fixture();f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  const conflicting={id:`work-goal:${doc}`,kind:'task' as const,workId:doc,state:'unknown' as const,details:'{}',updatedAt:'2026-09-30'};
  await f.store.setPending(conflicting);
  await assert.rejects(f.make().addGoal(doc,'目标',true),/记录.*损坏|冲突/);
  assert.deepEqual((await f.store.listPending())[0],conflicting);
  assert.equal(f.children.get(doc),undefined);
});

test('setting aside a blocked existing-document creation preserves its record and only permits a different target',async()=>{
  const f=fixture(),id='work-create:test-blocked';f.attrs.set(doc,{'custom-ai-work-v0':'1'});
  await f.store.registerWork(doc);await f.store.linkTask({taskId:'existing-task',workId:doc,connectionId:'siyuan-native-local'});
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  const creator=f.make() as any,formal=structuredClone(f.disk.get('work-formal-v2')),pending=structuredClone(f.disk.get('work-pending-v1'));
  assert.equal(typeof creator.setAsideExistingCreation,'function');
  await assert.rejects(creator.setAsideExistingCreation(id,false),/确认/);
  f.failSave=true;await creator.setAsideExistingCreation(id,true);f.failSave=false;
  assert.deepEqual(f.disk.get('work-pending-v1'),pending);assert.deepEqual(f.disk.get('work-formal-v2'),formal);assert.deepEqual(f.attrs.get(doc),{'custom-ai-work-v0':'1'});assert.equal(f.creates,0);
  await assert.rejects(creator.submit({...blank,mode:'current',documentId:doc}),/核对/);
  await assert.rejects(f.make().submit(blank),/核对/);
  assert.equal((await creator.submit(blank)).kind,'complete');
  assert.equal((await creator.pending()).length,1);
});

test('an unknown new-document result and unreadable existing document cannot be ended',async()=>{
  const f=fixture();f.timeout=true;f.matches=[];const creator=f.make() as any;
  const result=await creator.submit(blank);assert.equal(typeof creator.setAsideExistingCreation,'function');
  await assert.rejects(creator.setAsideExistingCreation(result.operationId,true),/新文档|未知|核对/);assert.equal((await creator.pending()).length,1);assert.equal(f.creates,1);
  const offline=fixture(),id='work-create:offline',offlineCreator=offline.make() as any;
  await offline.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc},documentId:doc,workReady:false}),updatedAt:'2026-09-30'});
  offline.host.getAttrs=async()=>{throw Error('offline');};await assert.rejects(offlineCreator.setAsideExistingCreation(id,true),/offline/);assert.equal((await offlineCreator.pending()).length,1);
});

test('partially successful creation with an outdated workReady flag remains fully recorded when set aside',async()=>{
  const f=fixture(),save=f.store.setPending.bind(f.store);
  f.store.setPending=async(p)=>{if(JSON.parse(p.details).workReady)throw Error('ready-state save failed');await save(p);};
  const result=await f.make().submit({...blank,mode:'current',documentId:doc});assert.equal(result.kind,'partial');
  assert.equal(JSON.parse((await f.store.listPending())[0].details).workReady,false);assert.ok((await f.store.listWorks()).includes(doc));
  f.children.set(doc,[]);const reopened=f.make() as any,before=structuredClone(f.disk.get('work-pending-v1'));
  assert.equal(typeof reopened.setAsideExistingCreation,'function');await reopened.setAsideExistingCreation(result.operationId,true);
  assert.deepEqual(f.disk.get('work-pending-v1'),before);assert.ok((await f.store.listWorks()).includes(doc));
  await assert.rejects(reopened.submit({...blank,mode:'current',documentId:doc}),/核对/);
  const unrelated='work-create:another-unknown';await save({id:unrelated,kind:'work',workId:null,state:'unknown',details:JSON.stringify({version:1,input:blank,documentId:null,workReady:false}),updatedAt:'2026-09-30'});
  await assert.rejects(reopened.submit({...blank,title:'其他工作'}),/核对/);assert.equal((await f.store.listPending()).length,2);
});

test('task identity is rechecked before creation and before final association',async()=>{
  for(const mismatchAt of [1,2]){
    const f=fixture();let calls=0;f.tasks.getTask=async()=>({kind:'found',value:{id:++calls===mismatchAt?'different-task':'selected-task',title:'任务',completed:false}});
    if(mismatchAt===1){await assert.rejects(f.make().submit({...blank,taskId:'selected-task'}),/ID|身份/);assert.equal(f.creates,0);assert.equal((await f.store.listPending()).length,0);}
    else {const result=await f.make().submit({...blank,taskId:'selected-task'});assert.equal(result.kind,'partial');assert.equal(f.creates,1);assert.equal((await f.store.listTasks(doc)).length,0);assert.equal((await f.store.listPending()).length,1);}
  }
});

test('a task changed after explicit form selection stops Work creation before native writes',async()=>{
  const f=fixture(),selected={id:'task-1',title:'原任务',documentId:doc,projectId:'project-a'};
  f.tasks.getTask=async()=>({kind:'found',value:{...selected,title:'后来改名',completed:false,createdAt:''}});
  await assert.rejects(f.make().submit({...blank,taskId:selected.id,taskSelection:selected}),/变化.*重新选择|重新.*核对/);
  assert.equal(f.creates,0);assert.deepEqual(await f.store.listPending(),[]);assert.deepEqual(await f.store.listWorks(),[]);
});

for(const change of ['completed','identity','work-marker','owner'] as const)test(`queued Work creation relation rechecks ${change} before saving`,async()=>{
  const f=fixture(),live={id:'task-1',title:'原任务',completed:false,documentId:doc,projectId:'project-a',createdAt:''};
  let reads=0,entered!:()=>void,release!:()=>void,queued!:()=>void,blocker:Promise<void>|undefined,otherClaims:Promise<unknown>|undefined;
  const enteredQueue=new Promise<void>(resolve=>{entered=resolve;}),releaseQueue=new Promise<void>(resolve=>{release=resolve;}),relationQueued=new Promise<void>(resolve=>{queued=resolve;});
  const originalLink=f.store.linkTask.bind(f.store),other='20260929120002-abcdef0';
  f.tasks.getTask=async()=>{
    if(++reads===2){
      // Keep a real WorkStore mutation ahead of linkTask, then alter the native state
      // after its second preflight read but before the relation queue executes.
      blocker=(f.store as any).enqueue(async()=>{entered();await releaseQueue;});
      await enteredQueue;
      if(change==='owner'){
        const registered=f.store.registerWork(other),claimed=originalLink({taskId:live.id,workId:other,connectionId:'siyuan-native-local'});
        otherClaims=Promise.all([registered,claimed]);
      }
    }
    return {kind:'found',value:{...live}};
  };
  f.store.linkTask=(link,guard)=>{const pending=originalLink(link,guard);queued();return pending;};
  const creating=f.make().submit({...blank,taskId:live.id,taskSelection:{id:live.id,title:live.title,documentId:live.documentId,projectId:live.projectId}});
  await relationQueued;
  if(change==='completed')live.completed=true;
  if(change==='identity'){live.title='后来改名';live.documentId='20260929120002-abcdef0';live.projectId='project-b';}
  if(change==='work-marker')f.attrs.set(doc,{});
  release();await blocker;await otherClaims;
  const result=await creating;
  assert.equal(result.kind,'partial');assert.match(result.message,/重新手选|重新选择|重新核对|标记|其他 Work/);
  if(change==='identity')assert.match(result.message,/跳过.*Work 管理.*重新手选/);
  if(change==='owner')assert.match(result.message,/所选任务已有其他 Work.*重新手选其他任务/);
  if(change==='work-marker')assert.equal(result.work,null);
  else assert.equal(result.work?.id,doc);
  assert.deepEqual(await f.store.listTasks(doc),[]);
  if(change==='owner')assert.deepEqual((await f.store.listTasks(other)).map(link=>link.taskId),[live.id]);
  assert.equal((await f.store.listPending()).length,1);
  assert.deepEqual(JSON.parse((await f.store.listPending())[0].details).input.taskSelection,{id:'task-1',title:'原任务',documentId:doc,projectId:'project-a'});
});

test('new pending task identity survives restart and a changed task can only be skipped',async()=>{
  const f=fixture(),selected={id:'task-1',title:'原任务',documentId:doc,projectId:'project-a'};
  let reads=0;
  f.tasks.getTask=async()=>++reads===1?{kind:'found',value:{...selected,completed:false,createdAt:''}}:{kind:'unavailable',reason:'暂时失联'};
  const initial=await f.make().submit({...blank,taskId:selected.id,taskSelection:selected});
  assert.equal(initial.kind,'partial');assert.equal(f.creates,1);
  assert.deepEqual(JSON.parse((await f.store.listPending())[0].details).input.taskSelection,selected);
  f.tasks.getTask=async()=>({kind:'found',value:{...selected,projectId:'project-b',completed:false,createdAt:''}});
  const resumed=await f.make().resume(initial.operationId);
  assert.equal(resumed.kind,'partial');assert.match(resumed.message,/变化.*重新选择|重新.*核对/);
  assert.deepEqual(await f.store.listTasks(doc),[]);assert.equal(f.creates,1);
  const skipped=await f.make().resume(initial.operationId,true);
  assert.equal(skipped.kind,'complete');assert.match(skipped.message,/未关联任务/);
  assert.deepEqual(await f.store.listPending(),[]);assert.equal(f.creates,1);
});

test('legacy v1 pending saves its first verified task identity before queued association',async()=>{
  const f=fixture(),id='work-create:legacy-task',selected={id:'task-1',title:'旧任务',documentId:null,projectId:null};
  f.attrs.set(doc,{'custom-ai-work-v0':'1'});await f.store.registerWork(doc);
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc,taskId:selected.id},documentId:doc,workReady:true}),updatedAt:'2026-10-01'});
  f.tasks.getTask=async()=>({kind:'found',value:{...selected,completed:false,createdAt:''}});
  const originalLink=f.store.linkTask.bind(f.store);let savedBeforeQueue=false;
  f.store.linkTask=async(link,guard)=>{
    const pending=(await f.store.listPending()).find(p=>p.id===id)!;
    savedBeforeQueue=JSON.stringify(JSON.parse(pending.details).input.taskSelection)===JSON.stringify(selected);
    return originalLink(link,guard);
  };
  const result=await f.make().resume(id);
  assert.equal(result.kind,'complete');assert.equal(savedBeforeQueue,true);
  assert.deepEqual(await f.store.listTasks(doc),[{taskId:selected.id,workId:doc,connectionId:'siyuan-native-local'}]);
  assert.deepEqual(await f.store.listPending(),[]);assert.equal(f.creates,0);
});

test('legacy pending stays partial when its new task baseline cannot be persisted',async()=>{
  const f=fixture(),id='work-create:legacy-save',selected={id:'task-1',title:'旧任务',documentId:null,projectId:null};
  f.attrs.set(doc,{'custom-ai-work-v0':'1'});await f.store.registerWork(doc);
  await f.store.setPending({id,kind:'work',workId:doc,state:'partial',details:JSON.stringify({version:1,input:{...blank,mode:'current',documentId:doc,taskId:selected.id},documentId:doc,workReady:true}),updatedAt:'2026-10-01'});
  f.tasks.getTask=async()=>({kind:'found',value:{...selected,completed:false,createdAt:''}});
  const originalSave=f.store.setPending.bind(f.store);
  f.store.setPending=async pending=>{if(JSON.parse(pending.details).input.taskSelection)throw Error('snapshot disk failed');return originalSave(pending);};
  const result=await f.make().resume(id);
  assert.equal(result.kind,'partial');assert.match(result.message,/snapshot disk failed/);
  assert.deepEqual(await f.store.listTasks(doc),[]);
  assert.equal(JSON.parse((await f.store.listPending())[0].details).input.taskSelection,undefined);
  f.store.setPending=originalSave;
  const skipped=await f.make().resume(id,true);
  assert.equal(skipped.kind,'complete');assert.deepEqual(await f.store.listPending(),[]);
});

test('native blank Work persists intent before one create and preserves optional tasks',async()=>{
  assert.equal(typeof creation.WorkCreator,'function');
  const f=fixture(), c=f.make(); const original=f.host.createDocument;
  f.host.createDocument=async(...args)=>{assert.equal((await f.store.listPending()).length,1);return original(...args);};
  const result=await c.submit(blank);
  assert.equal(result.kind,'complete');assert.equal(result.work?.id,doc);assert.equal(f.creates,1);assert.equal((await f.store.listPending()).length,0);
});
test('unknown native response reconciles marker; restart never blindly resubmits',async()=>{
  const f=fixture();f.timeout=true;f.matches=[];
  const result=await f.make().submit(blank);assert.equal(result.kind,'pending');assert.equal(f.creates,1);
  const reopened=f.make(); await assert.rejects(reopened.submit(blank),/核对/);
  f.matches=[doc]; const resumed=await reopened.resume(result.operationId);
  assert.equal(resumed.kind,'complete');assert.equal(f.creates,1);
});
test('same path and unsafe title refuse before mutation; save failure prevents create',async()=>{
  const f=fixture(),c=f.make();
  for(const title of ['', '  ', 'a/b', '../x','a\\b']) await assert.rejects(c.submit({...blank,title}));
  f.host.getDocumentIdsByPath=async()=>[doc];await assert.rejects(c.submit(blank),/同名/);assert.equal(f.creates,0);
  f.host.getDocumentIdsByPath=async()=>[];f.failSave=true;await assert.rejects(c.submit(blank),/disk failed/);assert.equal(f.creates,0);
});
test('frozen existing document reuses Work and original blocks without native create',async()=>{
  const f=fixture();f.children.set(doc,['original']);
  const input={...blank,mode:'current' as const,documentId:doc,title:'过期名称'};
  const a=await f.make().submit(input),b=await f.make().submit({...input,goal:'不会覆盖'});
  assert.equal(a.work?.title,'原文档');assert.equal(b.work?.goal,'验收目标');assert.equal(f.creates,0);assert.equal(f.children.get(doc)?.length,2);
});
test('duplicate clicks cannot race; ambiguous marker remains pending',async()=>{
  const f=fixture(),c=f.make(); f.matches=[doc,'20260929120002-abcdef0'];
  const first=c.submit(blank);await assert.rejects(c.submit(blank),/进行/);
  const result=await first;assert.equal(result.kind,'pending');assert.equal(f.creates,1);assert.equal(await f.service.readWork(doc),null);
});
test('post-create task failure is partial and association-only resume cannot duplicate document',async()=>{
  const f=fixture();let calls=0;
  f.tasks.getTask=async()=>({kind:'found',value:{id:'t',title:'任务',completed:++calls>1}});
  const result=await f.make().submit({...blank,taskId:'t'});assert.equal(result.kind,'partial');assert.equal(result.work?.id,doc);
  f.tasks.getTask=async()=>({kind:'found',value:{id:'t',title:'任务',completed:false}});
  const resumed=await f.make().resume(result.operationId);assert.equal(resumed.kind,'complete');assert.equal(f.creates,1);assert.equal((await f.store.listTasks(doc)).length,1);
});
test('malformed native attrs and children reads must not become evidence for new Goal',async()=>{
  const host=new SiYuanWorkHost(async()=>null);
  await assert.rejects(host.getAttrs(doc),/格式/);await assert.rejects(host.getChildren(doc),/格式/);
  for(const malformed of [null,{},[]]){
    const unreadable=new SiYuanWorkHost(async()=>malformed);
    await assert.rejects(unreadable.getBlockMarkdown(doc),/格式/);
  }
  const empty=new SiYuanWorkHost(async()=>({kramdown:''}));assert.equal(await empty.getBlockMarkdown(doc),'');
});

test('preflight completed, missing, offline and other-owner tasks do not write a document',async()=>{
  const f=fixture();
  for(const state of [{kind:'missing'},{kind:'unavailable',reason:'disconnected'},{kind:'found',value:{completed:true}}]){
    f.tasks.getTask=async()=>state;await assert.rejects(f.make().submit({...blank,taskId:'t'}));
  }
  await f.store.registerWork('20260929120002-abcdef0');await f.store.linkTask({taskId:'t',workId:'20260929120002-abcdef0',connectionId:'siyuan-native-local'});
  f.tasks.getTask=async()=>({kind:'found',value:{id:'t',completed:false}});
  await assert.rejects(f.make().submit({...blank,taskId:'t'}),/其他 Work/);assert.equal(f.creates,0);
});
test('post-write storage failure fences another submit and restart can reconcile stored intent',async()=>{
  const f=fixture(),c=f.make(),native=f.host.createDocument;
  f.host.createDocument=async(...args)=>{const id=await native(...args);f.failSave=true;return id;};
  const result=await c.submit(blank);assert.equal(result.kind,'pending');assert.equal(f.creates,1);
  await assert.rejects(c.submit(blank),/核对/);f.failSave=false;
  const resumed=await f.make().resume(result.operationId);assert.equal(resumed.kind,'complete');assert.equal(f.creates,1);
});
test('prepare defaults to captured notebook, no-editor requires explicit notebook, current rejects closed notebook',async()=>{
  const f=fixture(),c=f.make();
  assert.equal((await c.prepare({documentId:doc,title:'旧标题'})).notebookId,box);
  assert.equal((await c.prepare(null)).notebookId,'');
  await assert.rejects(c.submit({...blank,notebookId:''}),/笔记本/);
  f.host.listNotebooks=async()=>[];
  await assert.rejects(c.submit({...blank,mode:'current',documentId:doc}),/笔记本/);
});

test('configured default notebook takes precedence for new documents and keeps existing document location distinct',async()=>{
  const f=fixture(),preferred='20260929120004-abcdef0';
  f.host.listNotebooks=async()=>[{id:box,name:'原笔记本'},{id:preferred,name:'默认工作本'}];
  const prepared=await f.make().prepare({documentId:doc,title:'原文档'},preferred);
  assert.equal(prepared.notebookId,preferred);assert.equal(prepared.contextNotebookId,box);
  assert.equal((await f.make().prepare(null,preferred)).notebookId,preferred);
  const unavailable=await f.make().prepare(null,'20260929120005-abcdef0');
  assert.equal(unavailable.notebookId,'');assert.match(unavailable.locationError,/默认.*未打开/);
});

test('native document search preserves title characters and rejects malformed identities',async()=>{
  let statement='',malformed=false;
  const host=new SiYuanWorkHost(async(_path,body)=>{statement=String(body.stmt);return [{id:doc,content:"O'Brien 的资料",box:malformed?'other':box}];});
  assert.deepEqual(await host.searchDocuments("O'Brien",[box]),[{id:doc,title:"O'Brien 的资料",notebookId:box}]);
  assert.match(statement,/O''Brien/);assert.match(statement,/box in \('20260929120001-abcdef0'\)/);
  malformed=true;await assert.rejects(host.searchDocuments('资料',[box]),/格式错误/);
});
test('native host uses API path and child attrs marker identity; mismatched direct attrs never adopt',async()=>{
  const operation='work-create:abc123',child='20260929120003-abcdef0';let wrong=false;const calls:{path:string,body:Record<string,unknown>}[]=[];
  const host=new SiYuanWorkHost(async(path,body)=>{
    calls.push({path,body});
    if(path==='/api/notebook/lsNotebooks')return {notebooks:[{id:box,name:'打开',closed:false},{id:doc,name:'关闭',closed:true}]};
    if(path==='/api/filetree/createDocWithMd')return doc;
    if(path==='/api/filetree/getIDsByHPath')return [];
    if(path==='/api/attr/getBlockAttrs')return {'custom-ai-work-create-op':wrong?'foreign':operation};
    const sql=String(body.stmt);
    if(sql.includes('from attributes'))return [{block_id:child,root_id:doc}];
    if(sql.includes('select box'))return [{box}];
    if(sql.includes('select root_id'))return [{root_id:doc}];
    throw new Error(`unexpected ${path}`);
  });
  assert.deepEqual(await host.listNotebooks(),[{id:box,name:'打开'}]);
  await host.getDocumentIdsByPath(box,'工作');assert.equal(calls.at(-1)?.body.path,'/工作');
  assert.equal(await host.createDocument(box,'工作',operation),doc);
  assert.deepEqual(calls.at(-1),{path:'/api/filetree/createDocWithMd',body:{notebook:box,path:'/工作',markdown:'Work 创建记录\n{: custom-ai-work-create-op="work-create:abc123"}'}});
  assert.deepEqual(await host.findCreatedDocuments(box,operation),[doc]);
  const query=calls.find(c=>String(c.body.stmt).includes('from attributes'))!;
  assert.match(String(query.body.stmt),/box = '20260929120001-abcdef0'/);
  assert.match(String(query.body.stmt),/name = 'custom-ai-work-create-op'/);
  assert.equal(calls.some(c=>c.path.includes('exportMdContent')),false);
  wrong=true;await assert.rejects(host.findCreatedDocuments(box,operation),/不一致/);
});

test('timeout after native write can immediately reconcile marker without repeat',async()=>{
  const f=fixture();f.timeout=true;const result=await f.make().submit(blank);assert.equal(result.kind,'complete');assert.equal(f.creates,1);
});
test('native create request has a bounded unknown result instead of holding the form forever',{timeout:2000},async()=>{
  const host=new SiYuanWorkHost(async()=>new Promise(()=>{}),10);
  await assert.rejects(host.createDocument(box,'工作','work-create:abc123'),/超时.*未知/);
});

test('existing document search has a bounded read timeout with a retry instruction',{timeout:2000},async()=>{
  const host=new SiYuanWorkHost(async()=>new Promise(()=>{}),10);
  await assert.rejects(host.searchDocuments('目标',[box]),/搜索超时.*重试/);
});
test('concurrent external-document associations reuse one reference',async()=>{
  const f=fixture();await f.make().submit({...blank,mode:'current',documentId:doc});
  await Promise.all([f.service.linkExternalDocument(doc,box,true),f.service.linkExternalDocument(doc,box,true)]);
  // The fixture parses role attributes to make references readable just like native IAL.
  assert.equal(f.children.get(doc)?.length,2);
});
test('failed creation relation saves do not mutate cached storage into false success on retry',async()=>{
  const cache:Record<string,unknown>={'work-formal-v2':{schema:2,works:[],chats:[],tasks:[],pins:{}},'work-pending-v1':{schema:1,items:[]}};
  let fail=true,saves=0;
  const store=new WorkStore({loadData:key=>cache[key],saveData:(key,value)=>{saves++;if(fail)throw new Error('disk failure');cache[key]=value;}});
  await assert.rejects(store.registerWork(doc));assert.deepEqual(await store.listWorks(),[]);
  fail=false;await store.registerWork(doc);fail=true;
  await assert.rejects(store.linkTask({taskId:'t',workId:doc,connectionId:'siyuan-native-local'}));assert.deepEqual(await store.listTasks(doc),[]);
  await assert.rejects(store.setPending({id:'pending',kind:'work',workId:doc,state:'partial',details:'test',updatedAt:''}));assert.deepEqual(await store.listPending(),[]);
  fail=false;await store.linkTask({taskId:'t',workId:doc,connectionId:'siyuan-native-local'});assert.equal(saves,5);
});

for(const reopen of [false,true])test(`skip recovery preserves a committed task when pending cleanup failed (reopen=${reopen})`,async()=>{
  const f=fixture(),creator=f.make();f.failClearPending=true;
  f.tasks.getTask=async()=>({kind:'found',value:{id:'t',title:'任务',completed:false}});
  const initial=await creator.submit({...blank,taskId:'t'});
  assert.equal(initial.kind,'partial');assert.match(initial.message,/clear failed/);
  assert.deepEqual(await f.store.listTasks(doc),[{taskId:'t',workId:doc,connectionId:'siyuan-native-local'}]);
  f.failClearPending=false;
  f.tasks.getTask=async()=>{throw new Error('completed association must not require task service availability');};
  const resumed=await (reopen?f.make():creator).resume(initial.operationId,true);
  assert.equal(resumed.kind,'complete');assert.match(resumed.message,/任务.*关联.*保留/);assert.doesNotMatch(resumed.message,/未关联任务/);
  assert.deepEqual(await f.store.listTasks(doc),[{taskId:'t',workId:doc,connectionId:'siyuan-native-local'}]);
  assert.equal((await f.store.listPending()).length,0);assert.equal(f.creates,1);
});
test('skip recovery only skips an uncommitted task after reading actual formal relations',async()=>{
  const f=fixture();let lookups=0;
  f.tasks.getTask=async()=>({kind:'found',value:{id:'t',title:'任务',completed:++lookups>1}});
  const initial=await f.make().submit({...blank,taskId:'t'});assert.equal(initial.kind,'partial');assert.deepEqual(await f.store.listTasks(doc),[]);
  const resumed=await f.make().resume(initial.operationId,true);
  assert.equal(resumed.kind,'complete');assert.match(resumed.message,/未关联任务/);assert.deepEqual(await f.store.listTasks(doc),[]);
  assert.equal((await f.store.listPending()).length,0);assert.equal(f.creates,1);
});
test('skip recovery retains pending task intent when formal relation read fails',async()=>{
  const f=fixture();f.failClearPending=true;
  f.tasks.getTask=async()=>({kind:'found',value:{id:'t',title:'任务',completed:false}});
  const initial=await f.make().submit({...blank,taskId:'t'});assert.equal(initial.kind,'partial');
  f.failClearPending=false;f.failFormalRead=true;
  const resumed=await f.make().resume(initial.operationId,true);
  assert.equal(resumed.kind,'partial');assert.match(resumed.message,/formal read failed/);
  const pending=await f.store.listPending();assert.equal(pending.length,1);assert.equal(JSON.parse(pending[0].details).input.taskId,'t');
  f.failFormalRead=false;assert.equal((await f.store.listTasks(doc))[0].taskId,'t');assert.equal(f.creates,1);
});
