import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const W='20261008120000-aaaaaaa',D='20261008120001-bbbbbbb';
const task={id:'fictional-selected-task',title:'待关联任务',completed:false,documentId:D,projectId:'fictional-project',createdAt:''};
const temp=mkdtempSync(join(tmpdir(),'task3b-plugin-'));
const bundle=join(temp,'index.cjs');buildSync({entryPoints:['src/index.ts'],bundle:true,platform:'browser',format:'cjs',external:['siyuan'],outfile:bundle});
process.on('exit',()=>rmSync(temp,{recursive:true,force:true}));
const tick=()=>new Promise(r=>setTimeout(r,10));
async function fixture(){
 const dom=new JSDOM('<body><div id="dock"></div><main></main><div id="editor"></div></body>');const doc=dom.window.document;
 Object.assign(globalThis,{document:doc,window:dom.window,MutationObserver:dom.window.MutationObserver});
 let opens=0,calendar=0;const app:any={plugins:[]};
 const editors:any[]=[{protyle:{app,element:doc.querySelector('#editor')!,block:{rootID:W}}}];
 app.plugins=[{app,name:'siyuan-plugin-task-note-management',commands:[{langKey:'shortcutSetDocumentAsTask',editorCallback:(p:any)=>{assert.equal(p,editors[0].protyle);opens++;}},{langKey:'shortcutOpenCalendarView',callback:()=>{calendar++;}}]}];
 const original=(Module as any)._load;
 (Module as any)._load=function(request:string,parent:any,isMain:boolean){if(request==='siyuan')return {Plugin:class{app=app;},getAllEditor:()=>editors,openTab:()=>{assert.fail('association or native entry must not navigate');}};return original.call(this,request,parent,isMain);};
 let C:any;try{const require=createRequire(import.meta.url);delete require.cache[require.resolve(bundle)];C=require(bundle).default;}finally{(Module as any)._load=original;}
 const p:any=new C(),data=new Map();p.loadData=async(k:string)=>data.get(k);p.saveData=async(k:string,v:any)=>data.set(k,structuredClone(v));
 let activeDoc=W;p.currentDocumentId=()=>activeDoc;p.currentFocusBlockId=()=>null;p.workHost.getDocumentTitle=async(id:string)=>id===W?'冻结 Work 文档':'任务实际文档';p.workHost.getDocumentPath=async(id:string)=>`/${id}.sy`;p.workHost.listDescendantDocuments=async()=>[];p.workService.listExternalDocuments=async()=>[];p.workService.readWork=async(id:string)=>({id,title:id===W?'冻结 Work':'其他 Work',goal:'',status:'active'});
 p.taskReader.listRecent=async()=>({kind:'found',value:[task]});p.taskReader.search=async()=>({kind:'found',value:[task]});p.taskReader.getTask=async(id:string)=>{assert.equal(id,task.id);return {kind:'found',value:task};};
 await p.workStore.registerWork(W);p.workController.workId=W;p.workController.documentId=W;
 const root=doc.querySelector<HTMLElement>('#dock')!;p.render(root);await p.onWorkChanged(W);await tick();
 const page=p.mountWorkPage(doc.querySelector('main'),{documentId:W,title:'冻结 Work 文档',focusBlockId:null});await page.refresh();
 const input=root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value='原 Chat 草稿';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));const chat=p.activeThreadId;
 return {p,page,root,input,chat,doc,dom,data,opens:()=>opens,calendar:()=>calendar,setDocument:(id:string)=>activeDoc=id,close(){page.dispose();p.taskDialog?.dispose();for(const r of [...p.roomViews.keys()])p.disposeRoomView(r);p.workController.detach();dom.window.close();}};
}
test('actual ordinary-document dock associates supplemental task without Work and preserves its original task document and Chat',async()=>{
 const f=await fixture();try{const {p,root,input,chat,dom,data}=f;const supplemental='20990101000003-ddddddd';f.setDocument(supplemental);p.workController.workId=null;p.workController.documentId=supplemental;
  const tab=root.querySelector<HTMLButtonElement>('[data-dock-tab="associations"]');assert.ok(tab,'production dock must offer document association');dom.window.confirm=()=>true;tab.click();root.querySelector<HTMLButtonElement>('[data-doc-section="tasks"]')!.click();
  for(let n=0;n<100&&!root.querySelector('[data-doc-action="link-task"]');n++)await tick();root.querySelector<HTMLButtonElement>('[data-doc-action="link-task"]')!.click();
  for(let n=0;n<100&&!root.querySelector('[data-doc-action="edit-task"]');n++)await tick();assert.ok(root.querySelector('[data-doc-action="edit-task"]'));
  assert.deepEqual(data.get('ai-work-document-task-links-v1'),{schema:1,links:[{documentId:supplemental,taskId:task.id,connectionId:'siyuan-native-local'}]});assert.deepEqual(await p.workStore.listTasks(W),[]);assert.equal(task.documentId,D);
  let edited:any[]=[];p.app.plugins[0].openReminderEditDialog=async(...args:any[])=>{edited=args;return true;};root.querySelector<HTMLButtonElement>('[data-doc-action="edit-task"]')!.click();await tick();assert.deepEqual(edited,['',task.id]);
  root.querySelector<HTMLButtonElement>('[data-dock-tab="chat"]')!.click();assert.equal(root.querySelector('[data-composer] textarea'),input);assert.equal(input.value,'原 Chat 草稿');assert.equal(p.activeThreadId,chat);assert.equal(p.workController.currentWorkId,null);
 }finally{f.close();}
});
test('actual Home and Work tasks hooks share native state and association preserves the current Chat',async()=>{
 const f=await fixture();try{const {p,page,doc,input,chat}=f;
  const home=doc.querySelector<HTMLButtonElement>('[data-page-action="create-task"]');assert.ok(home,'Home must offer the connected task entry');home.click();await tick();
  assert.match(doc.querySelector('[data-task-dialog]')!.textContent||'',/冻结 Work 文档/);doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="open-native"]')!.click();await tick();assert.equal(f.opens(),1);doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="close"]')!.click();
  page.show({kind:'detail',workId:W,section:'tasks'});doc.querySelector<HTMLButtonElement>('[data-page-action="create-task"]')!.click();await tick();doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="open-native"]')!.click();await tick();assert.equal(f.opens(),1);doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="close"]')!.click();
  doc.querySelector<HTMLButtonElement>('[data-page-action="link-task"]')!.click();await tick();doc.querySelector<HTMLButtonElement>('[data-task-dialog-select]')!.click();await tick();assert.match(doc.querySelector('[data-task-dialog-confirmation]')!.textContent||'',/任务实际文档/);doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="confirm-link"]')!.click();await tick();
  assert.equal((await p.workStore.listTasks(W)).length,1);assert.equal(p.activeThreadId,chat);assert.equal(input.value,'原 Chat 草稿');assert.equal(p.workController.currentWorkId,W);assert.equal(f.opens(),1);
 }finally{f.close();}
});
test('actual sidebar recent task menu offers native creation and explicit association',async()=>{
 const f=await fixture();try{const {root,doc,p}=f;root.querySelector<HTMLButtonElement>('[data-work-action="recent-tasks"]')!.click();await tick();
  const actions=root.querySelector<HTMLDetailsElement>('.sac-task-menu-actions');assert.ok(actions);assert.equal(actions.open,false);actions.querySelector<HTMLElement>('summary')!.click();assert.equal(actions.open,true);
  const native=root.querySelector<HTMLButtonElement>('[data-work-action="create-task"]');assert.ok(native,'sidebar must connect native entry');assert.ok(root.querySelector('[data-work-action="link-task"]'));
  assert.match(root.querySelector('[data-recent-task-results]')!.textContent||'',/任务实际文档/);native.click();await tick();assert.match(doc.querySelector('[data-task-dialog]')!.textContent||'',/冻结 Work 文档/);doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="open-native"]')!.click();await tick();assert.equal(f.opens(),1);assert.equal((await p.workStore.listTasks(W)).length,0);
 }finally{f.close();}
});
test('actual Home without captured document opens only calendar, never borrows the active editor',async()=>{
 const f=await fixture();try{const {page,doc}=f;page.setContext(null);doc.querySelector<HTMLButtonElement>('[data-page-action="create-task"]')!.click();await tick();doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="open-native"]')!.click();await tick();assert.equal(f.opens(),0);assert.equal(f.calendar(),1);}finally{f.close();}
});
test('actual dialog refuses a stale page and changed controller navigation before native invocation',async()=>{
 const f=await fixture();try{const {page,p,doc}=f;doc.querySelector<HTMLButtonElement>('[data-page-action="create-task"]')!.click();await tick();page.show({kind:'detail',workId:W,section:'tasks'});doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="open-native"]')!.click();await tick();assert.equal(f.opens(),0);assert.match(doc.querySelector('[data-task-dialog]')!.textContent||'',/变化|核对/);
  doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="close"]')!.click();doc.querySelector<HTMLButtonElement>('[data-page-action="create-task"]')!.click();await tick();p.workController.navigationSequence++;doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="open-native"]')!.click();await tick();assert.equal(f.opens(),0);
 }finally{f.close();}
});

