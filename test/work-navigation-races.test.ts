import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WorkController } from '../src/work/controller.ts';
import { WorkStore } from '../src/work/store.ts';
import { WorkCreateForm } from '../src/work/create-form.ts';
const A='20260929120000-aaaaaaa', B='20260929120001-aaaaaaa', CHILD='20260929120002-aaaaaaa';
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
async function fixture(){
 const dom=new JSDOM('<div id="root"><div class="sac-header"></div></div>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
 const data=new Map();const store=new WorkStore({loadData:async k=>data.get(k),saveData:async(k,v)=>{data.set(k,structuredClone(v));}});await store.registerWork(A);await store.registerWork(B);
 let editor=A,busy=false,chat='chat-a',connection='connection-a';const opened:string[]=[],status:string[]=[],changed:string[]=[];
 const host:any={getAttrs:async()=>({}),getDocumentPath:async(id:string)=>`/${id===CHILD?A+'/':''}${id}.sy`,getDocumentRoot:async()=>CHILD,getDocumentTitle:async(id:string)=>id,listDescendantDocuments:async()=>[]};
 const service:any={readWork:async(id:string)=>id===CHILD?null:{id,title:id,goal:'目标',status:'active'},listExternalDocuments:async()=>[]};
 const options:any={host,store,service,taskReader:{getTask:async()=>({kind:'missing'})},currentDocumentId:()=>editor,currentFocusBlockId:()=>null,currentChatId:()=>chat,currentConnection:()=>connection,isBusy:()=>busy,hasPendingWrite:()=>false,openDocument:async(id:string)=>{editor=id;opened.push(id);},onWorkChanged:async(id:string)=>{changed.push(id);},onLinkCurrentChat:async()=>{},status:(s:string)=>status.push(s)};
 const controller=new WorkController(options);const root=dom.window.document.querySelector<HTMLElement>('#root')!;controller.attach(root);await controller.enterWork(A);
 return {controller,store,host,service,options,root,dom,opened,status,changed,setBusy:(v:boolean)=>busy=v,setEditor:(v:string)=>editor=v,setChat:(v:string)=>chat=v,setConnection:(v:string)=>connection=v,close(){controller.detach();dom.window.close();}};
}
test('Home document entry restores the prior document on known native failure and keeps original Work/context',async()=>{
 const f=await fixture();try{f.options.openDocument=async()=>{throw Error('原生打开失败');};f.controller.restoreContext({mode:'none',documentIds:[CHILD]});await assert.rejects(f.controller.openDocumentFromPage(B,null,()=>true),/原生打开失败/);assert.equal(f.controller.currentDocumentId,A);assert.equal(f.controller.currentWorkId,A);assert.equal(f.controller.isTransitioning,false);assert.deepEqual(f.controller.contextChoice,{mode:'none',documentIds:[CHILD]});}finally{f.close();}
});
for(const failed of [false,true])test(`late Home native opening ${failed?'failure':'success'} cannot restore or publish over a newer Work`,async()=>{
 const f=await fixture();try{
  const gate=deferred<void>();let opening=false;f.options.openDocument=async(id:string)=>{if(id===CHILD){opening=true;await gate.promise;if(failed)throw Error('原生打开失败');}else f.setEditor(id);};
  const entry=f.controller.openDocumentFromPage(CHILD,null,()=>true);const rejected=assert.rejects(entry,failed?/原生打开失败/:/导航已变化/);
  for(let i=0;i<20&&!opening;i++)await new Promise(r=>setTimeout(r,0));assert.equal(opening,true);await f.controller.enterWork(B);gate.resolve();await rejected;
  assert.equal(f.controller.currentDocumentId,B);assert.equal(f.controller.currentWorkId,B);assert.deepEqual(f.changed,[A,B]);
 }finally{f.close();}
});
test('late explicit Work selection cannot replace the newer Work or open its document',async()=>{
 const f=await fixture();try{const gate=deferred<any>();f.service.readWork=(id:string)=>id===A?gate.promise:Promise.resolve({id,title:id});const slow=f.controller.enterWork(A);await f.controller.enterWork(B);gate.resolve({id:A,title:A});await assert.rejects(slow,/变化|过期|取消/);assert.equal(f.controller.currentWorkId,B);assert.equal(f.controller.currentDocumentId,B);assert.equal(f.opened.at(-1),B);}finally{f.close();}
});
test('native foreign document during busy work is visible but never overwrites old Resume',async()=>{
 const f=await fixture();try{await f.controller.flushResume();f.setBusy(true);f.setEditor(B);await f.controller.refreshDocument(B);f.controller.noteChat();f.controller.noteFocus();await f.controller.flushResume();assert.equal(f.controller.currentWorkId,A);assert.equal(f.controller.currentDocumentId,B);assert.equal((await f.store.getResume(A))?.documentId,A);assert.match(f.status.join(' '),/生成|待处理/);f.setBusy(false);await f.controller.enterWork(B);assert.equal(f.controller.currentWorkId,B);}finally{f.close();}
});

test('等待回复时从 Work 入口打开文档，原 Work、会话及最近位置仍归原请求', async () => {
 const f=await fixture();try{
  await f.controller.flushResume();const saved=await f.store.getResume(A);
  f.options.canBrowseDocuments=()=>true;f.setBusy(true);
  await f.controller.enterWork(B);
  assert.equal(f.opened.at(-1),B);assert.equal(f.controller.currentDocumentId,B);
  assert.equal(f.controller.currentWorkId,A);assert.deepEqual(f.changed,[A]);
  f.controller.noteChat();await f.controller.flushResume();
  assert.deepEqual({...await f.store.getResume(A),updatedAt:''},{...saved,updatedAt:''});
  assert.equal(await f.store.getResume(B),null);
  assert.match(f.status.at(-1)||'',/原会话|原 Work/);
  f.setBusy(false);await f.controller.enterWork(B);assert.equal(f.controller.currentWorkId,B);
 }finally{f.close();}
});

test('回复在原生打开文档期间结束并留下待处理修改时，文档保持浏览且原 Work 不切换', async () => {
 const f=await fixture();try{
  await f.controller.flushResume();const saved=await f.store.getResume(A);
  f.options.canBrowseDocuments=()=>true;f.setBusy(true);
  let pendingWrite=false;f.options.hasPendingWrite=()=>pendingWrite;
  f.options.openDocument=async(id:string)=>{f.setEditor(id);f.opened.push(id);f.setBusy(false);pendingWrite=true;};
  await f.controller.enterWork(B);
  assert.equal(f.controller.currentDocumentId,B);
  assert.equal(f.controller.currentWorkId,A);
  assert.deepEqual(f.changed,[A]);
  await f.controller.flushResume();
  assert.deepEqual({...await f.store.getResume(A),updatedAt:''},{...saved,updatedAt:''});
  assert.equal(await f.store.getResume(B),null);
  assert.match(f.status.at(-1)||'',/原 Work|待处理修改/);
 }finally{f.close();}
});

test('等待回复可继续上次文档，但准备请求和待处理修改仍拒绝此入口', async () => {
 const f=await fixture();try{
  await f.store.saveResume({workId:B,documentId:CHILD,focusBlockId:null,chatId:'chat-b',taskId:null,updatedAt:'2026-10-08T00:00:00Z'});
  f.options.canBrowseDocuments=()=>true;f.setBusy(true);await f.controller.resumeWork(B);
  assert.equal(f.opened.at(-1),CHILD);assert.equal(f.controller.currentWorkId,A);
  const opened=f.opened.length;
  f.options.canBrowseDocuments=()=>false;await assert.rejects(f.controller.enterWork(B),/生成|待处理/);
  f.options.canBrowseDocuments=()=>true;f.options.hasPendingWrite=()=>true;
  await assert.rejects(f.controller.enterWork(B),/生成|待处理/);
  assert.equal(f.opened.length,opened);
 }finally{f.close();}
});

test('等待回复打开失败后恢复原文档，迟到的导航不覆盖更新的文档', async () => {
 const f=await fixture();try{
  f.options.canBrowseDocuments=()=>true;f.setBusy(true);
  f.options.openDocument=async()=>{throw Error('原生打开失败');};
  await assert.rejects(f.controller.enterWork(B),/原生打开失败/);
  assert.equal(f.controller.currentDocumentId,A);assert.equal(f.controller.currentWorkId,A);
  const gate=deferred<any>();f.service.readWork=(id:string)=>id===B?gate.promise:Promise.resolve({id,title:id});
  const pending=f.controller.enterWork(B);const rejected=assert.rejects(pending,/导航已变化/);
  f.setEditor(CHILD);await f.controller.refreshDocument(CHILD);gate.resolve({id:B,title:B});await rejected;
  assert.equal(f.controller.currentDocumentId,CHILD);assert.equal(f.controller.currentWorkId,A);
 }finally{f.close();}
});
test('Resume captures original saved location before selection flush and explicit Enter opens root',async()=>{
 const f=await fixture();try{await f.store.saveResume({workId:A,documentId:CHILD,focusBlockId:null,chatId:null,taskId:null,updatedAt:'2026-09-29T00:00:00Z'});await f.controller.resumeWork(A);assert.equal(f.opened.at(-1),CHILD);await f.controller.enterWork(A);assert.equal(f.opened.at(-1),A);await f.controller.openWorkDocument(A,CHILD);assert.equal(f.opened.at(-1),CHILD);}finally{f.close();}
});
test('pin freezes source selection and rejects a changed Chat or connection before write',async()=>{
 const f=await fixture();try{let writes=0;const gate=deferred<any[]>();f.store.getPins=()=>gate.promise;f.store.setPins=async()=>{writes++;};(f.controller as any).selectedDocuments=new Set([A]);const button=f.dom.window.document.createElement('button');button.dataset.workAction='pin';f.root.append(button);const pending=(f.controller as any).onClick(f.root,{target:button});f.setChat('chat-b');f.setConnection('connection-b');(f.controller as any).selectedDocuments=new Set([B]);gate.resolve([]);await pending;assert.equal(writes,0);assert.match(f.status.join(' '),/变化|切换/);}finally{f.close();}
});
test('creation result stays open with visible error when Enter is refused',async()=>{
 const f=await fixture();try{const creator:any={recentTasks:async()=>({kind:'found',value:[]}),prepare:async()=>({context:null,notebooks:[],notebookId:'',locationError:''}),pending:async()=>[]};const form=new WorkCreateForm(creator,id=>f.controller.enterWork(id));await form.open(null);(form as any).draft.result={work:{id:B},message:'已建立'};(form as any).render();f.setBusy(true);f.dom.window.document.querySelector<HTMLButtonElement>('[data-create-action="enter"]')!.click();await new Promise(r=>setTimeout(r,0));assert.match(f.dom.window.document.querySelector('[role=alert]')?.textContent||'',/生成|待处理/);assert.ok(f.dom.window.document.querySelector('[aria-label="创建 Work"]'));assert.equal(f.controller.currentWorkId,A);form.dispose();}finally{f.close();}
});

test('Task4 delayed task navigation cannot override a newer explicit Work selection',async()=>{
 const f=await fixture();try{const gate=deferred<any>();f.options.taskReader.getTask=()=>gate.promise;const pending=f.controller.enterTask('task-a');await f.controller.enterWork(B);gate.resolve({kind:'found',value:{id:'task-a',title:'A任务',completed:false,documentId:A}});f.dom.window.confirm=()=>false;await assert.rejects(pending,/变化|过期|取消/);assert.equal(f.controller.currentWorkId,B);assert.equal(f.opened.at(-1),B);}finally{f.close();}
});

for(const owner of ['unowned','broken'])test(`task document native switch event does not cancel its own ${owner} entry`,async()=>{
 const f=await fixture();try{
  f.options.taskReader.getTask=async()=>({kind:'found',value:{id:'task',title:'任务',completed:false,documentId:CHILD}});
  f.dom.window.confirm=()=>false;
  if(owner==='broken'){await f.store.linkTask({taskId:'task',workId:B,connectionId:'siyuan-native-local'});const read=f.service.readWork;f.service.readWork=(id:string)=>id===B?Promise.reject(Error('Goal 损坏')):read(id);}
  await f.controller.flushResume();const saved=await f.store.getResume(A);
  f.options.openDocument=async(id:string)=>{f.setEditor(id);f.opened.push(id);await f.controller.refreshFromEditor();};
  await f.controller.enterTask('task');await f.controller.flushResume();
  assert.equal(f.controller.currentDocumentId,CHILD);assert.equal(f.controller.currentWorkId,A);
  assert.match(f.status.at(-1)||'',owner==='broken'?/已打开任务文档.*损坏/:/已打开任务文档.*未建立任务关系/);
  assert.equal(f.controller.currentTask,null);const after=await f.store.getResume(A);
  assert.deepEqual({...after,updatedAt:''},{...saved,updatedAt:''},'flushing the prior Work may update its time but must retain its location and task');
  assert.ok(Number.isFinite(Date.parse(after!.updatedAt)));
 }finally{f.close();}
});

for(const owner of ['unowned','broken'])test(`a newer native document still supersedes pending ${owner} task entry`,async()=>{
 const f=await fixture();try{
  const gate=deferred<void>();f.options.taskReader.getTask=async()=>({kind:'found',value:{id:'task',title:'任务',completed:false,documentId:CHILD}});f.dom.window.confirm=()=>false;
  if(owner==='broken'){await f.store.linkTask({taskId:'task',workId:A,connectionId:'siyuan-native-local'});const read=f.service.readWork;f.service.readWork=(id:string)=>id===A?Promise.reject(Error('Goal 损坏')):read(id);}
  let opening=false;f.options.openDocument=async(id:string)=>{if(id===CHILD){opening=true;f.setEditor(id);await f.controller.refreshFromEditor();await gate.promise;}else f.setEditor(id);};
  const entry=f.controller.enterTask('task');const rejected=assert.rejects(entry,/导航已变化/);
  for(let i=0;i<20&&!opening;i++)await new Promise(r=>setTimeout(r,0));assert.equal(opening,true);
  f.setEditor(B);await f.controller.refreshFromEditor();gate.resolve();await rejected;
  assert.equal(f.controller.currentDocumentId,B);assert.equal(f.controller.currentWorkId,B);
  assert.doesNotMatch(f.status.at(-1)||'',/已打开任务文档/);
 }finally{f.close();}
});

test('native task document opening failure retains the prior task and saved Work location',async()=>{
 const f=await fixture();try{
  await f.store.linkTask({taskId:'owned',workId:A,connectionId:'siyuan-native-local'});
  f.options.taskReader.getTask=async(id:string)=>({kind:'found',value:{id,title:'任务',completed:false,documentId:id==='owned'?A:CHILD}});
  await f.controller.enterTask('owned');await f.controller.flushResume();f.dom.window.confirm=()=>false;
  f.options.openDocument=async()=>{throw Error('原生打开失败');};
  await assert.rejects(f.controller.enterTask('unowned'),/原生打开失败/);await f.controller.flushResume();
  assert.equal(f.controller.currentDocumentId,A);assert.equal(f.controller.isTransitioning,false);
  assert.equal(f.controller.currentTask,'owned');assert.equal((await f.store.getResume(A))?.documentId,A);
  assert.equal((await f.store.getResume(A))?.taskId,'owned');assert.equal((await f.store.listTasks(A)).length,1);
  f.setChat('chat-after-failure');f.options.currentFocusBlockId=()=>CHILD;f.controller.noteFocus();f.controller.noteChat();await f.controller.flushResume();
  assert.equal((await f.store.getResume(A))?.chatId,'chat-after-failure','known failed opening restores Resume recording');
  assert.equal((await f.store.getResume(A))?.focusBlockId,CHILD);
 }finally{f.close();}
});

test('native opening error after editor reached the task does not pretend the old document is current',async()=>{
 const f=await fixture();try{
  f.options.taskReader.getTask=async()=>({kind:'found',value:{id:'task',title:'任务',completed:false,documentId:CHILD}});f.dom.window.confirm=()=>false;
  f.options.openDocument=async(id:string)=>{f.setEditor(id);throw Error('打开返回未知');};
  await assert.rejects(f.controller.enterTask('task'),/打开返回未知/);
  assert.equal(f.controller.currentDocumentId,CHILD);assert.equal(f.controller.currentWorkId,A);
  await f.controller.flushResume();assert.equal((await f.store.getResume(A))?.documentId,A);
 }finally{f.close();}
});

test('late native task opening failure never restores over a newer Work navigation',async()=>{
 const f=await fixture();try{
  const gate=deferred<void>();let opening=false;
  f.options.taskReader.getTask=async()=>({kind:'found',value:{id:'task',title:'任务',completed:false,documentId:CHILD}});f.dom.window.confirm=()=>false;
  f.options.openDocument=async(id:string)=>{if(id===CHILD){opening=true;await gate.promise;throw Error('原生打开失败');}f.setEditor(id);};
  const entry=f.controller.enterTask('task');const rejected=assert.rejects(entry,/原生打开失败/);
  for(let i=0;i<20&&!opening;i++)await new Promise(r=>setTimeout(r,0));assert.equal(opening,true);
  await f.controller.enterWork(B);gate.resolve();await rejected;
  assert.equal(f.controller.currentDocumentId,B);assert.equal(f.controller.currentWorkId,B);
 }finally{f.close();}
});
