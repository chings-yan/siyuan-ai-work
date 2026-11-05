import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,link,W,D,tick} from './shared-ui-fixture.ts';
test('Work 资料确认读取原生可编辑标题，分清资料文档与目标 Work，取消不写入',async()=>{
 const f=await fixture();try{
  const {p,root,dom}=f,source='20261009120000-ccccccc';
  const editor=dom.window.document.createElement('div');editor.className='protyle';
  editor.innerHTML='<div class="protyle-title__input" contenteditable="true">虚构访谈记录</div>';dom.window.document.body.append(editor);
  p.currentDocumentId=()=>source;p.currentEditor=()=>({protyle:{element:editor,block:{rootID:source}}});
  p.workService.readWork=async(id:string)=>({id,title:'虚构工作计划',goal:'',status:'active'});
  const writes:any[]=[];p.workService.linkExternalDocument=async(...args:any[])=>{writes.push(args);};
  let confirmation='';dom.window.confirm=(message:string)=>{confirmation=message;return false;};
  const chat=p.activeThreadId,input=root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value='虚构草稿';
  root.querySelector<HTMLButtonElement>('[data-action="work-picker"]')!.click();await tick();
  assert.match(root.querySelector('.sac-quick-context')!.textContent||'',/虚构访谈记录/);
  root.querySelector<HTMLButtonElement>(`[data-quick-action="link"][data-work-id="${W}"]`)!.click();await tick();
  assert.match(confirmation,/关联当前文档为 Work 资料\n\n资料文档：虚构访谈记录\n目标 Work：虚构工作计划/);
  assert.deepEqual(writes,[]);
  dom.window.confirm=()=>true;root.querySelector<HTMLButtonElement>(`[data-quick-action="link"][data-work-id="${W}"]`)!.click();await tick();
  assert.deepEqual(writes,[[W,source,true]]);assert.equal(p.activeThreadId,chat);assert.equal(input.value,'虚构草稿');
 }finally{f.close();}
});

for(const invalidation of ['closed-page','unloaded-plugin'] as const)test(`资料关联读取目标 Work 时${invalidation}，迟到结果不能确认或写入`,async()=>{
 const f=await fixture();try{
  const {p,dom}=f,source='20261009120000-ccccccc';p.currentDocumentId=()=>source;
  const element=dom.window.document.createElement('main');dom.window.document.body.append(element);
  const page=p.mountWorkPage(element,{documentId:source,title:'虚构资料',focusBlockId:null});await page.refresh();
  let release!:(value:any)=>void,confirmed=0,writes=0;
  p.workService.readWork=()=>new Promise(resolve=>{release=resolve;});
  dom.window.confirm=()=>{confirmed++;return true;};p.workService.linkExternalDocument=async()=>{writes++;};
  element.querySelector<HTMLButtonElement>(`[data-work-card="${W}"] [data-page-action="link"]`)!.click();await tick();assert.equal(typeof release,'function');
  if(invalidation==='closed-page')page.dispose();else p.disposed=true;
  release({id:W,title:'虚构工作计划',goal:'',status:'active'});await tick();
  assert.equal(confirmed,0);assert.equal(writes,0);page.dispose();
 }finally{f.close();}
});

test('工作状态入口确认具体目标，取消、请求处理中和旧页面均不修改状态',async()=>{
 const f=await fixture();try{
  const {p,root,dom}=f;const element=dom.window.document.createElement('main');dom.window.document.body.append(element);
  const page=p.mountWorkPage(element,null);let writes=0,confirmation='';let current=true;
  p.workService.setStatus=async(id:string,status:string,approved:boolean,guard:any)=>{assert.equal(id,W);assert.equal(status,'completed');assert.equal(approved,true);assert.equal(guard.expectedStatus,'active');assert.equal(guard.isCurrent(),true);writes++;};
  dom.window.confirm=(message:string)=>{confirmation=message;return false;};
  assert.equal(await page.options.actions.setStatus(W,'completed','active',()=>current),false);assert.equal(writes,0);
  assert.match(confirmation,/Work.*进行中.*已完成/);assert.match(confirmation,/保留/);
  dom.window.confirm=()=>true;assert.equal(await page.options.actions.setStatus(W,'completed','active',()=>current),true);assert.equal(writes,1);
  p.abortController=new AbortController();await assert.rejects(page.options.actions.setStatus(W,'completed','active',()=>current),/回复|修改/);p.abortController=undefined;
  const read=p.workService.readWork;p.workService.readWork=async(id:string)=>{current=false;return read(id);};
  await assert.rejects(page.options.actions.setStatus(W,'completed','active',()=>current),/页面|状态已变化/);assert.equal(writes,1);
  page.dispose();
 }finally{f.close();}
});

