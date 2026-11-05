import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { buildSync } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';

const A='20261012120000-aaaaaaa', B='20261012120001-bbbbbbb', W='20261012120002-ccccccc';
const temp=mkdtempSync(join(tmpdir(),'document-chat-plugin-'));
const bundle=join(temp,'index.cjs');
buildSync({entryPoints:['src/index.ts'],bundle:true,platform:'browser',format:'cjs',external:['siyuan'],outfile:bundle});
process.on('exit',()=>rmSync(temp,{recursive:true,force:true}));
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
async function until(predicate:()=>boolean){for(let i=0;i<100&&!predicate();i++)await tick();assert.ok(predicate(),'expected asynchronous operation to start');}
function gate(){let release!:()=>void;const promise=new Promise<void>(resolve=>release=resolve);return {promise,release};}
async function fixture(data=new Map<string,any>(),earlyDraft=''){
 const dom=new JSDOM('<body><div id="dock"></div><div id="editor" class="protyle"><input class="protyle-title__input" value="虚构文档"><div class="protyle-wysiwyg"></div></div></body>');
 Object.assign(globalThis,{document:dom.window.document,window:dom.window,MutationObserver:dom.window.MutationObserver});
 dom.window.confirm=()=>false;
 let active=A;const app={plugins:[]};const editor={protyle:{app,element:dom.window.document.querySelector('#editor'),block:{rootID:A}}};
 const openedDocuments:string[]=[],navigation:{open?: (id:string)=>Promise<void>}={};
 const original=(Module as any)._load;
 (Module as any)._load=function(request:string,parent:any,isMain:boolean){if(request==='siyuan')return {Plugin:class{app=app;},getAllEditor:()=>[editor],openTab:async(input:any)=>{if(!navigation.open)assert.fail('document Chat must not navigate');const id=input.doc.id;openedDocuments.push(id);await navigation.open(id);}};return original.call(this,request,parent,isMain);};
 let C:any;try{const require=createRequire(import.meta.url);delete require.cache[require.resolve(bundle)];C=require(bundle).default;}finally{(Module as any)._load=original;}
 const p:any=new C();p.loadData=async(key:string)=>data.get(key);p.saveData=async(key:string,value:any)=>data.set(key,structuredClone(value));
 const paths=new Map([[A,`/${A}.sy`],[B,`/${B}.sy`],[W,`/${W}.sy`]]),marks=new Set<string>();let readError='';
 // Stub only SiYuan's API port; controller, host, WorkService and WorkStore stay real.
 p.api=async(path:string,body:any)=>{
  if(readError)throw Error(readError);
  if(path==='/api/attr/getBlockAttrs')return marks.has(body.id)?{'custom-ai-work-v0':'1','custom-ai-work-status':'active'}:{};
  if(path==='/api/block/getChildBlocks')return [];
  if(path==='/api/query/sql'){
   const id=body.stmt.match(/id = '([^']+)'/)?.[1];
   if(body.stmt.startsWith('select path'))return paths.has(id)?[{path:paths.get(id)}]:[];
   if(body.stmt.startsWith('select content'))return [{content:'虚构 '+id}];
   if(body.stmt.startsWith('select id'))return [];
   return [];
  }
  if(path==='/api/export/exportMdContent')return {content:'虚构正文 '+body.id};
  throw Error('unexpected SiYuan port '+path);
 };
 const roomStreams=new Map<string,ServerResponse[]>();
 const chats=new Map<string,any>(),calls:{path:string;doc:string;body:any}[]=[];
 const delay={create:null as ReturnType<typeof gate>|null,bind:null as ReturnType<typeof gate>|null,history:null as ReturnType<typeof gate>|null,stream:null as ReturnType<typeof gate>|null};
 let unknownCreate=false,unknownBind=false,queued=false,mismatch=false;
 const json=(res:ServerResponse,value:any)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const body=text?JSON.parse(text):{},path=req.url!,doc=String(req.headers['x-siyuan-document-root']||'');calls.push({path,doc,body});
  if(path==='/ekko/connection')return json(res,{connection:{id:'ekko-a',deviceId:'device-a',accountUserId:7,accountName:'虚构账号',state:'connected'}});
  if(path.startsWith('/ekko/rooms?'))return json(res,{rooms:[{id:'room-a',name:'虚构房间'},{id:'room-b',name:'另一房间'}],total:2,hasMore:false});
  if(path.endsWith('/events')){const id=path.split('/')[3];roomStreams.set(id,[...(roomStreams.get(id)||[]),res]);res.setHeader('Content-Type','text/event-stream');res.write(': keepalive\n\n');return;}
  if(path.startsWith('/ekko/rooms/')&&path.includes('/send-status/'))return json(res,{state:'unknown'});
  if(path.startsWith('/ekko/rooms/')&&path.endsWith('/messages'))return json(res,{state:'unknown'});
  if(path.startsWith('/ekko/rooms/'))return json(res,{room:{id:path.split('/')[3].split('?')[0],name:'虚构房间'},messages:[],agents:[{roomId:path.split('/')[3].split('?')[0],agentId:'fictional-agent',name:'虚构助手'}],hasMore:false});
  if(path==='/connections')return json(res,{data:[connection]});
  if(path==='/connections/serve-local/sessions'||path==='/connections/serve-other/sessions')return json(res,{data:[{id:'remote-existing',title:'虚构已有对话'}]});
  if(path==='/chats'||path==='/chats/bind'){
   await (path==='/chats'?delay.create?.promise:delay.bind?.promise);
   if(path==='/chats'?unknownCreate:unknownBind){res.statusCode=503;return json(res,{error:{code:'synthetic_unknown'}});}
   const chat={chatId:body.chat_id,connectionId:body.connection_id,storedSessionId:body.stored_session_id||null,documentRootId:doc,kind:'serve',profile:'default',installId:'fictional-install',title:body.title,state:body.stored_session_id?'ready':'pending'};
   chats.set(chat.chatId,chat);return json(res,{chat});
  }
  const id=path.split('/')[2],chat=chats.get(id);
  if(path.endsWith('/chat/stream')){
   res.setHeader('Content-Type','text/event-stream');res.write('event: run.started\ndata: {"userRowId":12}\n\n');await delay.stream?.promise;
   if(queued)res.end('event: run.queued\ndata: {}\n\n');
   else{chat.state='ready';chat.storedSessionId ||= 'remote-'+id;res.end('event: run.completed\ndata: {"text":"虚构回复"}\n\n');}return;
  }
  if(path.endsWith('/messages')){await delay.history?.promise;return json(res,{data:[{role:'assistant',content:'虚构历史 '+doc}]});}
  if(chat)return json(res,{chat:mismatch?{...chat,installId:'other-install'}:chat});
  res.statusCode=404;json(res,{});
 });
 const connection={id:'serve-local',kind:'serve',profile:'default',installId:'fictional-install',displayName:'虚构服务',state:'ready'};
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address() as {port:number};p.bridgeUrl=`http://127.0.0.1:${address.port}`;
 p.bridgeToken='fictional-token';p.connectionViews=[connection];p.confirmedConnectionId='serve-local';p.connectionOk=true;
 const root=dom.window.document.querySelector<HTMLElement>('#dock')!;p.render(root);
 if(earlyDraft){const input=root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value=earlyDraft;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));}
 await until(()=>p.workController.currentDocumentId===A&&!p.workController.isTransitioning);
 p.bridgeToken='fictional-token';p.connectionViews=[connection];p.confirmedConnectionId='serve-local';p.connectionOk=true;
 await p.onWorkChanged(null);
 const input=root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
 return {p,root,input,dom,data,chats,calls,delay,paths,marks,roomStreams,openedDocuments,navigation,setBackgroundEditor:(id:string)=>{active=id;editor.protyle.block.rootID=id;},enableNavigation(){navigation.open=async(id:string)=>{active=id;editor.protyle.block.rootID=id;await p.workController.refreshFromEditor();};},emitRoom:(id:string,content:string)=>roomStreams.get(id)?.at(-1)?.write('event: room.message\ndata: '+JSON.stringify({id:'synthetic-event-'+content,roomId:id,content,timestamp:'2026-10-13T00:00:00Z'})+'\n\n'),setReadError:(v:string)=>readError=v,setUnknownCreate:()=>unknownCreate=true,setUnknownBind:()=>unknownBind=true,setQueued:()=>queued=true,setMismatch:()=>mismatch=true,
  async navigate(id:string){active=id;editor.protyle.block.rootID=id;await p.workController.refreshDocument(id);},
  async bind(){await p.associateStudio(root);const radio=dom.window.document.querySelector<HTMLInputElement>('[data-studio-options] input');assert.ok(radio,'standalone document must offer candidates');radio.dispatchEvent(new dom.window.Event('change'));return (dom.window.document.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick as any)();},
  draft(text:string){input.value=text;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));},
  close(){try{delay.create?.release();delay.bind?.release();delay.history?.release();delay.stream?.release();p.taskDialog.dispose();for(const r of [...p.roomViews.keys()])p.disposeRoomView(r);p.workController.detach();}finally{server.closeAllConnections();server.close();dom.window.close();}}
 };
}

