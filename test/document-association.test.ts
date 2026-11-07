import test from 'node:test';
import assert from 'node:assert/strict';
import {DocumentTaskLinks} from '../src/task/document-links.ts';
import type {TaskView} from '../src/task/reader.ts';
const D='20990101000000-aaaaaaa',W='20990101000001-bbbbbbb',OTHER='20990101000002-ccccccc';
const task:TaskView={id:'fictional-task',title:'原任务',completed:false,documentId:OTHER,projectId:'original-project',createdAt:''};
async function fixture(){
 const module=await import('../src/work/document-association.ts').catch((e:any)=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return {} as any;});
 assert.equal(typeof module.DocumentAssociations,'function','document association authority must exist');
 const disk=new Map<string,unknown>();const storage={loadData:async(k:string)=>disk.get(k),saveData:async(k:string,v:unknown)=>{disk.set(k,structuredClone(v));}};const links=new DocumentTaskLinks(storage);
 let current=D,busy=false,available=true,selected={...task},relation='none',writes=0;
 const deps:any={currentDocumentId:()=>current,isBusy:()=>busy,taskLinks:links,
  taskReader:{getTask:async()=>available?{kind:'found',value:selected}:{kind:'unavailable',reason:'暂不可读'}},
  store:{listWorks:async()=>[W]},host:{getDocumentPath:async(id:string)=>`/${id}.sy`,listDescendantDocuments:async()=>relation==='child'?[D]:[]},
  service:{readWork:async()=>({id:W,title:'原 Work',goal:'目标',status:'active'}),listExternalDocuments:async()=>relation==='reference'?[D]:[],linkExternalDocument:async(_w:string,_d:string,_a:boolean,check:()=>void)=>{check();writes++;relation='reference';}},
 };
 const service=new module.DocumentAssociations(deps);
 return {service,links,disk,storage,deps,writes:()=>writes,select:(t:TaskView)=>selected=t,setCurrent:(id:string)=>current=id,setBusy:()=>busy=true,unavailable:()=>available=false,relation:(r:string)=>relation=r};
}
for(const change of ['title','documentId','projectId','completed','missing'] as const)test(`review I1: changed task during the final relation read prevents persistence: ${change}`,async()=>{
 const f=await fixture();let reads=0;f.storage.loadData=async(k:string)=>{if(++reads===2){if(change==='missing')f.deps.taskReader.getTask=async()=>({kind:'missing'});else f.select({...task,[change]:change==='completed'?true:change==='documentId'?W:'changed'});}return f.disk.get(k);};
 await assert.rejects(f.service.linkTask(D,task,()=>true),/变化|不存在|不可读/);assert.equal(f.disk.size,0);
});
test('ordinary document association preserves native primary document, project and progress; linked completed tasks remain readable',async()=>{
 const f=await fixture();await f.service.linkTask(D,task,()=>true);
 assert.equal((await f.links.list(D))[0].taskId,task.id);assert.deepEqual(task,{id:'fictional-task',title:'原任务',completed:false,documentId:OTHER,projectId:'original-project',createdAt:''});
 f.select({...task,completed:true});const rows=await f.service.listTaskLinks(D);assert.equal(rows[0].task.kind,'found');assert.equal(rows[0].task.value.completed,true);
 f.unavailable();assert.equal((await f.service.listTaskLinks(D))[0].task.kind,'unavailable');assert.equal((await f.links.list(D)).length,1);
 await f.service.unlinkTask(D,task.id,()=>true);assert.deepEqual(await f.links.list(D),[]);
});
for(const change of ['document','busy','view','missing-document','task-title','task-primary','task-project','task-completed','task-block','source'] as const)test(`task confirmation rechecks ${change} before supplemental write`,async()=>{
 const f=await fixture();let current=true;
 if(change==='document')f.setCurrent(OTHER);if(change==='busy')f.setBusy();if(change==='view')current=false;
 if(change==='missing-document')f.deps.host.getDocumentPath=async()=>null;
 if(change==='task-title')f.select({...task,title:'changed'});if(change==='task-primary')f.select({...task,documentId:W});if(change==='task-project')f.select({...task,projectId:'new'});if(change==='task-completed')f.select({...task,completed:true});if(change==='task-block')f.select({...task,blockId:W});if(change==='source')f.unavailable();
 await assert.rejects(f.service.linkTask(D,task,()=>current));assert.equal(f.disk.size,0);
});
test('task validation suspended across navigation cannot write and editor requires exact supplemental pair',async()=>{
 const f=await fixture();f.deps.taskReader.getTask=async()=>{f.setCurrent(OTHER);return {kind:'found',value:task};};
 await assert.rejects(f.service.linkTask(D,task,()=>true));assert.equal(f.disk.size,0);
 f.setCurrent(D);await assert.rejects(f.service.checkTaskLink(D,task.id,()=>true),/关联/);
});
test('Work root/child/external relations are distinguished and never duplicated',async()=>{
 const f=await fixture();let choice=(await f.service.listWorks(D))[0];assert.equal(choice.relation,'none');await f.service.linkWork(D,choice,()=>true);assert.equal(f.writes(),1);
 choice=(await f.service.listWorks(D))[0];assert.equal(choice.relation,'reference');await f.service.linkWork(D,choice,()=>true);assert.equal(f.writes(),1);
 f.relation('child');assert.equal((await f.service.listWorks(D))[0].relation,'child');assert.equal((await f.service.listWorks(W))[0].relation,'root');
});
test('Work confirmation checks fresh metadata and queued guard; missing Work is visible without a link action',async()=>{
 const f=await fixture();const choice=(await f.service.listWorks(D))[0];f.deps.service.linkExternalDocument=async(_w:string,_d:string,_a:boolean,check:()=>void)=>{f.setCurrent(OTHER);check();assert.fail('must not append');};
 await assert.rejects(f.service.linkWork(D,choice,()=>true));f.setCurrent(D);
 f.deps.service.readWork=async()=>({...choice,title:'changed'});await assert.rejects(f.service.linkWork(D,choice,()=>true));
 f.deps.service.readWork=async()=>null;assert.ok((await f.service.listWorks(D))[0].error);assert.equal(f.writes(),0);
});