test('侧栏会话选择器按 AI 对话与协作房间分组，切换房间时更新类型标记',async()=>{
 const f=await fixture();try{
  const {p,root}=f;const room={workId:W,roomId:'test-room',connectionId:'ekko-test',deviceId:'device-test',accountUserId:7,roomNameAtLink:'复盘讨论室'};
  p.roomStore.listForWork=async()=>[room];p.renderThreads(root);await tick();
  const select=root.querySelector<HTMLSelectElement>('[data-thread-selector]')!;
  assert.deepEqual([...select.querySelectorAll('optgroup')].map(group=>group.label),['AI 对话 · Hermes','协作房间 · EKKO']);
  const view=p.roomViews.get(root);view.active={link:room};root.querySelector<HTMLElement>('.sac')!.dataset.surface='ekko';p.renderThreads(root);await tick();
  assert.equal(root.querySelector('[data-current-session-kind]')!.textContent,'协作房间');
  assert.equal(JSON.parse(select.value)[0],'ekko');assert.equal(JSON.parse(select.value)[5],room.roomId);
 }finally{f.close();}
});


test('shared frozen Serve reply can browse another document without changing UUID, identity or Resume',async()=>{
 const f=await fixture(),oldFetch=globalThis.fetch;let stream:ReadableStreamDefaultController<Uint8Array>|undefined;
 try{
  const {p,root}=f,a=link('fictional-stream-local');await p.workStore.linkChat(a);p.threads=[p.threadFromLink(a)];p.activeThreadId=a.chatId;p.activateDraft();
  const before={workId:W,documentId:W,focusBlockId:null,chatId:a.chatId,taskId:null,updatedAt:new Date().toISOString()};await p.workStore.saveResume(before);
  p.workController.options.openDocument=async(id:string)=>{f.setDocument(id);await p.workController.refreshFromEditor();};
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);p.prepareRequestSnapshot=async()=>{await gate;return {documentId:W,nearby:[],contextText:'fictional frozen context'};};
  const requests:string[]=[];globalThis.fetch=async(url:any)=>{requests.push(String(url));if(String(url).endsWith('/chat/stream'))return new Response(new ReadableStream<Uint8Array>({start(c){stream=c;}}));if(String(url).endsWith('/chats/'+a.chatId))return Response.json({chat:{...a,kind:a.adapter}});throw Error('unexpected fictional request');};
  f.input.value='fictional frozen question';const sending=p.send(root);await tick();await assert.rejects(p.workController.enterWork(D),/生成|待处理/);release();await tick();assert.ok(stream);
  await p.workController.enterWork(D);assert.equal(p.currentDocumentId(),D);assert.equal(p.workController.currentWorkId,W);assert.equal(p.activeThreadId,a.chatId);const {updatedAt:actualTime,...actualResume}=await p.workStore.getResume(W);const {updatedAt:priorTime,...priorResume}=before;assert.deepEqual(actualResume,priorResume);
  stream.enqueue(new TextEncoder().encode('event: message.delta\ndata: {"delta":"fictional original reply"}\n\n'));await tick();
  stream.enqueue(new TextEncoder().encode('event: run.completed\ndata: {"text":"fictional original reply"}\n\n'));stream.close();stream=undefined;await sending;
  assert.equal(p.activeThreadId,a.chatId);assert.equal(p.workController.currentWorkId,W);assert.deepEqual(await p.workStore.chatLink(a.chatId),a);assert.equal(requests.filter(x=>x.endsWith('/chat/stream')).length,1);assert.match(root.querySelector('[data-messages]')!.textContent||'',/fictional original reply/);
 }finally{stream?.close();globalThis.fetch=oldFetch;f.close();}
});