async function home(f:Awaited<ReturnType<typeof fixture>>){
 const element=f.dom.window.document.createElement('main');f.dom.window.document.body.append(element);let page:any;
 f.p.workTab={open:async(route:any,context:any)=>{page=f.p.mountWorkPage(element,context);page.show(route);await page.refresh();},refresh:()=>{if(page)void page.refresh();},dispose:()=>page?.dispose()};
 await f.p.openWorkPage({kind:'home'});return {element,page};
}
test('actual zero Work Home freezes the captured editor and opens only that document and existing sidebar with zero formal writes or sends',async()=>{
 const f=await fixture();let page:any;try{
  f.enableNavigation();f.draft('原本地草稿');f.p.workController.restoreContext({mode:'none',documentIds:[]});const before=f.p.workController.contextChoice,original=f.p.activeThreadId;
  const h=await home(f);page=h.page;f.setBackgroundEditor(B);await page.refresh();const button=h.element.querySelector<HTMLButtonElement>('[data-page-action="start-document"]');assert.ok(button);assert.match(h.element.textContent||'',/虚构文档/);
  let shows=0;const show=f.p.showChatDock.bind(f.p);f.p.showChatDock=()=>{shows++;return show();};const data=structuredClone([...f.data]);const requests=f.calls.filter(x=>x.path==='/chats'||x.path==='/chats/bind'||x.path.endsWith('/messages')||x.path.endsWith('/chat/stream')).length;
  button.click();await until(()=>shows===1);assert.deepEqual(f.openedDocuments,[A]);assert.equal(f.p.activeThreadId,original);assert.equal(f.input.value,'原本地草稿');assert.deepEqual(f.p.workController.contextChoice,before);assert.deepEqual([...f.data],data);assert.deepEqual(await f.p.workStore.listWorks(),[]);assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path==='/chats/bind'||x.path.endsWith('/messages')||x.path.endsWith('/chat/stream')).length,requests);
 }finally{page?.dispose();f.close();}
});
test('actual Home navigation during a pending reply retains original request, Chat, draft, references and materials',async()=>{
 const f=await fixture();let page:any,sending:Promise<void>|undefined;try{
  f.enableNavigation();await f.p.startNewChat(f.root);const owner=f.p.activeThreadId;f.setBackgroundEditor(B);const h=await home(f);page=h.page;f.setBackgroundEditor(A);const button=h.element.querySelector<HTMLButtonElement>('[data-page-action="start-document"]');assert.ok(button);
  f.delay.stream=gate();f.draft('原请求');sending=f.p.send(f.root);await until(()=>f.calls.some(x=>x.path.endsWith('/chat/stream')));f.draft('原等待草稿');const request=f.calls.find(x=>x.path.endsWith('/chat/stream'))!,before=f.p.workController.contextChoice,refs=f.p.references;
  button.click();await until(()=>f.openedDocuments.length===1);await tick();assert.deepEqual(f.openedDocuments,[B]);assert.equal(f.p.activeThreadId,owner);assert.equal(f.p.workController.activeDocumentId,A);assert.equal(f.input.value,'原等待草稿');assert.equal(f.p.references,refs);assert.deepEqual(f.p.workController.contextChoice,before);assert.equal(request.doc,A);
  f.delay.stream.release();await sending;assert.ok(f.p.threads.find((t:any)=>t.id===owner).messages.some((m:any)=>m.content==='虚构回复'));assert.equal(f.calls.filter(x=>x.path.endsWith('/chat/stream')).length,1);assert.equal(f.calls.filter(x=>x.path==='/chats').length,1);assert.equal((await f.p.workStore.chatLink(owner)).documentRootId,A);
 }finally{f.delay.stream?.release();f.p.abortController?.abort();try{await sending;}finally{page?.dispose();f.close();}}
});
for(const flag of ['preparing','settingsSaving','accepting','pendingProposal'])test('actual Home entry cannot bypass '+flag,async()=>{
 const f=await fixture();let page:any;try{f.enableNavigation();const h=await home(f);page=h.page;f.p[flag]=flag==='pendingProposal'?{}:true;h.element.querySelector<HTMLButtonElement>('[data-page-action="start-document"]')?.click();await tick();await tick();assert.deepEqual(f.openedDocuments,[]);assert.match(h.element.querySelector('.sac-page-notice')?.textContent||'',/生成|待处理/);}finally{f.p[flag]=false;page?.dispose();f.close();}
});
for(const owners of ['single','multiple'])test('native Home browsing retains original Work and explicit New resolves the captured descendant: '+owners,async()=>{
 const f=await fixture();let page:any;try{
  f.paths.set(A,`/${W}/${A}.sy`);f.marks.add(W);f.marks.add(B);if(owners==='multiple')f.marks.add(A);
  // Deliver the production native-switch handler for both user and programmatic navigation.
  f.navigation.open=async(id:string)=>{f.setBackgroundEditor(id);f.p.onProtyleSwitch();};
  f.setBackgroundEditor(B);f.p.onProtyleSwitch();await until(()=>f.p.workController.currentWorkId===B&&!f.p.workController.isTransitioning);
  f.setBackgroundEditor(A);f.p.onProtyleSwitch();await until(()=>f.p.workController.currentDocumentId===A&&!f.p.workController.isTransitioning);
  if(owners==='single')assert.equal(f.p.workController.currentWorkId,W,'ordinary native navigation identifies the unique marked ancestor');
  else{assert.equal(f.p.workController.currentWorkId,B);assert.match(f.root.querySelector('[data-status]')?.textContent||'',/多个 Work|明确选择/);}
  const h=await home(f);page=h.page;
  f.setBackgroundEditor(B);f.p.onProtyleSwitch();await until(()=>f.p.workController.currentDocumentId===B&&f.p.workController.currentWorkId===B&&!f.p.workController.isTransitioning);
  f.draft('原 Work B 草稿');f.p.workController.restoreContext({mode:'none',documentIds:[B]});const original=f.p.activeThreadId,context=f.p.workController.contextChoice;
  const formal=structuredClone(f.data.get('work-formal-v2')),rooms=structuredClone(f.data.get('work-rooms-v1'));
  const mutations=()=>f.calls.filter(x=>x.path==='/chats'||x.path==='/chats/bind'||x.path.endsWith('/messages')||x.path.endsWith('/chat/stream')).length,before=mutations();
  let shows=0;const show=f.p.showChatDock.bind(f.p);f.p.showChatDock=()=>{shows++;return show();};
  const button=h.element.querySelector<HTMLButtonElement>('[data-page-action="start-document"]');assert.ok(button);button.click();await until(()=>shows===1);await tick();
  assert.deepEqual(f.openedDocuments,[A]);assert.equal(f.p.currentDocumentId(),A);assert.equal(f.p.workController.currentDocumentId,A);assert.equal(f.p.workController.currentWorkId,B,'Home only browses; its own native switch must not select a Work');
  assert.equal(f.p.activeThreadId,original);assert.equal(f.input.value,'原 Work B 草稿');assert.deepEqual(f.p.workController.contextChoice,context);assert.deepEqual(f.data.get('work-formal-v2'),formal);assert.deepEqual(f.data.get('work-rooms-v1'),rooms);assert.equal(mutations(),before);
  // No extra refreshDocument: the explicit action must resolve the displayed document itself.
  await f.p.startNewChat(f.root);
  if(owners==='single'){
   assert.equal(f.p.workController.currentWorkId,W);const link=await f.p.workStore.chatLink(f.p.activeThreadId);assert.equal(link.workId,W);assert.equal(link.documentRootId,A);assert.equal(link.connectionId,'serve-local');assert.equal(link.profile,'default');assert.equal(link.installId,'fictional-install');
   assert.equal(f.calls.filter(x=>x.path==='/chats').length,1);assert.equal(f.calls.find(x=>x.path==='/chats')?.doc,A);assert.equal((await f.p.workStore.listChats(W)).length,1);assert.deepEqual(await f.p.workStore.listChats(B),[]);
  }else{
   assert.equal(f.calls.filter(x=>x.path==='/chats').length,0);assert.equal(f.p.workController.currentWorkId,B);assert.equal(f.p.activeThreadId,original);assert.equal(f.input.value,'原 Work B 草稿');assert.deepEqual(f.p.workController.contextChoice,context);assert.deepEqual(f.data.get('work-formal-v2'),formal);assert.match(f.root.querySelector('[data-status]')?.textContent||'',/多个 Work|明确选择/);
  }
 }finally{page?.dispose();f.close();}
});

