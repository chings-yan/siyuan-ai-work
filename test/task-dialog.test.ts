import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { existsSync } from 'node:fs';
import { NativeTaskAdapter } from '../src/task/native.ts';
import { WorkController } from '../src/work/controller.ts';
import { WorkService } from '../src/work/service.ts';
import { WorkStore } from '../src/work/store.ts';
import type { TaskView } from '../src/task/reader.ts';
const W='20261008120000-aaaaaaa',D='20261008120001-bbbbbbb';
const task:TaskView={id:'fictional-task',title:'虚构任务',completed:false,documentId:D,projectId:'fictional-project',createdAt:''};
const tick=()=>new Promise(r=>setTimeout(r,0));
async function fixture(command:()=>unknown=()=>{},withDocument=true){
 assert.equal(existsSync(new URL('../src/task/dialog.ts',import.meta.url)),true,'task entry must provide a shared confirmation dialog');
 const {TaskDialog}=await import('../src/task/dialog.ts');
 const dom=new JSDOM('<body><button id="source">任务</button><div id="editor"></div></body>');const doc=dom.window.document;
 const app:any={plugins:[]};let opens=0;
 app.plugins=[{app,name:'siyuan-plugin-task-note-management',commands:[{langKey:'shortcutSetDocumentAsTask',editorCallback:(p:any)=>{assert.equal(p.block.rootID,W);opens++;return command();}},{langKey:'shortcutOpenCalendarView',callback:()=>{opens++;return command();}}]}];
 const native=new NativeTaskAdapter(app,{document:doc,getAllEditor:()=>[{protyle:{app,element:doc.querySelector('#editor')!,block:{rootID:W}}}] as any});
 let current=true,valid=true,lookup=task,searches:string[]=[],reads=0,saves=0,failSave=false;
 const disk=new Map();const store=new WorkStore({loadData:k=>disk.get(k),saveData:(k,v)=>{saves++;if(failSave)throw Error('fictional save offline');disk.set(k,structuredClone(v));}});await store.registerWork(W);saves=0;
 const host:any={getAttrs:async(id:string)=>valid&&id===W?{'custom-ai-work-v0':'1','custom-ai-work-status':'active'}:{},getDocumentTitle:async(id:string)=>id===W?'冻结工作文档':'任务实际文档',getDocumentPath:async(id:string)=>`/${id}.sy`,getChildren:async()=>[],getBlockMarkdown:async()=>''};
 const service=new WorkService(host,store);
 const reader:any={listRecent:async()=>{searches.push('');return {kind:'found',value:[task]};},search:async(q:string)=>{searches.push(q);return {kind:'found',value:[task]};},getTask:async(id:string)=>{reads++;assert.equal(id,task.id);return {kind:'found',value:lookup};}};
 const controller=new WorkController({host,service,store,taskReader:reader,currentDocumentId:()=>W,currentFocusBlockId:()=>null,currentChatId:()=> 'original-chat',isBusy:()=>false,hasPendingWrite:()=>false,openDocument:()=>{assert.fail('association must not navigate');},onWorkChanged:async()=>{assert.fail('association must not change Work/Chat');},onLinkCurrentChat:async()=>{},status:()=>{}});
 const dialog=new TaskDialog(doc,{native,reader,controller,documentTitle:host.getDocumentTitle,readWork:async(id:string)=>service.readWork(id),listWorks:async()=>[{id:W,title:'冻结 Work'}]});
 const source=doc.querySelector<HTMLButtonElement>('#source')!;source.focus();
 await dialog.open({documentId:withDocument?W:null,title:withDocument?'冻结工作文档':'',workId:W,workTitle:'冻结 Work',isCurrent:()=>current},'create');
 const click=(action:string)=>{const b=doc.querySelector<HTMLButtonElement>(`[data-task-dialog-action="${action}"]`);assert.ok(b,action);b.click();};
 return {dialog,doc,dom,native,store,controller,click,source,opens:()=>opens,reads:()=>reads,saves:()=>saves,searches,setCurrent:(v:boolean)=>current=v,setValid:(v:boolean)=>valid=v,setTask:(v:TaskView)=>lookup=v,setSaveFailure:(v:boolean)=>failSave=v,close:()=>{dialog.dispose();controller.detach();dom.window.close();}};
}
test('native entry opens once, keeps the frozen label across close/reopen and never claims creation',async()=>{
 const f=await fixture();try{
  assert.match(f.doc.querySelector('[data-task-dialog]')!.textContent||'',/冻结工作文档/);f.click('open-native');f.click('open-native');await tick();assert.equal(f.opens(),1);assert.equal(f.native.getState().kind,'opened');assert.equal(f.saves(),0);assert.match(f.doc.querySelector('[data-task-dialog]')!.textContent||'',/不表示任务已创建/);
  f.click('close');assert.equal(f.doc.activeElement,f.source);await f.dialog.open({documentId:D,title:'后来文档',isCurrent:()=>true},'create');f.click('open-native');await tick();assert.equal(f.opens(),1);assert.match(f.doc.querySelector('[data-task-dialog]')!.textContent||'',/冻结工作文档/);
 }finally{f.close();}
});
test('no document uses calendar and explicit return is required before another entry',async()=>{
 const f=await fixture(()=>{},false);try{f.click('open-native');await tick();assert.equal(f.native.getState().target?.documentId,null);assert.match(f.doc.querySelector('[data-task-dialog]')!.textContent||'',/没有.*文档|未选择.*文档/);f.click('refresh');await tick();assert.equal(f.native.getState().kind,'opened');f.dom.window.confirm=()=>true;f.click('prepare-next');await tick();assert.equal(f.native.getState().kind,'idle');assert.equal(f.opens(),1);f.click('open-native');await tick();assert.equal(f.opens(),2);}finally{f.close();}
});
test('command result unknown survives refresh and modal replacement without reopening',async()=>{
 const f=await fixture(()=>{throw Error('fictional failure after invocation');});try{f.click('open-native');await tick();assert.equal(f.native.getState().kind,'unknown');f.click('refresh');await tick();f.click('close');await f.dialog.open({documentId:W,title:'冻结工作文档',workId:W,workTitle:'冻结 Work',isCurrent:()=>true});f.click('open-native');await tick();assert.equal(f.opens(),1);assert.match(f.doc.querySelector('[data-task-dialog]')!.textContent||'',/未知|先.*核对/);}finally{f.close();}
});
test('manual selection shows actual document/project and rechecks exact task before association',async()=>{
 const f=await fixture();try{
  f.doc.querySelector<HTMLButtonElement>('[data-task-dialog-select]')!.click();await tick();assert.equal(f.reads(),1);assert.match(f.doc.querySelector('[data-task-dialog-confirmation]')!.textContent||'',/任务实际文档/);assert.match(f.doc.querySelector('[data-task-dialog-confirmation]')!.textContent||'',/fictional-project/);assert.match(f.doc.querySelector('[data-task-dialog-confirmation]')!.textContent||'',/不同/);assert.equal(f.saves(),0);
  f.click('confirm-link');f.click('confirm-link');await tick();assert.equal(f.reads(),3);assert.equal(f.saves(),1);assert.deepEqual(await f.store.listTasks(W),[{taskId:task.id,workId:W,connectionId:'siyuan-native-local'}]);assert.equal(f.opens(),0);
 }finally{f.close();}
});
test('no-document selected task can link without inventing navigation',async()=>{
 const f=await fixture();try{f.setTask({...task,documentId:null,projectId:null});f.doc.querySelector<HTMLButtonElement>('[data-task-dialog-select]')!.click();await tick();assert.match(f.doc.querySelector('[data-task-dialog-confirmation]')!.textContent||'',/没有关联文档/);f.click('confirm-link');await tick();assert.equal((await f.store.listTasks(W)).length,1);}finally{f.close();}
});
for(const change of ['task','work','page','save'])test(`manual selection blocks changed ${change} and never retries native creation`,async()=>{
 const f=await fixture();try{f.click('open-native');await tick();f.doc.querySelector<HTMLButtonElement>('[data-task-dialog-select]')!.click();await tick();if(change==='task')f.setTask({...task,documentId:W});if(change==='work')f.setValid(false);if(change==='page')f.setCurrent(false);if(change==='save')f.setSaveFailure(true);f.click('confirm-link');await tick();assert.deepEqual(await f.store.listTasks(W),[]);assert.equal(f.opens(),1);assert.equal(f.native.getState().kind,'opened');assert.match(f.doc.querySelector('[data-task-dialog]')!.textContent||'',/变化|损坏|核对|失败|offline/);}finally{f.close();}
});
test('search keeps the focused input while reading the explicit query',async()=>{
 const f=await fixture();try{const input=f.doc.querySelector<HTMLInputElement>('[data-task-dialog-query]')!;input.focus();input.value='虚构';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,180));assert.deepEqual(f.searches,['','虚构']);assert.equal(f.doc.querySelector('[data-task-dialog-query]'),input);assert.equal(f.doc.activeElement,input);}finally{f.close();}
});
test('busy native opening traps focus and Escape cannot replace the dialog',async()=>{
 let finish!:()=>void;const f=await fixture(()=>new Promise<void>(r=>finish=r));try{f.click('open-native');await tick();const overlay=f.doc.querySelector('[data-task-dialog]')!;overlay.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.ok(overlay.isConnected);await f.dialog.open({documentId:D,title:'后来文档',isCurrent:()=>true});assert.equal(f.doc.querySelector('[data-task-dialog]'),overlay);finish();await tick();overlay.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(f.doc.querySelector('[data-task-dialog]'),null);}finally{f.close();}
});

test('keyboard focus stays inside the task dialog after an asynchronous selection redraw',async()=>{
 const f=await fixture();try{const choose=f.doc.querySelector<HTMLButtonElement>('[data-task-dialog-select]')!;choose.focus();choose.click();await tick();const overlay=f.doc.querySelector<HTMLElement>('[data-task-dialog]')!;assert.equal(overlay.contains(f.doc.activeElement),true,'redrawing confirmation must retain modal keyboard ownership');const first=f.doc.querySelector<HTMLElement>('[data-task-dialog-action="close"]')!,last=f.doc.querySelector<HTMLElement>('[data-task-dialog-action="confirm-link"]')!;last.focus();last.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));assert.equal(f.doc.activeElement,first);}finally{f.close();}
});