test('actual task picker preserves its invoking page button until a relation is saved',async()=>{
 const f=await fixture();try{const {page,doc}=f;page.show({kind:'detail',workId:W,section:'tasks'});const trigger=doc.querySelector<HTMLButtonElement>('[data-page-action="link-task"]')!;trigger.focus();trigger.click();await tick();assert.equal(trigger.isConnected,true,'opening a picker is not a completed relation and must not redraw the page');doc.querySelector<HTMLButtonElement>('[data-task-dialog-action="close"]')!.click();assert.equal(doc.activeElement,trigger);}finally{f.close();}
});

test('actual Work detail opens exact linked native editor without entering Work or requiring Bridge',async()=>{
 const f=await fixture();try{const {p,page,doc,input,chat}=f;const calls:any[]=[];const app=p.app;
  app.plugins[0].openReminderEditDialog=async(block:string,id:string)=>{calls.push([block,id]);return true;};
  await p.workStore.linkTask({workId:W,taskId:task.id,connectionId:'siyuan-native-local'});
  p.workController.workId='other-active-work';p.bridgeToken='';p.connectionOk=false;
  let entered=0;p.workController.enterWork=async()=>{entered++;};p.preparePageSession=async()=>{assert.fail('task edit must not prepare or switch Chat');};
  await page.refresh();page.show({kind:'detail',workId:W,section:'tasks'});const edit=doc.querySelector<HTMLButtonElement>('[data-page-action="edit-task"]');assert.ok(edit);edit.click();await tick();
  assert.deepEqual(calls,[['',task.id]]);assert.equal(entered,0);assert.equal(p.workController.currentWorkId,'other-active-work');assert.equal(p.activeThreadId,chat);assert.equal(input.value,'原 Chat 草稿');assert.equal((await p.workStore.listTasks(W)).length,1);
  assert.match(doc.querySelector('[data-page-notice]')!.textContent||'',/已发起/);assert.match(doc.querySelector('[data-page-notice]')!.textContent||'',/不表示.*保存/);
 }finally{f.close();}
});
for(const change of ['unlinked','foreign-connection','busy','proposal','navigation','work-missing'] as const)test(`actual task edit rechecks formal authority and current scene: ${change}`,async()=>{
 const f=await fixture();try{const {p,page,doc}=f;let invoked=0;p.app.plugins[0].openReminderEditDialog=async()=>{invoked++;return true;};
  await p.workStore.linkTask({workId:W,taskId:task.id,connectionId:'siyuan-native-local'});await page.refresh();page.show({kind:'detail',workId:W,section:'tasks'});
  const list=p.workStore.listTasks.bind(p.workStore);if(change==='unlinked')p.workStore.listTasks=async()=>[];if(change==='foreign-connection')p.workStore.listTasks=async()=>[{workId:W,taskId:task.id,connectionId:'other-native'}];if(change==='busy')p.chatBusy=()=>true;if(change==='proposal')p.pendingProposal={};if(change==='work-missing')p.workService.readWork=async()=>null;
  if(change==='navigation')p.workStore.listTasks=async(id:string)=>{p.workController.navigationSequence++;return list(id);};
  doc.querySelector<HTMLButtonElement>('[data-page-action="edit-task"]')!.click();await tick();assert.equal(invoked,0);assert.match(doc.querySelector('[data-page-notice]')!.textContent||'',/核对|变化|不存在|修改|关联/);
 }finally{f.close();}
});
for(const nextStatus of ['completed','closed'])test(`actual ending Work as ${nextStatus} rereads exact tasks and confirms names without task writes`,async()=>{
 const f=await fixture();try{const {p,page,doc,dom}=f;
  const linked=['甲','乙','丙','丁','戊','己','庚','done','unknown','foreign'];for(const id of linked)await p.workStore.linkTask({workId:W,taskId:id,connectionId:id==='foreign'?'other-native':'siyuan-native-local'});
  p.taskReader.getTask=async(id:string)=>id==='unknown'?{kind:'unavailable',reason:'offline'}:{kind:'found',value:{...task,id,title:id,completed:id==='done'}};
  let workStatus='active',writes=0;const reads:string[]=[];p.workService.readWork=async(id:string)=>({id,title:'虚构Work',goal:'',status:workStatus});p.workService.setStatus=async(id:string,status:string,confirmed:boolean,options:any)=>{assert.equal(id,W);assert.equal(confirmed,true);assert.equal(options.expectedStatus,'active');assert.equal(options.isCurrent(),true);workStatus=status;writes++;};
  await page.refresh();const originalRead=p.taskReader.getTask;p.taskReader.getTask=async(id:string)=>{reads.push(id);return originalRead(id);};page.show({kind:'detail',workId:W});let message='';dom.window.confirm=(text:string)=>{message=text;return false;};
  const select=doc.querySelector<HTMLSelectElement>('[data-work-next-status]')!;select.value=nextStatus;doc.querySelector<HTMLButtonElement>('[data-page-action="set-status"]:not([data-next-status])')!.click();await tick();assert.equal(writes,0);assert.deepEqual(reads,['甲','乙','丙','丁','戊','己','庚','done','unknown']);for(const name of ['甲','乙','丙','丁','戊'])assert.ok(message.includes(name));assert.doesNotMatch(message,/己|庚/);assert.match(message,/另有 2/);assert.match(message,/未知 2/);assert.match(message,/不会更改任务或项目/);
  dom.window.confirm=()=>true;select.value=nextStatus;doc.querySelector<HTMLButtonElement>('[data-page-action="set-status"]:not([data-next-status])')!.click();await tick();assert.equal(workStatus,nextStatus);assert.equal(writes,1);assert.equal((await p.workStore.listTasks(W)).length,10);
 }finally{f.close();}
});