test('actual standalone create/associate persists exact scope and reload without manufacturing Work',async()=>{
 const f=await fixture();try{
  await f.p.startNewChat(f.root);const created=f.p.activeThreadId;const createdLink=await f.p.workStore.chatLink(created);assert.ok(createdLink,'standalone new Chat must have a formal link');assert.equal(createdLink.workId,null);assert.equal(createdLink.documentRootId,A);
  f.draft('草稿 A');await f.bind();assert.equal(f.p.activeThreadId,created,'association must keep the selected Chat');assert.equal(f.input.value,'草稿 A');const links=await f.p.workStore.listDocumentChats(A);assert.equal(links.length,2);assert.deepEqual(await f.p.workStore.listWorks(),[]);
  assert.match(f.root.querySelector('[data-status]')?.textContent||'',/当前文档/);
  const restored=await fixture(f.data);try{assert.equal(restored.p.threads.filter((x:any)=>x.connectionId).length,2);assert.ok(restored.p.threads.every((x:any)=>x.documentRootId===A));}finally{restored.close();}
 }finally{f.close();}
});
test('two standalone documents keep multiple selections, drafts and references isolated',async()=>{
 const f=await fixture();try{
  await f.p.startNewChat(f.root);const first=f.p.activeThreadId;f.draft('第一草稿');f.p.references.add({id:'synthetic-ref',blockId:A,documentRootId:A,documentTitle:'虚构',selectedText:'虚构',expectedOriginal:'虚构',capturedBlockKramdown:'虚构',createdAt:'',startOffset:null,endOffset:null});
  await f.p.startNewChat(f.root);const second=f.p.activeThreadId;f.draft('第二草稿');await f.navigate(B);assert.equal(f.input.value,'');assert.equal(f.p.references.list().length,0);
  await f.p.startNewChat(f.root);const third=f.p.activeThreadId;f.draft('B 草稿');await f.navigate(A);assert.equal(f.p.activeThreadId,second);assert.equal(f.input.value,'第二草稿');assert.ok(!f.p.threads.some((x:any)=>x.id===third));
  await f.p.selectChat(f.root,first);assert.equal(f.input.value,'第一草稿');assert.equal(f.p.references.list().length,1);await f.navigate(B);assert.equal(f.p.activeThreadId,third);assert.equal(f.input.value,'B 草稿');
 }finally{f.close();}
});
test('formal nullWork send uses original exact identity and durable pending prevents replay',async()=>{
 const f=await fixture();try{
  await f.p.startNewChat(f.root);f.draft('虚构问题');await f.p.send(f.root);assert.equal(f.calls.filter(x=>x.path.endsWith('/chat/stream')).length,1,'a formal nullWork Chat must send');assert.equal(f.calls.find(x=>x.path.endsWith('/chat/stream'))!.doc,A);assert.equal((await f.p.workStore.chatLink(f.p.activeThreadId)).state,'ready');assert.deepEqual(await f.p.workStore.listPending(),[]);
  f.setQueued();f.draft('虚构排队问题');await f.p.send(f.root);assert.equal((await f.p.workStore.listPending())[0].workId,null);f.draft('保留草稿');await f.p.send(f.root);assert.equal(f.calls.filter(x=>x.path.endsWith('/chat/stream')).length,2);assert.equal(f.input.value,'保留草稿');
 }finally{f.close();}
});
for(const failure of ['mismatch','corrupt','unknown'] as const)test(`nullWork ${failure} prevents synthetic send and retains draft`,async()=>{
 const f=await fixture();try{
  if(failure==='unknown')f.setUnknownCreate();await f.p.startNewChat(f.root);assert.ok((await f.p.workStore.listDocumentChats(A)).length);
  if(failure==='mismatch')f.setMismatch();if(failure==='corrupt')f.data.set('work-formal-v2',{schema:2,works:[],chats:'broken'});
  f.draft('必须保留');await f.p.send(f.root);assert.equal(f.calls.filter(x=>x.path.endsWith('/chat/stream')).length,0);assert.equal(f.input.value,'必须保留');assert.match(f.root.querySelector('[data-status]')?.textContent||'',/身份|待确认|核对|读取/);
 }finally{f.close();}
});
test('delayed standalone create persists only A while B draft and list remain clean',async()=>{
 const f=await fixture();try{
  f.delay.create=gate();const creating=f.p.startNewChat(f.root);await until(()=>f.calls.some(x=>x.path==='/chats'));await f.navigate(B);f.draft('B 独立草稿');const selected=f.p.activeThreadId;f.delay.create.release();await creating;
  assert.equal((await f.p.workStore.listDocumentChats(A)).length,1);assert.deepEqual(await f.p.workStore.listDocumentChats(B),[]);assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'B 独立草稿');assert.ok(f.p.threads.every((x:any)=>x.documentRootId===B));
 }finally{f.close();}
});
test('delayed standalone bind persists A and unknown association reuses its original ID guard',async()=>{
 const f=await fixture();try{
  f.delay.bind=gate();const binding=f.bind();await until(()=>f.calls.some(x=>x.path==='/chats/bind'));await f.navigate(B);f.draft('B 草稿');const selected=f.p.activeThreadId;f.delay.bind.release();await binding;assert.equal((await f.p.workStore.listDocumentChats(A)).length,1);assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'B 草稿');
  await f.navigate(A);await f.navigate(B);f.setUnknownBind();await f.bind();const unknown=(await f.p.workStore.listDocumentChats(B))[0];assert.equal(unknown.state,'unknown');await f.bind();assert.equal(f.calls.filter(x=>x.path==='/chats/bind').length,2);assert.equal((await f.p.workStore.listDocumentChats(B))[0].chatId,unknown.chatId);
 }finally{f.close();}
});
test('delayed nullWork history cannot overwrite B messages or composer',async()=>{
 const f=await fixture();try{
  await f.bind();const linked=(await f.p.workStore.listDocumentChats(A))[0];f.delay.history=gate();const selecting=f.p.selectChat(f.root,linked.chatId);await until(()=>f.calls.some(x=>x.path.endsWith('/messages')));await f.navigate(B);f.draft('B 草稿');const selected=f.p.activeThreadId;f.delay.history.release();await selecting;assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'B 草稿');assert.equal(f.p.threads.find((x:any)=>x.id===selected).messages.length,0);
 }finally{f.close();}
});
test('busy standalone browsing freezes A Chat/request while new document cannot receive its next send',async()=>{
 const f=await fixture();try{
  await f.p.startNewChat(f.root);const selected=f.p.activeThreadId;f.delay.stream=gate();f.draft('A 虚构发送');const sending=f.p.send(f.root);await until(()=>f.calls.some(x=>x.path.endsWith('/chat/stream')));await f.navigate(B);assert.equal(f.p.workController.currentWorkId,null);assert.equal(f.p.activeThreadId,selected);assert.equal(f.p.threads.find((x:any)=>x.id===selected).documentRootId,A);
  f.delay.stream.release();await sending;assert.ok(f.p.threads.find((x:any)=>x.id===selected).messages.some((m:any)=>m.content==='虚构回复'));f.draft('不能偷偷发送到 B');await f.p.send(f.root);assert.equal(f.calls.filter(x=>x.path.endsWith('/chat/stream')).length,1);assert.equal(f.input.value,'不能偷偷发送到 B');
 }finally{f.close();}
});
test('unrelated browsing New explicitly enters document scope instead of attaching old Work',async()=>{
 const f=await fixture();try{
  f.marks.add(W);await f.navigate(W);assert.equal(f.p.workController.currentWorkId,W);await f.p.startNewChat(f.root);const old=f.p.activeThreadId;f.draft('原 Work 草稿');await f.navigate(B);assert.equal(f.p.workController.currentWorkId,W);await f.p.startNewChat(f.root);const link=await f.p.workStore.chatLink(f.p.activeThreadId);assert.equal(link.workId,null);assert.equal(link.documentRootId,B);assert.equal(f.p.workController.currentWorkId,null);assert.equal((await f.p.workStore.listChats(W)).length,1);
  await f.navigate(W);assert.equal(f.p.activeThreadId,old);assert.equal(f.input.value,'原 Work 草稿');
 }finally{f.close();}
});
test('ownership read failure blocks New/Associate mutation and never becomes a clean standalone scene',async()=>{
 const f=await fixture();try{
  f.setReadError('虚构读取失败');await f.navigate(B);await f.p.startNewChat(f.root);await f.p.associateStudio(f.root);assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path==='/chats/bind').length,0);assert.match(f.root.querySelector('[data-status]')?.textContent||'',/读取|核对|重试/);
 }finally{f.close();}
});

test('unknown standalone create keeps the original local ID and blocks duplicate New for that document/connection',async()=>{
 const f=await fixture();try{
  f.setUnknownCreate();await f.p.startNewChat(f.root);const id=f.p.activeThreadId;await f.p.startNewChat(f.root);assert.equal(f.calls.filter(x=>x.path==='/chats').length,1);assert.equal(f.p.activeThreadId,id);assert.equal((await f.p.workStore.listDocumentChats(A)).length,1);
  await f.navigate(B);await f.p.startNewChat(f.root);assert.equal(f.calls.filter(x=>x.path==='/chats').length,2,'another document remains independent');
 }finally{f.close();}
});
for(const result of ['success','unknown'] as const)test(`late ${result} create after Bridge identity changes cannot inject old Chat/status/draft`,async()=>{
 const f=await fixture();try{
  if(result==='unknown')f.setUnknownCreate();f.delay.create=gate();const creating=f.p.startNewChat(f.root);await until(()=>f.calls.some(x=>x.path==='/chats'));
  f.p.bridgeToken='fictional-other-token';await f.p.onWorkChanged(null);f.draft('新连接草稿');const selected=f.p.activeThreadId;f.p.setStatus(f.root,'新连接现状');f.delay.create.release();await creating;
  assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'新连接草稿');assert.equal(f.root.querySelector('[data-status]')?.textContent,'新连接现状');assert.ok(!f.p.threads.some((x:any)=>x.connectionId));assert.equal((await f.p.workStore.listDocumentChats(A)).length,1);
 }finally{f.close();}
});
test('standalone formal list read error remains visible and cannot replace the active scene with an empty success',async()=>{
 const f=await fixture();try{
  await f.p.startNewChat(f.root);const selected=f.p.activeThreadId;f.draft('A 草稿');f.data.set('work-formal-v2',{schema:2,works:[],chats:'broken'});await f.navigate(B);assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'A 草稿');assert.match(f.root.querySelector('[data-status]')?.textContent||'',/损坏|读取|核对/);f.draft('保留');await f.p.send(f.root);assert.equal(f.calls.filter(x=>x.path.endsWith('/chat/stream')).length,0);
 }finally{f.close();}
});
test('standalone association opened from a stale document leaves its destination scene and notice untouched',async()=>{
 const f=await fixture();try{
  f.delay.bind=gate();const binding=f.bind();await until(()=>f.calls.some(x=>x.path==='/chats/bind'));await f.navigate(B);f.draft('B 草稿');f.p.setStatus(f.root,'B 现状');f.delay.bind.release();await binding;assert.equal(f.root.querySelector('[data-status]')?.textContent,'B 现状');assert.equal(f.input.value,'B 草稿');assert.equal((await f.p.workStore.listDocumentChats(A)).length,1);
 }finally{f.close();}
});

test('compact sidebar exposes explicit choices for multiple marked ancestors without moving the editor',async()=>{
 const f=await fixture();try{
  f.paths.set(A,`/${W}/${A}.sy`);f.marks.add(W);f.marks.add(A);await f.navigate(A);assert.equal(f.p.workController.currentWorkId,null);await until(()=>f.root.querySelectorAll('[data-work-action="choose-owner"]').length===2);
  f.root.querySelector<HTMLButtonElement>(`[data-work-action="choose-owner"][data-work-id="${W}"]`)!.click();await until(()=>f.p.workController.currentWorkId===W&&!f.p.workController.isTransitioning);assert.equal(f.p.currentDocumentId(),A);
  await f.p.startNewChat(f.root);assert.equal((await f.p.workStore.chatLink(f.p.activeThreadId)).workId,W);assert.equal((await f.p.workStore.chatLink(f.p.activeThreadId)).documentRootId,A);
 }finally{f.close();}
});
test('entering a marked Work uses its actual opened document for the new local placeholder',async()=>{
 const f=await fixture();try{f.marks.add(W);await f.navigate(W);assert.equal(f.p.workController.currentWorkId,W);assert.equal(f.p.threads.find((x:any)=>x.id===f.p.activeThreadId).documentRootId,W);}finally{f.close();}
});

test('an ownership choice left from another document cannot switch scene after a failed new document read',async()=>{
 const f=await fixture();try{
  f.paths.set(A,`/${W}/${A}.sy`);f.marks.add(W);f.marks.add(A);await f.navigate(A);await until(()=>f.root.querySelectorAll('[data-work-action="choose-owner"]').length===2);
  const button=f.root.querySelector<HTMLButtonElement>(`[data-work-action="choose-owner"][data-work-id="${W}"]`)!;f.setReadError('虚构归属读取失败');await f.navigate(B);f.setReadError('');button.click();await tick();assert.equal(f.p.workController.currentWorkId,null);assert.match(f.root.querySelector('[data-status]')?.textContent||'',/变化|归属|核对/);
 }finally{f.close();}
});

test('late pending-marker save after failed standalone formal persistence cannot publish status into B',async()=>{
 const f=await fixture();const delayed=gate();let recording=false;try{
  const save=f.p.saveData;f.p.saveData=async(key:string,value:any)=>{if(key==='work-formal-v2'&&value.chats.length)throw Error('虚构正式关系保存失败');if(key==='work-pending-v1'){recording=true;await delayed.promise;}return save(key,value);};
  const creating=f.p.startNewChat(f.root);await until(()=>recording);await f.navigate(B);f.draft('B 草稿');f.p.setStatus(f.root,'B 保存后的现状');const selected=f.p.activeThreadId;delayed.release();await creating;
  assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'B 草稿');assert.equal(f.root.querySelector('[data-status]')?.textContent,'B 保存后的现状');const pending=await f.p.workStore.listPending();assert.equal(pending.length,1);assert.match(pending[0].details,new RegExp('documentRootId='+A));
 }finally{delayed.release();f.close();}
});

test('draft typed while the initial standalone ownership read is pending survives scene initialization',async()=>{const f=await fixture(new Map(),'初始核对期间的草稿');try{assert.equal(f.input.value,'初始核对期间的草稿');assert.deepEqual(await f.p.workStore.listDocumentChats(A),[]);}finally{f.close();}});

test('unknown bind delayed formal save cannot overwrite B status',async()=>{
 const f=await fixture();const delayed=gate();let recording=false;try{
  const save=f.p.saveData;f.p.saveData=async(key:string,value:any)=>{if(key==='work-formal-v2'&&value.chats.some((c:any)=>c.state==='unknown')){recording=true;await delayed.promise;}return save(key,value);};
  f.setUnknownBind();const binding=f.bind();await until(()=>recording);await f.navigate(B);f.draft('B 保留草稿');f.p.setStatus(f.root,'B 独立现状');delayed.release();await binding;
  assert.equal(f.root.querySelector('[data-status]')?.textContent,'B 独立现状');assert.equal(f.input.value,'B 保留草稿');
 }finally{delayed.release();f.close();}
});
test('repaired formal read followed by New must not include A threads in B',async()=>{
 const f=await fixture();try{
  await f.p.startNewChat(f.root);const a=f.p.activeThreadId;f.draft('A 保留草稿');const original=structuredClone(f.data.get('work-formal-v2'));
  f.data.set('work-formal-v2',{schema:2,works:[],chats:'broken'});await f.navigate(B);f.data.set('work-formal-v2',original);await f.p.startNewChat(f.root);
  assert.equal((await f.p.workStore.chatLink(f.p.activeThreadId)).documentRootId,B);assert.ok(f.p.threads.every((x:any)=>x.documentRootId===B),'B scene includes A Chat '+a);await f.navigate(A);assert.equal(f.input.value,'A 保留草稿');
 }finally{f.close();}
});

for(const field of ['documentRootId','connectionId','kind','profile','installId','storedSessionId','state'])test('standalone send rejects changed remote '+field,async()=>{
 const f=await fixture();try{await f.p.startNewChat(f.root);const id=f.p.activeThreadId;f.chats.get(id)[field]='synthetic-other';f.draft('必须留存');await f.p.send(f.root);assert.equal(f.calls.filter(x=>x.path.endsWith('/chat/stream')).length,0);assert.equal(f.input.value,'必须留存');}finally{f.close();}
});
test('becoming a Work does not promote existing standalone formal ownership',async()=>{
 const f=await fixture();try{await f.p.startNewChat(f.root);const id=f.p.activeThreadId;f.marks.add(A);await f.navigate(A);assert.equal(f.p.workController.currentWorkId,A);assert.equal((await f.p.workStore.chatLink(id)).workId,null);assert.deepEqual(await f.p.workStore.listChats(A),[]);assert.ok(!f.p.threads.some((x:any)=>x.id===id));}finally{f.close();}
});
test('unknown bind delayed formal save cannot inject old connection thread',async()=>{
 const f=await fixture();const delayed=gate();let recording=false;try{
  const save=f.p.saveData;f.p.saveData=async(key:string,value:any)=>{if(key==='work-formal-v2'&&value.chats.some((c:any)=>c.state==='unknown')){recording=true;await delayed.promise;}return save(key,value);};
  f.setUnknownBind();const binding=f.bind();await until(()=>recording);f.p.bridgeToken='fictional-other-token';await f.p.onWorkChanged(null);f.draft('新连接草稿');f.p.setStatus(f.root,'新连接现状');delayed.release();await binding;
  assert.ok(!f.p.threads.some((x:any)=>x.connectionId),'old Bridge unknown link must not enter new Bridge scene');assert.equal(f.root.querySelector('[data-status]')?.textContent,'新连接现状');
 }finally{delayed.release();f.close();}
});

for(const destination of ['document','connection','scene','view'] as const)for(const failed of [false,true])test(`unknown association formal ${failed?'failed':'successful'} delayed save isolates ${destination} scene and preserves origin evidence`,async()=>{
 const f=await fixture();const delayed=gate();let recording=false;try{
  const save=f.p.saveData;f.p.saveData=async(key:string,value:any)=>{if(key==='work-formal-v2'&&value.chats.some((c:any)=>c.state==='unknown')){recording=true;await delayed.promise;if(failed)throw Error('虚构正式保存失败');}return save(key,value);};
  f.setUnknownBind();const binding=f.bind();await until(()=>recording);
  if(destination==='document')await f.navigate(B);
  else if(destination==='connection'){f.p.bridgeToken='fictional-other-token';await f.p.onWorkChanged(null);}
  else if(destination==='scene')await f.p.onWorkChanged(null);
  else{f.p.render(f.root);await tick();}
  const input=f.root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value='目标草稿';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.p.setStatus(f.root,'目标现状');const selected=f.p.activeThreadId;
  delayed.release();await binding;
  assert.equal(f.p.activeThreadId,selected);assert.equal(input.value,'目标草稿');assert.equal(f.root.querySelector('[data-status]')?.textContent,'目标现状');assert.ok(!f.p.threads.some((x:any)=>x.connectionId),'old connection unknown Chat must not enter destination');
  if(failed){const pending=await f.p.workStore.listPending();assert.equal(pending.length,1);assert.equal(pending[0].workId,null);assert.match(pending[0].details,new RegExp('documentRootId='+A));assert.match(pending[0].details,/storedSessionId=remote-existing/);assert.match(pending[0].details,/connectionId=serve-local/);assert.ok(pending[0].id.startsWith('chat:'));}
  else{const links=await f.p.workStore.listDocumentChats(A);assert.equal(links.length,1);assert.equal(links[0].state,'unknown');assert.equal(links[0].storedSessionId,'remote-existing');assert.equal(links[0].connectionId,'serve-local');assert.equal(links[0].workId,null);assert.deepEqual(await f.p.workStore.listDocumentChats(B),[]);}
 }finally{delayed.release();f.close();}
});

for(const destination of ['document','connection','scene','view'] as const)for(const failed of [false,true])test(`confirmed association formal ${failed?'failed':'successful'} delayed save isolates ${destination} scene`,async()=>{
 const f=await fixture();const delayed=gate();let recording=false;try{
  const save=f.p.saveData;f.p.saveData=async(key:string,value:any)=>{if(key==='work-formal-v2'&&value.chats.some((c:any)=>c.state==='ready')){recording=true;await delayed.promise;if(failed)throw Error('虚构正式保存失败');}return save(key,value);};
  const binding=f.bind();await until(()=>recording);
  if(destination==='document')await f.navigate(B);
  else if(destination==='connection'){f.p.bridgeToken='fictional-other-token';await f.p.onWorkChanged(null);}
  else if(destination==='scene')await f.p.onWorkChanged(null);
  else{f.p.render(f.root);await tick();}
  const input=f.root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value='目标草稿';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.p.setStatus(f.root,'目标现状');const selected=f.p.activeThreadId;
  delayed.release();await binding;
  assert.equal(f.p.activeThreadId,selected);assert.equal(input.value,'目标草稿');assert.equal(f.root.querySelector('[data-status]')?.textContent,'目标现状');assert.ok(!f.p.threads.some((x:any)=>x.connectionId));
  if(failed){const pending=await f.p.workStore.listPending();assert.equal(pending.length,1);assert.match(pending[0].details,new RegExp('documentRootId='+A));assert.match(pending[0].details,/storedSessionId=remote-existing/);assert.match(pending[0].details,/connectionId=serve-local/);}
  else{const links=await f.p.workStore.listDocumentChats(A);assert.equal(links.length,1);assert.equal(links[0].state,'ready');assert.equal(links[0].storedSessionId,'remote-existing');assert.deepEqual(await f.p.workStore.listDocumentChats(B),[]);}
 }finally{delayed.release();f.close();}
});

for(const stage of ['pins','handoff'])for(const destination of ['document','connection','view'])test(`new preflight ${stage} late failure does not overwrite ${destination}`,async()=>{
 const f=await fixture();const delayed=gate();let reading=false;try{
  await f.p.startNewChat(f.root);
  if(stage==='pins'){
   const load=f.p.loadData;f.p.loadData=async(key:string)=>{if(key==='work-formal-v2'&&new Error().stack?.includes('getPins')){reading=true;await delayed.promise;throw Error('synthetic pins read failure');}return load(key);};
  }else{
   f.draft('虚构准备');await f.p.send(f.root);assert.equal((await f.p.workStore.chatLink(f.p.activeThreadId)).state,'ready');
   f.dom.window.confirm=()=>true;f.setQueued();f.delay.stream=delayed;
  }
  const beforeCreates=f.calls.filter(x=>x.path==='/chats').length,beforeStreams=f.calls.filter(x=>x.path.endsWith('/chat/stream')).length;
  const creating=f.p.startNewChat(f.root);await until(()=>stage==='pins'?reading:f.calls.filter(x=>x.path.endsWith('/chat/stream')).length>beforeStreams);
  if(destination==='document')await f.navigate(B);
  else if(destination==='connection'){f.p.bridgeToken='fictional-other-token';await f.p.onWorkChanged(null);}
  else{f.p.render(f.root);await tick();}
  const input=f.root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value='目的场景草稿';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.p.setStatus(f.root,'目的场景现状');const selected=f.p.activeThreadId;
  delayed.release();await creating;
  assert.equal(f.calls.filter(x=>x.path==='/chats').length,beforeCreates);assert.equal(f.p.activeThreadId,selected);assert.equal(input.value,'目的场景草稿');assert.equal(f.root.querySelector('[data-status]')?.textContent,'目的场景现状');
 }finally{delayed.release();f.close();}
});
for(const stage of ['pins','handoff'])test(`new preflight ${stage} late success must not show an old-scene prompt`,async()=>{
 const f=await fixture();const delayed=gate();let reading=false;const prompts:string[]=[];try{
  await f.p.startNewChat(f.root);f.draft('虚构准备');await f.p.send(f.root);
  if(stage==='pins'){
   const load=f.p.loadData;f.p.loadData=async(key:string)=>{if(key==='work-formal-v2'&&new Error().stack?.includes('getPins')){reading=true;await delayed.promise;}return load(key);};
   f.dom.window.confirm=(text:string)=>{prompts.push(text);return false;};
  }else{f.dom.window.confirm=()=>true;f.dom.window.prompt=(text:string)=>{prompts.push(text);return '';};f.delay.stream=delayed;}
  const streams=f.calls.filter(x=>x.path.endsWith('/chat/stream')).length;const creating=f.p.startNewChat(f.root);await until(()=>stage==='pins'?reading:f.calls.filter(x=>x.path.endsWith('/chat/stream')).length>streams);await f.navigate(B);delayed.release();await creating;assert.deepEqual(prompts,[]);
 }finally{delayed.release();f.close();}
});

test('current-scene pins read failure remains visible and preserves its original Chat/draft',async()=>{
 const f=await fixture();try{
  await f.p.startNewChat(f.root);const original=f.p.activeThreadId;f.draft('原场景草稿');const load=f.p.loadData;f.p.loadData=async(key:string)=>{if(key==='work-formal-v2'&&new Error().stack?.includes('getPins'))throw Error('synthetic current pins failure');return load(key);};
  await f.p.startNewChat(f.root);assert.equal(f.p.activeThreadId,original);assert.equal(f.input.value,'原场景草稿');assert.equal(f.calls.filter(x=>x.path==='/chats').length,1);assert.match(f.root.querySelector('[data-status]')?.textContent||'',/固定资料无法读取.*current pins failure/);
 }finally{f.close();}
});
test('current-scene failed handoff remains visible while its requested new Chat is being created',async()=>{
 const f=await fixture();const creatingGate=gate();try{
  await f.p.startNewChat(f.root);f.draft('虚构准备');await f.p.send(f.root);f.dom.window.confirm=()=>true;f.setQueued();f.delay.create=creatingGate;
  const creating=f.p.startNewChat(f.root);await until(()=>f.calls.filter(x=>x.path==='/chats').length===2);assert.match(f.root.querySelector('[data-status]')?.textContent||'',/旧 Chat 暂不可用.*接力信息结果未确认/);creatingGate.release();await creating;
 }finally{creatingGate.release();f.close();}
});

for(const action of ['startNewChat','associateStudio'])test(`late initial scope failure for ${action} cannot overwrite B`,async()=>{
 const f=await fixture();const delayed=gate();try{
  let entered=false;const api=f.p.api.bind(f.p);
  f.p.api=async(path:string,body:any)=>{if(!entered&&path==='/api/query/sql'&&body.stmt?.startsWith('select path')&&body.stmt.includes(A)){entered=true;await delayed.promise;}return api(path,body);};
  const operation=f.p[action](f.root);await until(()=>entered);
  await f.navigate(B);f.draft('B draft retained');const selected=f.p.activeThreadId;f.p.setStatus(f.root,'B destination status');
  delayed.release();await operation;
  assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'B draft retained');assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path==='/chats/bind').length,0);
  assert.equal(f.root.querySelector('[data-status]')?.textContent,'B destination status');
 }finally{delayed.release();f.close();}
});
for(const action of ['startNewChat','associateStudio'])test(`late initial scope success for ${action} cannot act on replacement connection`,async()=>{
 const f=await fixture();const delayed=gate();try{
  let entered=false;const api=f.p.api.bind(f.p);
  f.p.api=async(path:string,body:any)=>{if(!entered&&path==='/api/query/sql'&&body.stmt?.startsWith('select path')&&body.stmt.includes(A)){entered=true;await delayed.promise;}return api(path,body);};
  const operation=f.p[action](f.root);await until(()=>entered);
  f.p.bridgeToken='replacement-fictional-token';await f.p.onWorkChanged(null);f.draft('new connection draft');f.p.setStatus(f.root,'new connection status');
  delayed.release();await operation;
  assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path==='/connections/serve-local/sessions').length,0,'old action must not create a Chat or open candidate picker on replacement connection');
  assert.equal(f.input.value,'new connection draft');assert.equal(f.root.querySelector('[data-status]')?.textContent,'new connection status');
 }finally{delayed.release();f.close();}
});

for(const action of ['startNewChat','associateStudio'] as const)for(const failed of [false,true])for(const destination of ['document','connection','view','reload'] as const)test(`initial ownership ${action} ${failed?'failed':'successful'} read isolates ${destination}`,async()=>{
 const f=await fixture();const delayed=gate();let entered=false;try{
  const api=f.p.api.bind(f.p);f.p.api=async(path:string,body:any)=>{if(!entered&&path==='/api/query/sql'&&body.stmt?.startsWith('select path')&&body.stmt.includes(A)){entered=true;await delayed.promise;if(failed)throw Error('synthetic initial ownership failure');}return api(path,body);};
  const operation=f.p[action](f.root);await until(()=>entered);
  if(destination==='document')await f.navigate(B);
  else if(destination==='connection'){f.p.bridgeToken='replacement-fictional-token';await f.p.onWorkChanged(null);}
  else if(destination==='reload')await f.p.onWorkChanged(null);
  else{f.p.render(f.root);await tick();}
  const input=f.root.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value='目标归属读取草稿';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));const selected=f.p.activeThreadId;f.p.setStatus(f.root,'目标归属读取状态');
  delayed.release();await operation;
  assert.equal(f.p.activeThreadId,selected);assert.equal(input.value,'目标归属读取草稿');assert.equal(f.root.querySelector('[data-status]')?.textContent,'目标归属读取状态');assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path==='/chats/bind'||x.path==='/connections/serve-local/sessions').length,0);assert.equal(f.root.querySelector('[data-studio-options]'),null);assert.deepEqual(await f.p.workStore.listDocumentChats(A),[]);
 }finally{delayed.release();f.close();}
});
for(const action of ['startNewChat','associateStudio'] as const)test(`current-scene initial ownership failure for ${action} remains visible`,async()=>{
 const f=await fixture();try{const api=f.p.api.bind(f.p);f.p.api=async(path:string,body:any)=>{if(path==='/api/query/sql'&&body.stmt?.startsWith('select path'))throw Error('synthetic current ownership failure');return api(path,body);};f.draft('原场景归属草稿');const selected=f.p.activeThreadId;await f.p[action](f.root);assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'原场景归属草稿');assert.match(f.root.querySelector('[data-status]')?.textContent||'',/synthetic current ownership failure/);assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path==='/connections/serve-local/sessions').length,0);}finally{f.close();}
});
for(const action of ['new','associate'] as const)test(`ownership preparation may legally discover and initialize its own Work for ${action}`,async()=>{
 const f=await fixture();try{f.marks.add(A);if(action==='new')await f.p.startNewChat(f.root);else await f.bind();assert.equal(f.p.workController.currentWorkId,A);const links=await f.p.workStore.listChats(A);assert.equal(links.length,1);assert.equal(links[0].workId,A);assert.equal(links[0].documentRootId,A);assert.deepEqual(await f.p.workStore.listDocumentChats(A),[]);}finally{f.close();}
});
for(const action of ['new','associate'] as const)test(`ownership preparation may legally enter standalone browsing document from retained Work for ${action}`,async()=>{
 const f=await fixture();try{f.marks.add(W);await f.navigate(W);await f.navigate(B);assert.equal(f.p.workController.currentWorkId,W);if(action==='new')await f.p.startNewChat(f.root);else await f.bind();assert.equal(f.p.workController.currentWorkId,null);const links=await f.p.workStore.listDocumentChats(B);assert.equal(links.length,1);assert.equal(links[0].workId,null);assert.equal(links[0].documentRootId,B);assert.deepEqual(await f.p.workStore.listWorks(),[W]);}finally{f.close();}
});
for(const action of ['startNewChat','associateStudio'] as const)test(`external reload during ${action} own Work initialization is not adopted by that old preparation`,async()=>{
 const f=await fixture();const delayed=gate();let entered=false;try{
  f.marks.add(A);const load=f.p.loadData;f.p.loadData=async(key:string)=>{if(!entered&&key==='work-formal-v2'&&new Error().stack?.includes('onWorkChanged')){entered=true;await delayed.promise;}return load(key);};
  const operation=f.p[action](f.root);await until(()=>entered);assert.equal(f.p.workController.currentWorkId,A);await f.p.onWorkChanged(A);f.draft('外部重载草稿');const selected=f.p.activeThreadId;f.p.setStatus(f.root,'外部重载状态');delayed.release();await operation;
  assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'外部重载草稿');assert.equal(f.root.querySelector('[data-status]')?.textContent,'外部重载状态');assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path==='/connections/serve-local/sessions').length,0);
 }finally{delayed.release();f.close();}
});

for(const action of ['startNewChat','associateStudio'] as const)for(const field of ['target','kind','profile','installId'] as const)test(`initial ownership ${action} cannot adopt changed confirmed connection ${field} on the same Bridge`,async()=>{
 const f=await fixture();const delayed=gate();let entered=false;try{
  const originalUrl=f.p.bridgeUrl,originalToken=f.p.bridgeToken,api=f.p.api.bind(f.p);f.p.api=async(path:string,body:any)=>{if(!entered&&path==='/api/query/sql'&&body.stmt?.startsWith('select path')){entered=true;await delayed.promise;}return api(path,body);};
  const operation=f.p[action](f.root);await until(()=>entered);
  if(field==='target'){f.p.connectionViews.push({...f.p.connectionViews[0],id:'serve-other'});f.p.selectedConnectionId='serve-other';f.p.confirmedConnectionId='serve-other';}
  else f.p.connectionViews=[{...f.p.connectionViews[0],[field]:field==='kind'?'studio':'changed-fictional-identity'}];
  f.draft('同 Bridge 新目标草稿');f.p.setStatus(f.root,'同 Bridge 新目标状态');const selected=f.p.activeThreadId;delayed.release();await operation;
  assert.equal(f.p.bridgeUrl,originalUrl);assert.equal(f.p.bridgeToken,originalToken);assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'同 Bridge 新目标草稿');assert.equal(f.root.querySelector('[data-status]')?.textContent,'同 Bridge 新目标状态');assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path.startsWith('/connections/')&&x.path.endsWith('/sessions')).length,0);assert.equal(f.root.querySelector('[data-studio-options]'),null);
 }finally{delayed.release();f.close();}
});
for(const action of ['startNewChat','associateStudio'] as const)test(`initial ownership ${action} failure cannot overwrite another confirmed target on the same Bridge`,async()=>{
 const f=await fixture();const delayed=gate();let entered=false;try{
  const api=f.p.api.bind(f.p);f.p.api=async(path:string,body:any)=>{if(!entered&&path==='/api/query/sql'&&body.stmt?.startsWith('select path')){entered=true;await delayed.promise;throw Error('synthetic ownership target read failure');}return api(path,body);};
  const operation=f.p[action](f.root);await until(()=>entered);f.p.connectionViews.push({...f.p.connectionViews[0],id:'serve-other'});f.p.selectedConnectionId='serve-other';f.p.confirmedConnectionId='serve-other';f.p.setStatus(f.root,'目的服务状态');delayed.release();await operation;assert.equal(f.root.querySelector('[data-status]')?.textContent,'目的服务状态');assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path.startsWith('/connections/')&&x.path.endsWith('/sessions')).length,0);
 }finally{delayed.release();f.close();}
});
for(const action of ['new','associate'] as const)test(`initially confirmed other target remains valid for ${action} ownership preparation`,async()=>{
 const f=await fixture();try{f.p.connectionViews.push({...f.p.connectionViews[0],id:'serve-other'});f.p.selectedConnectionId='serve-other';f.p.confirmedConnectionId='serve-other';if(action==='new')await f.p.startNewChat(f.root);else await f.bind();const links=await f.p.workStore.listDocumentChats(A);assert.equal(links.length,1);assert.equal(links[0].connectionId,'serve-other');assert.equal(links[0].profile,'default');assert.equal(links[0].installId,'fictional-install');assert.equal(links[0].workId,null);}finally{f.close();}
});

async function associateEkko(f:Awaited<ReturnType<typeof fixture>>,room='room-a'){
 f.root.querySelector<HTMLButtonElement>('[data-action="associate-ekko"]')!.click();await until(()=>!!f.dom.window.document.querySelector(`[data-room-association] [data-ekko-action="link"][data-ekko-id="${room}"]`));
 const overlay=f.dom.window.document.querySelector<HTMLElement>('[data-room-association]')!;overlay.querySelector<HTMLButtonElement>(`[data-ekko-action="link"][data-ekko-id="${room}"]`)!.click();await until(()=>!!overlay.querySelector(`[data-ekko-linked-room="${room}"]`));return overlay;
}
test('actual plus-menu links standalone EKKO without Hermes target and explicit open/select keeps document drafts',async()=>{
 const f=await fixture();try{
  f.p.connectionViews=[];f.p.confirmedConnectionId='';f.p.selectedConnectionId='';f.draft('Hermes 原草稿');const chat=f.p.activeThreadId;const overlay=await associateEkko(f);assert.equal(f.p.activeThreadId,chat);assert.equal(f.input.value,'Hermes 原草稿');assert.equal(f.root.querySelector<HTMLElement>('.sac')!.dataset.surface,'chat');assert.deepEqual(await f.p.workStore.listWorks(),[]);
  overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!!f.root.querySelector('[data-ekko-composer]')&&!overlay.isConnected);assert.equal(f.p.roomViews.get(f.root).activeLink.documentRootId,A);
  const compose=()=>f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;compose().value='房间 A 草稿';compose().dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  await f.navigate(B);const b=await associateEkko(f);b.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!b.isConnected&&f.p.roomViews.get(f.root).activeLink?.documentRootId===B);assert.equal(compose().value,'');compose().value='房间 B 草稿';compose().dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  await f.navigate(A);await until(()=>f.root.querySelectorAll('optgroup[label="协作房间 · EKKO"] option').length===1);const selector=f.root.querySelector<HTMLSelectElement>('[data-thread-selector]')!;selector.value=selector.querySelector<HTMLOptionElement>('optgroup[label="协作房间 · EKKO"] option')!.value;await f.p.selectSession(f.root);assert.equal(compose().value,'房间 A 草稿');assert.equal(f.calls.filter(x=>x.path==='/chats'||x.path==='/chats/bind').length,0);
 }finally{f.p.closeRoomAssociation?.();f.close();}
});
test('room association resolves unrelated retained Work from current document instead of inheriting it',async()=>{
 const f=await fixture();try{f.marks.add(W);await f.navigate(W);await f.navigate(B);assert.equal(f.p.workController.currentWorkId,W);const overlay=await associateEkko(f);const links=await f.p.roomStore.listForDocument(B);assert.equal(links.length,1);assert.equal(links[0].workId,null);assert.deepEqual(await f.p.roomStore.listForWork(W),[]);overlay.querySelector<HTMLButtonElement>('[data-close-room]')!.click();}finally{f.p.closeRoomAssociation?.();f.close();}
});

for(const owner of ['child','external','multiple','error'] as const)test('EKKO menu authoritative ownership '+owner,async()=>{
 const f=await fixture();try{
  if(owner==='error'){f.setReadError('虚构归属失败');await f.p.associateRoom(undefined,()=>true,f.root);assert.equal(f.dom.window.document.querySelector('[data-room-association]'),null);assert.match(f.root.querySelector('[data-status]')?.textContent||'',/读取|归属|失败/);return;}
  f.marks.add(W);if(owner==='child'||owner==='multiple')f.paths.set(A,`/${W}/${A}.sy`);else{await f.p.workStore.registerWork(W);f.p.workService.listExternalDocuments=async(id:string)=>id===W?[A]:[];}
  if(owner==='multiple'){f.marks.add(A);await f.navigate(A);await f.p.associateRoom(undefined,()=>true,f.root);assert.equal(f.dom.window.document.querySelector('[data-room-association]'),null);assert.match(f.root.querySelector('[data-status]')?.textContent||'',/多个|选择/);f.root.querySelector<HTMLButtonElement>(`[data-work-action="choose-owner"][data-work-id="${W}"]`)!.click();await until(()=>f.p.workController.currentWorkId===W&&!f.p.workController.isTransitioning);}else await f.navigate(A);
  const overlay=await associateEkko(f);assert.equal((await f.p.roomStore.listForWork(W)).length,1);assert.deepEqual(await f.p.roomStore.listForDocument(A),[]);assert.equal(f.p.currentDocumentId(),A);overlay.querySelector<HTMLButtonElement>('[data-close-room]')!.click();
 }finally{f.p.closeRoomAssociation?.();f.close();}
});
for(const destination of ['document','bridge','navigation','view','settings'] as const)test('late ordinary room association persistence cannot publish into '+destination,async()=>{
 const f=await fixture();const delayed=gate();let saving=false;try{
  const save=f.p.saveData;f.p.saveData=async(key:string,value:any)=>{if(key==='work-rooms-v1'){saving=true;await delayed.promise;}return save(key,value);};
  f.root.querySelector<HTMLButtonElement>('[data-action="associate-ekko"]')!.click();await until(()=>!!f.dom.window.document.querySelector('[data-room-association] [data-ekko-action="link"]'));const overlay=f.dom.window.document.querySelector<HTMLElement>('[data-room-association]')!;overlay.querySelector<HTMLButtonElement>('[data-ekko-action="link"]')!.click();await until(()=>saving);
  if(destination==='document')await f.navigate(B);else if(destination==='bridge')f.p.bridgeToken='fictional-replacement';else if(destination==='navigation')await f.p.workController.refreshDocument(A);else if(destination==='view'){f.p.render(f.root);await until(()=>!f.p.workController.isTransitioning);}else f.p.settingsSaving=true;
  f.p.setStatus(f.root,'新场景现状');delayed.release();await until(()=>f.data.has('work-rooms-v1'));await tick();assert.equal(f.root.querySelector('[data-status]')?.textContent,'新场景现状');assert.equal(f.root.querySelector<HTMLElement>('.sac')!.dataset.surface,'chat');assert.equal(overlay.querySelector('[data-ekko-linked-room]'),null);assert.equal((await f.p.roomStore.listForDocument(A)).length,1);assert.equal(f.calls.filter(x=>x.path.endsWith('/messages')&&x.doc).length,0);
 }finally{f.p.settingsSaving=false;delayed.release();f.p.closeRoomAssociation?.();f.close();}
});
test('completed settings replacement attempt invalidates a delayed room association even with same Bridge',async()=>{
 const f=await fixture();const delayed=gate();let saving=false;try{
  const save=f.p.saveData;f.p.saveData=async(key:string,value:any)=>{if(key==='work-rooms-v1'){saving=true;await delayed.promise;}return save(key,value);};
  f.root.querySelector<HTMLButtonElement>('[data-action="associate-ekko"]')!.click();await until(()=>!!f.dom.window.document.querySelector('[data-room-association] [data-ekko-action="link"]'));const overlay=f.dom.window.document.querySelector<HTMLElement>('[data-room-association]')!;overlay.querySelector<HTMLButtonElement>('[data-ekko-action="link"]')!.click();await until(()=>saving);
  await f.p.connectSettingsBridge({url:f.p.bridgeUrl,token:'',detect:false}).catch(()=>undefined);assert.equal(f.p.settingsSaving,false);delayed.release();await until(()=>f.data.has('work-rooms-v1'));await tick();assert.equal(overlay.querySelector('[data-ekko-linked-room]'),null);
 }finally{delayed.release();f.p.closeRoomAssociation?.();f.close();}
});
test('associating a second room preserves the active room and lets its draft send after proven same-scope ownership read',async()=>{
 const f=await fixture();try{const first=await associateEkko(f);first.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!first.isConnected&&!!f.root.querySelector('[data-ekko-composer]'));const compose=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;compose.value='原房间草稿';compose.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await until(()=>f.roomStreams.get('room-a')?.length===1);const second=await associateEkko(f,'room-b');second.querySelector<HTMLButtonElement>('[data-close-room]')!.click();assert.equal(f.p.roomViews.get(f.root).activeLink.roomId,'room-a');assert.equal(compose.value,'原房间草稿');await until(()=>f.roomStreams.get('room-a')?.length===2);f.emitRoom('room-a','原房间订阅继续');await until(()=>!!f.root.querySelector('[data-ekko-messages]')?.textContent?.includes('原房间订阅继续'));assert.equal(f.roomStreams.get('room-b'),undefined);await f.p.roomViews.get(f.root).sendCurrent();assert.equal(f.calls.filter(x=>x.path==='/ekko/rooms/room-a/messages').length,1);assert.equal(f.calls.filter(x=>x.path==='/ekko/rooms/room-b/messages').length,0);}finally{f.p.closeRoomAssociation?.();f.close();}
});
test('ordinary document room send preparation has zero real POST after navigation and retains origin draft',async()=>{
 const f=await fixture();const delayed=gate();let reading=false;try{
  const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!overlay.isConnected&&!!f.root.querySelector('[data-ekko-composer]'));
  const view=f.p.roomViews.get(f.root),compose=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;compose.value='冻结前草稿';f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!.checked=true;
  const api=f.p.api;f.p.api=async(path:string,body:any)=>{if(path==='/api/export/exportMdContent'){reading=true;await delayed.promise;}return api(path,body);};const send=view.sendCurrent();await until(()=>reading);await f.navigate(B);delayed.release();await send;
  assert.equal(f.calls.filter(x=>x.path.startsWith('/ekko/rooms/')&&x.path.endsWith('/messages')&&x.doc).length,0);assert.deepEqual(f.data.get('ekko-send-pending-v1')?.items||[],[]);await f.navigate(A);await view.enter();await view.openRoom('room-a');assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value,'冻结前草稿');
 }finally{delayed.release();f.p.closeRoomAssociation?.();f.close();}
});
test('later Work mark never migrates an existing standalone room record',async()=>{const f=await fixture();try{const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-close-room]')!.click();const before=structuredClone(f.data.get('work-rooms-v1'));f.marks.add(A);await f.navigate(A);assert.equal(f.p.workController.currentWorkId,A);assert.deepEqual(f.data.get('work-rooms-v1'),before);assert.deepEqual(await f.p.roomStore.listForWork(A),[]);assert.equal((await f.p.roomStore.listForDocument(A))[0].workId,null);}finally{f.p.closeRoomAssociation?.();f.close();}});
for(const entry of ['ekko','hermes'] as const)for(const failed of [false,true])test(`same-scene ${entry} ${failed?'failed':'successful'} association preparation retains original room subscription and draft`,async()=>{
 const f=await fixture();try{
  const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!overlay.isConnected&&!!f.root.querySelector('[data-ekko-composer]'));await until(()=>f.roomStreams.get('room-a')?.length===1);
  const view=f.p.roomViews.get(f.root),chat=f.p.activeThreadId,link=view.activeLink;const compose=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;compose.value='原场景保留草稿';f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!.checked=true;f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!.checked=true;compose.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  if(failed)f.setReadError('fictional transient ownership read failure');
  if(entry==='hermes'&&!failed)await f.bind();else if(entry==='hermes')await f.p.associateStudio(f.root);else await f.p.associateRoom(undefined,()=>true,f.root);
  f.setReadError('');assert.equal(view.activeLink,link);assert.equal(f.p.activeThreadId,chat);assert.equal(f.root.querySelector<HTMLElement>('.sac')!.dataset.surface,'ekko');assert.equal(compose.value,'原场景保留草稿');assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked').length,1);assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length,1);
  if(failed)assert.match(f.root.querySelector('[data-ekko-status]')?.textContent||'',/fictional transient ownership read failure/,'ownership failure must be visible on current EKKO surface');
  await until(()=>f.roomStreams.get('room-a')?.length===2);f.emitRoom('room-a','原房间准备后继续');await until(()=>!!f.root.querySelector('[data-ekko-messages]')?.textContent?.includes('原房间准备后继续'));assert.equal(f.roomStreams.get('room-b'),undefined);
  await view.sendCurrent();assert.equal(f.calls.filter(x=>x.path==='/ekko/rooms/room-a/messages').length,1);assert.equal(f.calls.find(x=>x.path==='/ekko/rooms/room-a/messages')?.doc,A);
 }finally{f.p.closeAssociation?.();f.p.closeRoomAssociation?.();f.close();}
});
for(const entry of ['ekko','hermes'] as const)test(`late ${entry} ownership failure cannot restore or overwrite a newly opened room`,async()=>{
 const f=await fixture();const delayed=gate();let reading=false;
 type Phase='setup'|'ownership-start'|'ownership-gate-enter'|'enter-start'|'enter-end'|'open-b-start'|'open-b-end'|'b-established'|'oldrelease'|'pending-returned'|'failure';
 const originalView=f.p.roomViews.get(f.root),phases:Record<string,unknown>[]=[];
 let phase:Phase='setup',gateCount=0,gateCallerPhase:Phase|null=null,bLink:any,bVersion:number|undefined;
 const snapshot=(stage:Phase)=>{
  phase=stage;const current=f.p.roomViews.get(f.root),room=current?.activeLink?.roomId;
  const count=(path:string)=>f.calls.filter(call=>call.path===path||call.path.startsWith(path+'?')).length;
  const value={stage,active:room==='room-a'?'A':room==='room-b'?'B':room?'other':null,sameView:current===originalView,bCaptured:!!bLink,sameLink:!!bLink&&current?.activeLink===bLink,version:current?.version??null,sameVersion:bVersion!==undefined&&current?.version===bVersion,sceneCurrent:!!current&&current.sceneIdentity===current.options.getSceneIdentity(),refreshing:!!current&&current.refreshing?.version===current.version,refreshFailed:!!current?.refreshing?.failed,gateCount,gateCallerPhase,connection:count('/ekko/connection'),roomList:count('/ekko/rooms'),aRead:count('/ekko/rooms/room-a'),bRead:count('/ekko/rooms/room-b'),aEvents:count('/ekko/rooms/room-a/events'),bEvents:count('/ekko/rooms/room-b/events')};
  if(phases.length<15)phases.push(value);else if(stage==='failure')phases.push(value);
 };
 try{
  const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!overlay.isConnected&&!!f.root.querySelector('[data-ekko-composer]'));const second=await associateEkko(f,'room-b');second.querySelector<HTMLButtonElement>('[data-close-room]')!.click();
  const view=f.p.roomViews.get(f.root),api=f.p.api;f.p.api=async(path:string,body:any)=>{if(path==='/api/query/sql'&&body.stmt.startsWith('select path')){reading=true;gateCount++;gateCallerPhase=phase;snapshot('ownership-gate-enter');await delayed.promise;throw Error('旧归属读取失败');}return api(path,body);};
  snapshot('ownership-start');
  const pending=entry==='ekko'?f.p.associateRoom(undefined,()=>true,f.root):f.p.associateStudio(f.root);await until(()=>reading);
  assert.equal(gateCount,1,'the deliberate ownership read must enter exactly once');assert.equal(gateCallerPhase,'ownership-start','the gate must belong to the deliberate association before room recovery');
  snapshot('enter-start');await view.enter();snapshot('enter-end');snapshot('open-b-start');await view.openRoom('room-b');snapshot('open-b-end');
  assert.equal(view.activeLink?.roomId,'room-b','setup must activate B before releasing the old ownership read');
  view.showScopePreparationError('新房间独立状态');const compose=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;compose.value='新房间草稿';
  assert.ok(f.p.roomViews.get(f.root)===view&&view===originalView,'B must belong to the original live view');assert.equal(compose.isConnected,true);assert.ok(f.root.querySelector('[data-ekko-composer]')===compose,'B must own the current composer');
  assert.equal(f.root.querySelector('[data-ekko-status]')?.textContent,'新房间独立状态','B must own its independent status before oldrelease');assert.equal(compose.value,'新房间草稿');assert.equal(gateCount,1,'room recovery must not be mistaken for another ownership read');
  bLink=view.activeLink;bVersion=view.version;snapshot('b-established');snapshot('oldrelease');delayed.release();await pending;snapshot('pending-returned');assert.equal(view.activeLink?.roomId,'room-b');assert.equal(f.root.querySelector('[data-ekko-status]')?.textContent,'新房间独立状态');assert.equal(compose.value,'新房间草稿');assert.equal(f.dom.window.document.querySelector('[data-room-association]'),null);
  assert.ok(f.p.roomViews.get(f.root)===view,'late ownership must retain the B view');assert.ok(view.activeLink===bLink,'late ownership must retain the exact B link');assert.equal(view.version,bVersion);assert.ok(f.root.querySelector('[data-ekko-composer]')===compose,'late ownership must retain the B composer');
 }catch(error){snapshot('failure');console.error('late-ownership-phases',JSON.stringify(phases));throw error;
 }finally{delayed.release();f.p.closeAssociation?.();f.p.closeRoomAssociation?.();f.close();}
});
for(const entry of ['ekko','hermes'] as const)for(const failed of [false,true])test(`two visible room views retain their own room after ${entry} ${failed?'failed':'successful'} preparation`,async()=>{
 const f=await fixture();try{
  const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!overlay.isConnected&&!!f.root.querySelector('[data-ekko-composer]'));await until(()=>f.roomStreams.get('room-a')?.length===1);const second=await associateEkko(f,'room-b');second.querySelector<HTMLButtonElement>('[data-close-room]')!.click();await until(()=>f.roomStreams.get('room-a')?.length===2);
  f.p.toggleFloatingPanel();const floating=f.dom.window.document.querySelector<HTMLElement>('#siyuan-ai-collab-panel')!,other=f.p.roomViews.get(floating);await until(()=>!f.p.workController.isTransitioning);await other.enter();await other.openRoom('room-b');await until(()=>f.roomStreams.get('room-b')?.length===1);const dock=f.p.roomViews.get(f.root),firstLink=dock.activeLink,secondLink=other.activeLink;
  const first=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!,last=floating.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;first.value='原 dock 房间草稿';last.value='原浮动房间草稿';
  if(failed)f.setReadError('虚构双视图归属失败');if(entry==='hermes'&&!failed)await f.bind();else if(entry==='hermes')await f.p.associateStudio(f.root);else await f.p.associateRoom(undefined,()=>true,f.root);f.setReadError('');f.p.closeRoomAssociation?.();
  assert.equal(dock.activeLink,firstLink);assert.equal(other.activeLink,secondLink);assert.equal(first.value,'原 dock 房间草稿');assert.equal(last.value,'原浮动房间草稿');await until(()=>f.roomStreams.get('room-a')?.length===3&&f.roomStreams.get('room-b')?.length===2);
  f.emitRoom('room-a','dock 恢复事件');f.emitRoom('room-b','浮动恢复事件');await until(()=>!!f.root.querySelector('[data-ekko-messages]')?.textContent?.includes('dock 恢复事件')&&!!floating.querySelector('[data-ekko-messages]')?.textContent?.includes('浮动恢复事件'));
  await dock.sendCurrent();await other.sendCurrent();assert.equal(f.calls.filter(x=>x.path==='/ekko/rooms/room-a/messages').length,1);assert.equal(f.calls.filter(x=>x.path==='/ekko/rooms/room-b/messages').length,1);
 }finally{f.p.closeAssociation?.();f.p.closeRoomAssociation?.();f.close();}
});
for(const entry of ['ekko','hermes'] as const)for(const failed of [false,true])test(`inactive document room manager survives its own ${entry} ${failed?'failed':'successful'} scope preparation`,async()=>{
 const f=await fixture();try{
  const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!overlay.isConnected&&!!f.root.querySelector('[data-ekko-composer]'));await f.navigate(B);const view=f.p.roomViews.get(f.root);assert.equal(view.activeLink,null);assert.equal(f.root.querySelector<HTMLElement>('.sac')!.dataset.surface,'ekko');
  const before=f.calls.filter(x=>x.path.startsWith('/ekko/rooms/')).length,formal=structuredClone(f.data.get('work-rooms-v1'));
  if(failed)f.setReadError('fictional document B ownership read failed');
  if(entry==='hermes'&&!failed)await f.bind();else if(entry==='hermes')await f.p.associateStudio(f.root);else await f.p.associateRoom(undefined,()=>true,f.root);
  f.setReadError('');f.p.closeRoomAssociation?.();assert.equal(view.activeLink,null);assert.equal(f.calls.filter(x=>x.path.startsWith('/ekko/rooms/')).length,before,'preparation cannot open or subscribe to a room');assert.deepEqual(f.data.get('work-rooms-v1'),formal);
  if(failed)assert.match(f.root.querySelector('[data-ekko-status]')?.textContent||'',/fictional document B ownership read failed/,'visible inactive manager must explain the failure');
  await view.linkRoom('room-a');assert.equal((await f.p.roomStore.listForDocument(B)).length,1,'retained manager remains usable without manual refresh');assert.equal(view.activeLink,null);assert.equal(f.calls.filter(x=>x.path.startsWith('/ekko/rooms/')).length,before);
 }finally{f.p.closeAssociation?.();f.p.closeRoomAssociation?.();f.close();}
});
for(const entry of ['ekko','hermes'] as const)for(const destination of ['document','bridge','settings','view','navigation'] as const)test(`inactive ${entry} late scope failure does not affect changed ${destination} manager`,async()=>{
 const f=await fixture();const delayed=gate();let reading=false;try{
  const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();await until(()=>!overlay.isConnected&&!!f.root.querySelector('[data-ekko-composer]'));await f.navigate(B);const api=f.p.api,formal=structuredClone(f.data.get('work-rooms-v1'));
  f.p.api=async(path:string,body:any)=>{if(!reading&&path==='/api/query/sql'&&body.stmt.startsWith('select path')){reading=true;await delayed.promise;throw Error('迟到的旧管理页归属失败');}return api(path,body);};
  const preparing=entry==='ekko'?f.p.associateRoom(undefined,()=>true,f.root):f.p.associateStudio(f.root);await until(()=>reading);
  if(destination==='document')await f.navigate(A);else if(destination==='bridge')f.p.bridgeToken='fictional-other-token';else if(destination==='settings')await f.p.connectSettingsBridge({url:f.p.bridgeUrl,token:'',detect:false}).catch(()=>undefined);else if(destination==='view'){f.p.render(f.root);await until(()=>!f.p.workController.isTransitioning);}else await f.p.workController.refreshDocument(B);
  const current=f.p.roomViews.get(f.root);await current.enter();current.showScopePreparationError('新管理页独立状态');const events=f.calls.filter(x=>x.path.endsWith('/events')).length;delayed.release();await preparing;
  assert.equal(current.activeLink,null);assert.equal(f.root.querySelector('[data-ekko-status]')?.textContent,'新管理页独立状态');assert.equal(f.calls.filter(x=>x.path.endsWith('/events')).length,events);assert.deepEqual(f.data.get('work-rooms-v1'),formal);assert.equal(f.dom.window.document.querySelector('[data-room-association], [data-studio-options]'),null);
 }finally{delayed.release();f.p.closeAssociation?.();f.p.closeRoomAssociation?.();f.close();}
});

test('quoted room same-document reentry keeps explicit robot selection usable', async()=>{
 const f=await fixture();try{
  const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();
  await until(()=>!!f.root.querySelector('[data-ekko-composer]')&&!overlay.isConnected);
  const view=f.p.roomViews.get(f.root);await until(()=>!!f.roomStreams.get('room-a')?.length);
  f.roomStreams.get('room-a')!.at(-1)!.write('event: room.message\ndata: '+JSON.stringify({id:'fictional-quote',roomId:'room-a',senderId:'fictional-agent',senderName:'虚构助手',role:'assistant',content:'仅供复现引用回复的虚构内容。',timestamp:'2026-10-27T00:00:00Z'})+'\n\n');
  await until(()=>!!f.root.querySelector('[data-message-id="fictional-quote"]'));
  f.root.querySelector<HTMLButtonElement>('[data-message-id="fictional-quote"] [data-ekko-action="reply"]')!.click();
  const input=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;input.value='虚构回复草稿';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));
  const nav=f.p.workController.navigationVersion;const active=view.activeLink;f.enableNavigation();
  await f.p.workController.openDocumentFromPage(A,null,()=>true);
  await view.documentChanged();
  assert.equal(f.p.currentDocumentId(),A);assert.ok(f.p.workController.navigationVersion>nav);assert.deepEqual(view.activeLink,active);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="mention-agents"]')!.click();
  assert.equal(f.root.querySelectorAll('[data-ekko-mention-list] [role="option"]').length,1,'explicit robot list must remain usable after legitimate same-document navigation');
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value,'虚构回复草稿');
  assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));assert.equal(f.calls.filter(x=>x.path.endsWith('/messages')&&x.doc).length,0);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-mention-list] [role="option"]')!.click();
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="cancel-reply"]')!.click();assert.equal(f.root.querySelector('[data-ekko-reply-preview]'),null);
  f.root.querySelector<HTMLButtonElement>('[data-message-id="fictional-quote"] [data-ekko-action="reply"]')!.click();
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="open-sources"]')!.click();assert.equal(f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!.open,true);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-send-form] button[type="submit"]')!.click();
  await until(()=>f.calls.filter(x=>x.path==='/ekko/rooms/room-a/messages').length===1);await until(()=>!!view.unknownMessageId());
  const sent=f.calls.find(x=>x.path==='/ekko/rooms/room-a/messages')!;
  assert.equal(sent.doc,A);assert.deepEqual(sent.body.mentions,[{type:'agent',participantId:'fictional-agent',displayName:'虚构助手'}]);
  assert.equal(sent.body.content,'@虚构助手 虚构回复草稿\n\n<quoted_message>\n【引用：虚构助手】\n仅供复现引用回复的虚构内容。\n</quoted_message>');
  await view.sendCurrent();assert.equal(f.calls.filter(x=>x.path==='/ekko/rooms/room-a/messages').length,1);
 }finally{f.p.closeRoomAssociation?.();f.close();}
});


test('same-document navigation never silently adopts a replaced Bridge with identical room identities', async()=>{
 const f=await fixture();try{
  const overlay=await associateEkko(f);overlay.querySelector<HTMLButtonElement>('[data-ekko-action="open"]')!.click();
  await until(()=>!!f.root.querySelector('[data-ekko-composer]')&&!overlay.isConnected);
  const view=f.p.roomViews.get(f.root),input=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  input.value='原连接草稿';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  const reads=f.calls.filter(x=>x.path==='/ekko/connection').length;
  f.p.bridgeToken='fictional-replacement';f.enableNavigation();await f.p.workController.openDocumentFromPage(A,null,()=>true);await view.documentChanged();
  assert.equal(f.calls.filter(x=>x.path==='/ekko/connection').length,reads,'new Bridge must require an explicit readonly action');
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="mention-agents"]')!.click();assert.equal(f.root.querySelectorAll('[data-ekko-mention-list] [role="option"]').length,0);
  assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent||'',/页面.*变化/);
  assert.equal(f.root.querySelector('[data-ekko-composer]'),input);assert.equal(input.value,'原连接草稿');assert.equal(f.calls.filter(x=>x.path.endsWith('/messages')&&x.doc).length,0);
 }finally{f.p.closeRoomAssociation?.();f.close();}
});
