import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatShell, renderChatConnection, renderConnectionChoices } from '../src/ui.ts';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { EkkoRoomUI } from '../src/ekko/ui.ts';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
// @ts-expect-error -- Bridge runtime ESM module has no declaration.
import { createBridgeServer } from '../scripts/bridge.mjs';

test('connections reports only authenticated companion metadata and preserves service results', async t => {
  const directory=await mkdtemp(join(tmpdir(),'bridge-metadata-'));
  const capability='f'.repeat(64), calls:string[]=[];
  const {server}=createBridgeServer({capability,bindingsFile:join(directory,'bindings.json'),studioToken:'fictional-studio',
    connections:{defaultConnectionId:'studio-default',connections:[{id:'studio-default',kind:'studio',profile:'default'}]},
    fetchImpl:async(url:string)=>{calls.push(String(url));return Response.json({sessions:[],hasMore:false,token:'fictional-upstream-secret'});},
    ekko:{authStore:{read:async()=>assert.fail('Connections must not read EKKO authorization')}}});
  t.after(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const request=(path:string,headers:Record<string,string>={})=>new Promise<any>((resolve,reject)=>{
    const req=httpRequest({host:'127.0.0.1',port:server.address().port,path,headers,agent:false},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(body)}));
    });req.on('error',reject);req.end();
  });
  assert.deepEqual((await request('/health')).body,{ok:true,service:'siyuan-ai-collab-bridge'});
  const unauthorized=await request('/connections');
  assert.equal(unauthorized.status,401);assert.equal(unauthorized.body.meta,undefined);
  const forbidden=await request('/connections',{Origin:'https://untrusted.example','X-Siyuan-Collab-Token':capability});
  assert.equal(forbidden.status,403);assert.equal(forbidden.body.meta,undefined);assert.equal(calls.length,0);
  const reply=await request('/connections',{'X-Siyuan-Collab-Token':capability});
  assert.equal(reply.status,200);
  assert.deepEqual(reply.body.data,[{id:'studio-default',kind:'studio',displayName:'Hermes Studio',state:'ready',profile:'default',installId:null}]);
  assert.equal(calls.length,2);
  assert.deepEqual(reply.body.meta,{schemaVersion:1,bridgeVersion:null,capabilities:['hermes-connection-inspection-v1','ekko-authorization-record-v1']});
  assert.deepEqual(await readdir(directory),[]);
});

const ROOT='20260923123456-abcdefg';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function attachHermesRoomView(plugin:any,root:HTMLElement):void {
  const shell=root.querySelector<HTMLElement>('.sac')!;
  const room=new EkkoRoomUI(shell,{
    client:()=>assert.fail('Hermes-only fixture must not request EKKO'),
    store:plugin.roomStore,pendingStore:plugin.pendingRoomSendStore,
    getWorkId:()=>plugin.workController.currentWorkId,getDocumentRootId:()=>plugin.currentDocumentId(),
    availableSources:async()=>assert.fail('Hermes-only fixture must not read room sources'),
    loadSource:async()=>assert.fail('Hermes-only fixture must not load room sources'),
  });
  // The real component's preparation hook does nothing on the Hermes surface.
  assert.equal(shell.dataset.surface,'chat');assert.equal(room.activeLink,null);
  plugin.roomViews.set(root,room);
}
function pluginHarness(){
  const dom=new JSDOM('<!doctype html><html><body><div id="dock"></div></body></html>');
  Object.assign(globalThis,{document:dom.window.document,window:dom.window,MutationObserver:dom.window.MutationObserver});
  const originalLoad=(Module as any)._load;
  (Module as any)._load=function(request:string,parent:any,isMain:boolean){if(request==='siyuan')return {Plugin:class {},getAllEditor:()=>[]};return originalLoad.call(this,request,parent,isMain);};
  let PluginClass:any;
  try{PluginClass=createRequire(import.meta.url)('../dist/index.js').default;}finally{(Module as any)._load=originalLoad;}
  const plugin:any=new PluginClass();
  plugin.bridgeUrl='http://127.0.0.1:8782';plugin.bridgeToken='test-capability';plugin.confirmedConnectionId='serve-local';plugin.currentDocumentId=()=>ROOT;
  plugin.workController={currentWorkId:'work-1',activeDocumentId:ROOT,navigationVersion:0,isTransitioning:false,
    // This legacy harness has one already-proven Work scene. Actual document/ancestor
    // resolution is exercised with the real controller in document-chat-plugin.test.ts.
    async prepareChatScope(documentId:string){
      const workId=this.currentWorkId,sequence=++this.navigationVersion;
      if(documentId!==ROOT||documentId!==plugin.currentDocumentId()||!workId)throw Error('文档或 Work 归属已变化');
      if(this.isTransitioning||plugin.chatBusy()||plugin.pendingProposal)throw Error('当前操作期间不能切换场景');
      await Promise.resolve();
      const work=await plugin.workService.readWork(workId);
      if(!work||work.id!==workId)throw Error('原 Work 归属不可核对');
      if(sequence!==this.navigationVersion||workId!==this.currentWorkId||documentId!==plugin.currentDocumentId())throw Error('导航已变化');
      return workId;
    },noteChat:()=>undefined,restoreContext:()=>{},detachRoot:()=>{}};
  const formalReads={listChats:async()=>[],listPending:async()=>[]};
  let store=plugin.workStore;
  Object.defineProperty(plugin,'workStore',{get:()=>store,set:(ports:any)=>{store={...formalReads,...ports};}});
  const root=dom.window.document.getElementById('dock')!;root.innerHTML=createChatShell();
  plugin.roomStore.listForWork=async()=>[];plugin.workService.readWork=async()=>({id:'work-1'});attachHermesRoomView(plugin,root);return {plugin,root,dom};
}

test('new Chat chooses Serve locally and exposes no connection secret', () => {
  assert.doesNotMatch(createChatShell(), /data-connection-choice/);assert.match(createChatShell(),/data-action="toggle-settings"/);
  const html=renderConnectionChoices([
    {id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'offline',profile:'default',installId:'private-install'},
    {id:'studio-default',kind:'studio',displayName:'Studio http://127.0.0.1:9119 token=private',state:'configured',profile:'default',installId:null},
  ],'serve-local');
  assert.match(html, /value="serve-local"[^>]*selected/);
  assert.doesNotMatch(html, /private|token|9119|127\.0\.0\.1/);
  assert.match(renderChatConnection({kind:'studio',state:'offline'}), /Studio.*未连接/);
  assert.doesNotMatch(renderChatConnection({kind:'serve',state:'ready'}), /token|9119/);
});

test('new Chat creates local ID, writes Bridge pending, and persists fixed v2 relation', async()=>{
  const {plugin,root}=pluginHarness();
  const calls:any[]=[];const saved:any[]=[];
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url:any,init:any)=>{calls.push({url:String(url),body:JSON.parse(init.body)});const body=JSON.parse(init.body);return Response.json({chat:{chatId:body.chat_id,connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(calls.length,1);assert.match(calls[0].url,/\/chats$/);
  assert.match(calls[0].body.chat_id,/^[0-9a-f-]{36}$/);
  assert.equal(saved[0].chatId,calls[0].body.chat_id);assert.equal(saved[0].connectionId,'serve-local');assert.equal(saved[0].adapter,'serve');assert.equal(saved[0].state,'pending');assert.equal(saved[0].installId,'install-1');
});

test('conversation menu opens beside its button and new choice creates one Chat', async()=>{
  const {plugin,root}=pluginHarness();let creates=0;
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>[],linkChat:async()=>undefined};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url:any,init:any)=>{creates++;const body=JSON.parse(init.body);return Response.json({chat:{chatId:body.chat_id,connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{
    plugin.bind(root);
    const trigger=root.querySelector<HTMLButtonElement>('[data-action="chat-actions-menu"]')!;
    trigger.click();
    assert.equal(trigger.getAttribute('aria-expanded'),'true');
    assert.equal(root.querySelector<HTMLElement>('[data-chat-menu]')!.hidden,false);
    root.querySelector<HTMLButtonElement>('[data-action="chat-menu-new"]')!.click();
    await tick();await tick();
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(creates,1);
  assert.equal(root.querySelector<HTMLElement>('[data-chat-menu]')!.hidden,true);
  assert.equal(root.querySelector('[data-action="chat-actions-menu"]')?.getAttribute('aria-expanded'),'false');
});

test('two concurrent new-chat clicks send exactly one create request', async()=>{
  const {plugin,root}=pluginHarness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const calls:any[]=[];const saved:any[]=[];
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(_url:any,init:any)=>{const body=JSON.parse(init.body);calls.push(body);await gate;return Response.json({chat:{chatId:body.chat_id,connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{const first=plugin.startNewChat(root as HTMLElement),second=plugin.startNewChat(root as HTMLElement);await tick();assert.equal(calls.length,1);assert.equal(root.querySelector<HTMLButtonElement>('[data-action="chat-menu-new"]')!.disabled,true);release();await Promise.all([first,second]);}finally{globalThis.fetch=originalFetch;}
  assert.equal(calls.length,1);assert.equal(saved.length,1);
});

test('legacy API is available for binding but cannot create a Chat', async()=>{
  const {plugin,root}=pluginHarness();let calls=0;plugin.selectedConnectionId='legacy-api';plugin.confirmedConnectionId='legacy-api';plugin.connectionViews=[{id:'legacy-api',kind:'legacy-api',displayName:'旧 API',state:'configured',profile:'default',installId:null}];
  plugin.renderConnectionChoices(root);assert.equal(root.querySelector<HTMLButtonElement>('[data-action="chat-menu-new"]')!.disabled,true);
  assert.match(renderConnectionChoices(plugin.connectionViews,plugin.selectedConnectionId),/value="legacy-api" selected/);
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw new Error('must not create');};
  try{await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(calls,0);assert.match(root.querySelector('[data-status]')!.textContent||'',/旧 API.*只能关联/);
});

test('successful create acknowledgement with local save failure preserves ID as pending evidence', async()=>{
  const {plugin,root}=pluginHarness();const pending:any[]=[];let sentId='';
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>[],linkChat:async()=>{throw new Error('formal store damaged');},setPending:async(value:any)=>pending.push(value)};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(_url:any,init:any)=>{sentId=JSON.parse(init.body).chat_id;return Response.json({chat:{chatId:sentId,connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(pending.length,1);assert.match(pending[0].details,new RegExp(sentId));assert.equal(plugin.activeThreadId,sentId);assert.match(root.querySelector('[data-status]')!.textContent||'',new RegExp(sentId));
});

test('failed formal and pending stores still show the exact acknowledged Chat ID', async()=>{
  const {plugin,root}=pluginHarness();let sentId='';
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>[],linkChat:async()=>{throw new Error('formal damaged');},setPending:async()=>{throw new Error('pending damaged');}};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(_url:any,init:any)=>{sentId=JSON.parse(init.body).chat_id;return Response.json({chat:{chatId:sentId,connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(plugin.activeThreadId,sentId);assert.match(root.querySelector('[data-status]')!.textContent||'',new RegExp(sentId));assert.match(root.querySelector('[data-status]')!.textContent||'',/未决事项也未保存/);
});

test('offline Serve keeps choice and local source-unknown Chat visible', async()=>{
  const {plugin,root}=pluginHarness();
  const link={chatId:'siyuan:'+ROOT+':old',workId:'work-1',documentRootId:ROOT,connectionId:'http://127.0.0.1:8784',adapter:'unresolved',profile:'default',storedSessionId:null,legacyCandidateId:'old',legacyBridgeUrl:'http://127.0.0.1:8784',installId:null,title:'旧 Chat',state:'source-unknown'};
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'offline',profile:'default',installId:null},{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[link],getResume:async()=>null,listPending:async()=>[],resolveLegacyChat:async()=>assert.fail('cannot classify offline')};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('offline');};
  try{await plugin.onWorkChanged('work-1');await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(plugin.selectedConnectionId,'serve-local');assert.equal(plugin.threads[0].id,link.chatId);assert.equal(plugin.threads[0].adapter,'unresolved');
  assert.match(root.querySelector('[data-thread-selector]')!.textContent||'',/旧 Chat.*待确认来源/);
  assert.match(root.querySelector('[data-status]')!.textContent||'',/Hermes 服务未连接/);
});

test('explicit candidate confirmation binds with a new local Chat ID', async()=>{
  const {plugin,root}=pluginHarness();const saved:any[]=[];const calls:string[]=[];
  plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[],listPending:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url:any,init:any)=>{const path=String(url);calls.push(path);if(path.endsWith('/sessions'))return Response.json({data:[{id:'external-1',title:'已有对话'}]});if(path.endsWith('/chats/bind')){const body=JSON.parse(init.body);assert.equal(body.confirm,true);assert.equal(body.stored_session_id,'external-1');return Response.json({chat:{chatId:body.chat_id,connectionId:'studio-default',kind:'studio',profile:'default',documentRootId:ROOT,title:'已有对话',state:'ready',storedSessionId:'external-1',installId:null}});}if(path.includes('/messages'))return Response.json({data:[]});throw new Error('unexpected route');};
  try{
   await plugin.associateStudio(root as HTMLElement);
   assert.equal(calls.length,1,'must wait for explicit confirmation');
   const radio=root.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));
   root.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.click();await tick();await tick();
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(saved.length,1);assert.notEqual(saved[0].chatId,'external-1');assert.equal(saved[0].storedSessionId,'external-1');assert.ok(calls.some(path=>path.endsWith('/chats/bind')));
});

test('associating an existing Chat keeps the current Chat and draft until the user opens it', async()=>{
  const {plugin,root}=pluginHarness();const saved:any[]=[];let changed=0;
  plugin.workController.noteChat=()=>{changed++;};
  plugin.threads=[{id:'old-local',storedSessionId:'old-external',adapter:'studio',state:'ready',profile:'default',documentRootId:ROOT,connectionId:'studio-default',title:'原对话',messages:[],createdAt:'2026-09-28T00:00:00Z'}];
  plugin.activeThreadId='old-local';plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[],listPending:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const draft=root.querySelector<HTMLTextAreaElement>('.sac-composer textarea')!;draft.value='尚未发送的草稿';
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url:any,init:any)=>{const path=String(url);if(path.endsWith('/sessions'))return Response.json({data:[{id:'external-1',title:'已有对话'}]});if(path.endsWith('/chats/bind')){const body=JSON.parse(init.body);return Response.json({chat:{chatId:body.chat_id,connectionId:'studio-default',kind:'studio',profile:'default',documentRootId:ROOT,title:'已有对话',state:'ready',storedSessionId:'external-1',installId:null}});}if(path.includes('/messages'))return Response.json({data:[]});throw new Error('unexpected route');};
  try{
    plugin.activateDraft();draft.value='尚未发送的草稿';plugin.saveDraft(root);plugin.bind(root);root.querySelector<HTMLButtonElement>('[data-action="chat-actions-menu"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="associate-studio"]')!.click();
    await tick();await tick();
    const picker=root.querySelector<HTMLElement>('.sac-studio-picker')!;
    assert.ok(picker);assert.equal(picker.parentElement,root.querySelector('[data-chat-menu-anchor]'));
    const radio=picker.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));
    await picker.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick!(new (root.ownerDocument.defaultView as any).MouseEvent('click'));
    assert.equal(saved.length,1);assert.equal(plugin.activeThreadId,'old-local');assert.equal(changed,0);
    assert.equal(draft.value,'尚未发送的草稿');assert.equal(plugin.currentDocumentId(),ROOT);
    assert.equal(root.querySelector('.sac-studio-picker'),null);
    assert.match(root.querySelector('[data-status]')?.textContent||'',/已关联.*未切换/);
    root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.click();
    await tick();await tick();
  }finally{globalThis.fetch=originalFetch;}
  assert.equal(plugin.activeThreadId,saved[0].chatId);assert.equal(changed,1);
  assert.equal(draft.value,'');await plugin.selectChat(root,'old-local');assert.equal(draft.value,'尚未发送的草稿');
});

test('two association clicks share one candidate request and one picker', async()=>{
  const {plugin,root}=pluginHarness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let candidates=0;
  plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{candidates++;await gate;return Response.json({data:[{id:'external-1',title:'已有对话'}]});};
  try{const first=plugin.associateStudio(root as HTMLElement),second=plugin.associateStudio(root as HTMLElement);await tick();assert.equal(candidates,1);assert.match(root.querySelector('[data-studio-options] [data-studio-loading]')?.textContent||'',/正在读取/);assert.equal(root.ownerDocument.activeElement?.getAttribute('role'),'dialog');release();await Promise.all([first,second]);}finally{globalThis.fetch=originalFetch;}
  assert.equal(root.querySelectorAll('.sac-studio-picker').length,1);
});

test('closing a floating panel during candidate loading releases association and drops late picker', async()=>{
  const {plugin,root}=pluginHarness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  root.id='siyuan-ai-collab-panel';plugin.floatingPanel=root;plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{await gate;return Response.json({data:[{id:'external-1'}]});};
  try{const loading=plugin.associateStudio(root as HTMLElement);await tick();plugin.toggleFloatingPanel();release();await loading;}finally{globalThis.fetch=originalFetch;}
  assert.equal(plugin.associationOpen,false);assert.equal(root.querySelector('.sac-studio-picker'),null);
});

test('closing a floating panel with an open picker releases association and removes picker', async()=>{
  const {plugin,root}=pluginHarness();root.id='siyuan-ai-collab-panel';plugin.floatingPanel=root;plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({data:[{id:'external-1'}]});
  try{await plugin.associateStudio(root as HTMLElement);assert.ok(root.querySelector('.sac-studio-picker'));plugin.toggleFloatingPanel();}finally{globalThis.fetch=originalFetch;}
  assert.equal(plugin.associationOpen,false);assert.equal(root.querySelector('.sac-studio-picker'),null);
});

test('closing a floating panel during bind keeps accepted record but ignores late UI selection', async()=>{
  const {plugin,root}=pluginHarness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const saved:any[]=[];
  root.id='siyuan-ai-collab-panel';plugin.floatingPanel=root;plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[],listPending:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{if(String(url).endsWith('/sessions'))return Response.json({data:[{id:'external-1',title:'已有对话'}]});if(String(url).endsWith('/chats/bind')){const body=JSON.parse(init.body);await gate;return Response.json({chat:{chatId:body.chat_id,connectionId:'studio-default',kind:'studio',profile:'default',documentRootId:ROOT,title:'已有对话',state:'ready',storedSessionId:'external-1',installId:null}});}return Response.json({data:[]});};
  try{await plugin.associateStudio(root as HTMLElement);const radio=root.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));const binding=root.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick!(new (root.ownerDocument.defaultView as any).MouseEvent('click'));await tick();plugin.toggleFloatingPanel();release();await binding;}finally{globalThis.fetch=originalFetch;}
  assert.equal(saved.length,1);assert.equal(plugin.associationOpen,false);assert.equal(plugin.activeThreadId,'');assert.equal(root.querySelector('.sac-studio-picker'),null);
});

test('a completed bind after floating close cannot assign a second Chat ID to the same candidate', async()=>{
  const {plugin,root}=pluginHarness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const saved:any[]=[];let binds=0;
  root.id='siyuan-ai-collab-panel';plugin.floatingPanel=root;plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>saved,listPending:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{if(String(url).endsWith('/sessions'))return Response.json({data:[{id:'external-1',title:'已有对话'}]});if(String(url).endsWith('/chats/bind')){binds++;const body=JSON.parse(init.body);await gate;return Response.json({chat:{chatId:body.chat_id,connectionId:'studio-default',kind:'studio',profile:'default',documentRootId:ROOT,title:'已有对话',state:'ready',storedSessionId:'external-1',installId:null}});}return Response.json({data:[]});};
  try{
    await plugin.associateStudio(root as HTMLElement);const radio=root.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));const first=root.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick!(new (root.ownerDocument.defaultView as any).MouseEvent('click'));
    await tick();plugin.toggleFloatingPanel();release();await first;
    const next=root.ownerDocument.createElement('div');next.className='sac';root.ownerDocument.body.appendChild(next);next.innerHTML=createChatShell();attachHermesRoomView(plugin,next);
    await plugin.associateStudio(next);const nextRadio=next.querySelector<HTMLInputElement>('input[type=radio]')!;nextRadio.checked=true;nextRadio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));next.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.click();await tick();await tick();
    assert.equal(binds,1);assert.equal(saved.length,1);assert.match(next.querySelector('[data-status]')!.textContent||'',new RegExp(saved[0].chatId));
  }finally{globalThis.fetch=originalFetch;}
});

test('late completion from an old picker cannot close a new picker on the rebuilt Dock root', async()=>{
  const {plugin,root}=pluginHarness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[],listPending:async()=>[],linkChat:async()=>undefined};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{if(String(url).endsWith('/sessions'))return Response.json({data:[{id:'external-1',title:'已有对话'}]});if(String(url).endsWith('/chats/bind')){const body=JSON.parse(init.body);await gate;return Response.json({chat:{chatId:body.chat_id,connectionId:'studio-default',kind:'studio',profile:'default',documentRootId:ROOT,title:'已有对话',state:'ready',storedSessionId:'external-1',installId:null}});}return Response.json({data:[]});};
  try{
    await plugin.associateStudio(root as HTMLElement);const radio=root.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));const first=root.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick!(new (root.ownerDocument.defaultView as any).MouseEvent('click'));
    await tick();plugin.invalidateAssociationFor(root);root.innerHTML=createChatShell();await plugin.associateStudio(root as HTMLElement);const newer=root.querySelector('.sac-studio-picker');assert.ok(newer);
    release();await first;
    assert.equal(root.querySelector('.sac-studio-picker'),newer);assert.equal(plugin.associationOpen,true);
  }finally{globalThis.fetch=originalFetch;}
});

test('pending unknown association blocks a new UUID for the same candidate', async()=>{
  const {plugin,root}=pluginHarness();let binds=0;
  plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[],listPending:async()=>[{id:'chat:old-local',kind:'chat',workId:'work-1',state:'unknown',details:`关联 Chat 回执后本地正式关系保存失败；chatId=old-local connectionId=studio-default documentRootId=${ROOT} storedSessionId=external-1`,updatedAt:'2026-09-24T00:00:00Z'}]};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{if(String(url).endsWith('/sessions'))return Response.json({data:[{id:'external-1',title:'已有对话'}]});binds++;throw new Error('must not bind');};
  try{await plugin.associateStudio(root as HTMLElement);const radio=root.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));root.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.click();await tick();await tick();}finally{globalThis.fetch=originalFetch;}
  assert.equal(binds,0);assert.match(root.querySelector('[data-status]')!.textContent||'',/old-local.*核对/);
});

test('double candidate confirmation sends one bind request', async()=>{
  const {plugin,root}=pluginHarness();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let binds=0,candidates=0;
  plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[],listPending:async()=>[],linkChat:async()=>undefined};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{if(String(url).endsWith('/sessions')){candidates++;return Response.json({data:[{id:'external-1',title:'已有对话'}]});}if(String(url).endsWith('/chats/bind')){binds++;const body=JSON.parse(init.body);await gate;return Response.json({chat:{chatId:body.chat_id,connectionId:'studio-default',kind:'studio',profile:'default',documentRootId:ROOT,title:'已有对话',state:'ready',storedSessionId:'external-1',installId:null}});}return Response.json({data:[]});};
  try{await plugin.associateStudio(root as HTMLElement);const radio=root.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));const confirm=root.querySelector<HTMLButtonElement>('[data-studio-confirm]')!;const first=confirm.onclick!(new (root.ownerDocument.defaultView as any).MouseEvent('click'));const second=confirm.onclick!(new (root.ownerDocument.defaultView as any).MouseEvent('click'));await tick();root.querySelector<HTMLButtonElement>('[data-studio-cancel]')!.click();await plugin.associateStudio(root as HTMLElement);assert.equal(candidates,1);assert.equal(binds,1);release();await Promise.all([first,second]);}finally{globalThis.fetch=originalFetch;}
  assert.equal(binds,1);
});

test('successful bind acknowledgement with local save failure preserves selected ID and pending evidence', async()=>{
  const {plugin,root}=pluginHarness();const pending:any[]=[];let sentId='';
  plugin.activeThreadId='old-local';
  plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[],listPending:async()=>[],linkChat:async()=>{throw new Error('formal store damaged');},setPending:async(value:any)=>pending.push(value)};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{if(String(url).endsWith('/sessions'))return Response.json({data:[{id:'external-1',title:'已有对话'}]});if(String(url).endsWith('/chats/bind')){sentId=JSON.parse(init.body).chat_id;return Response.json({chat:{chatId:sentId,connectionId:'studio-default',kind:'studio',profile:'default',documentRootId:ROOT,title:'已有对话',state:'ready',storedSessionId:'external-1',installId:null}});}return Response.json({data:[]});};
  try{await plugin.associateStudio(root as HTMLElement);const radio=root.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));root.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.click();await tick();await tick();}finally{globalThis.fetch=originalFetch;}
  assert.equal(pending.length,1);assert.match(pending[0].details,new RegExp(sentId));assert.match(pending[0].details,/external-1/);assert.equal(plugin.activeThreadId,'old-local');assert.match(root.querySelector('[data-status]')!.textContent||'',new RegExp(sentId));
});

test('uncertain candidate bind keeps one unknown local relation and cannot confirm twice', async()=>{
  const {plugin,root}=pluginHarness();const saved:any[]=[];let binds=0;
  plugin.activeThreadId='old-local';
  plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];
  plugin.workStore={listChats:async()=>[],listPending:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{if(String(url).endsWith('/sessions'))return Response.json({data:[{id:'external-1',title:'已有对话'}]});binds++;throw new Error('network lost');};
  try{await plugin.associateStudio(root as HTMLElement);const radio=root.querySelector<HTMLInputElement>('input[type=radio]')!;radio.checked=true;radio.dispatchEvent(new (root.ownerDocument.defaultView as any).Event('change',{bubbles:true}));root.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.click();await tick();await tick();}finally{globalThis.fetch=originalFetch;}
  assert.equal(binds,1);assert.equal(saved.length,1);assert.equal(saved[0].state,'unknown');assert.equal(saved[0].storedSessionId,'external-1');assert.equal(plugin.activeThreadId,'old-local');assert.equal(root.querySelector('[data-studio-confirm]'),null);
});

test('legacy classification uses only exact original Bridge evidence', async()=>{
  const {plugin,root}=pluginHarness();const classified:any[]=[];
  const link={chatId:'siyuan:'+ROOT+':old',workId:'work-1',documentRootId:ROOT,connectionId:'http://127.0.0.1:8784',adapter:'unresolved',profile:'default',storedSessionId:null,legacyCandidateId:'external-1',legacyBridgeUrl:'http://127.0.0.1:8784',installId:null,title:'旧 Chat',state:'source-unknown'};
  const resolved={...link,connectionId:'studio-default',adapter:'studio',state:'ready',storedSessionId:'external-1'};
  plugin.workStore={listChats:async()=>[link],getResume:async()=>null,listPending:async()=>[],resolveLegacyChat:async(...args:any[])=>classified.push(args),chatLink:async()=>resolved};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url:any)=>{assert.match(String(url),/^http:\/\/127\.0\.0\.1:8784\/legacy-bindings$/);return Response.json({data:[{chatId:link.chatId,documentRootId:ROOT,storedSessionId:'wrong',connectionId:'studio-default',adapter:'studio',profile:'default',installId:null},{chatId:link.chatId,documentRootId:ROOT,storedSessionId:'external-1',connectionId:'studio-default',adapter:'studio',profile:'default',installId:null}]});};
  try{await plugin.onWorkChanged('work-1');}finally{globalThis.fetch=originalFetch;}
  assert.equal(classified.length,1);assert.equal(classified[0][0],link.chatId);assert.equal(classified[0][1].storedSessionId,'external-1');assert.equal(classified[0][2],'http://127.0.0.1:8784');
  assert.equal(plugin.threads[0].id,link.chatId);assert.equal(plugin.threads[0].storedSessionId,'external-1');
  assert.match(root.querySelector('[data-thread-selector]')!.textContent||'',/Studio/);
});

test('late Work load cannot replace the current Work or active Chat', async()=>{
  const {plugin,root}=pluginHarness();let release!:()=>void;
  const delayed=new Promise<void>(resolve=>{release=resolve;});
  const makeLink=(id:string)=>({chatId:id,workId:id,documentRootId:ROOT,connectionId:'serve-local',adapter:'serve',profile:'default',storedSessionId:'session-'+id,installId:'install-1',title:id,state:'ready'});
  plugin.workStore={listChats:async(id:string)=>{if(id==='old')await delayed;return [makeLink(id)];},getResume:async()=>null,listPending:async()=>[]};
  plugin.workController.currentWorkId='old';const old=plugin.onWorkChanged('old');
  plugin.workController.currentWorkId='new';const newer=plugin.onWorkChanged('new');
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({data:[]});
  try{await newer;release();await old;}finally{globalThis.fetch=originalFetch;}
  assert.equal(plugin.activeThreadId,'new');assert.equal(plugin.threads.length,1);assert.equal(plugin.threads[0].id,'new');
  assert.match(root.querySelector('[data-thread-selector]')!.textContent||'',/new/);
});

test('returning to a Work shows pending Chat IDs missing from formal links', async()=>{
  const {plugin,root}=pluginHarness();let requests=0;
  plugin.workStore={listChats:async()=>[],getResume:async()=>null,listPending:async()=>[{id:'chat:lost-local',kind:'chat',workId:'work-1',state:'unknown',details:`关联 Chat 回执后本地正式关系保存失败；chatId=lost-local connectionId=studio-default documentRootId=${ROOT} storedSessionId=external-1`,updatedAt:'2026-09-24T00:00:00Z'}]};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{requests++;throw new Error('must not request');};
  try{await plugin.onWorkChanged('work-1');}finally{globalThis.fetch=originalFetch;}
  assert.equal(requests,0);assert.match(root.querySelector('[data-pending-chats]')!.textContent||'',/lost-local.*未决/);
  assert.equal(plugin.threads.some((item:any)=>item.id==='lost-local'),false,'pending evidence must not become a ready Chat');
});

test('damaged pending store reports failure while retaining formal Chat list', async()=>{
  const {plugin,root}=pluginHarness();const link={chatId:'formal-local',workId:'work-1',documentRootId:ROOT,connectionId:'studio-default',adapter:'studio',profile:'default',storedSessionId:'external-1',installId:null,title:'正式 Chat',state:'ready'};
  plugin.workStore={listChats:async()=>[link],getResume:async()=>null,listPending:async()=>{throw new Error('pending damaged');}};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({data:[]});
  try{await plugin.onWorkChanged('work-1');}finally{globalThis.fetch=originalFetch;}
  assert.equal(plugin.threads[0].id,'formal-local');assert.match(root.querySelector('[data-thread-selector]')!.textContent||'',/正式 Chat/);
  assert.match(root.querySelector('[data-pending-chats]')!.textContent||'',/未决.*读取失败/);
});

test('Work restore reports both offline history and pending Chat evidence', async()=>{
  const {plugin,root}=pluginHarness();const link={chatId:'formal-local',workId:'work-1',documentRootId:ROOT,connectionId:'studio-default',adapter:'studio',profile:'default',storedSessionId:'external-1',installId:null,title:'正式 Chat',state:'ready'};
  plugin.workStore={listChats:async()=>[link],getResume:async()=>null,listPending:async()=>[{id:'chat:lost-local',kind:'chat',workId:'work-1',state:'unknown',details:'chatId=lost-local',updatedAt:'2026-09-24T00:00:00Z'}]};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('history offline');};
  try{await plugin.onWorkChanged('work-1');}finally{globalThis.fetch=originalFetch;}
  assert.match(root.querySelector('[data-status]')!.textContent||'',/历史暂不可读取/);
  assert.match(root.querySelector('[data-pending-chats]')!.textContent||'',/lost-local.*未决/);
});

test('pending notice survives connection refresh and clears when switching to a clean Work', async()=>{
  const {plugin,root}=pluginHarness();plugin.workStore={listChats:async()=>[],getResume:async()=>null,listPending:async()=>plugin.workController.currentWorkId==='work-1'?[{id:'chat:lost-local',kind:'chat',workId:'work-1',state:'unknown',details:'chatId=lost-local',updatedAt:'2026-09-24T00:00:00Z'}]:[]};
  await plugin.onWorkChanged('work-1');plugin.updateConnectionUI(true);
  assert.match(root.querySelector('[data-pending-chats]')!.textContent||'',/lost-local/);
  assert.equal(root.querySelector('[data-status-alert]')!.hasAttribute('hidden'),false);
  plugin.bind(root);(root.querySelector('[data-action="dismiss-status"]') as HTMLElement).click();
  assert.equal(root.querySelector('[data-status-alert]')!.hasAttribute('hidden'),false,'dismiss only clears transient status');
  plugin.workController.currentWorkId='work-2';await plugin.onWorkChanged('work-2');
  assert.equal(root.querySelector('[data-pending-chats]')!.textContent,'');
  assert.equal(root.querySelector('[data-status-alert]')!.hasAttribute('hidden'),true);
});

test('unconfirmed local placeholder cannot be falsely linked as a formal Chat', async()=>{
  const {plugin}=pluginHarness();let writes=0;
  plugin.workStore={linkChat:async()=>{writes++;}};
  await assert.rejects(plugin.linkCurrentChat(),/请先.*新建|关联/);
  assert.equal(writes,0);
});

test('new Chat accepted after Work switch remains saved to its original Work', async()=>{
  const {plugin,root,dom}=pluginHarness();const saved:any[]=[];const pins:any[]=[];let release!:()=>void;
  const responseReady=new Promise<void>(resolve=>{release=resolve;});
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>[{documentId:ROOT,blockId:null,kind:'document'}],linkChat:async(value:any)=>saved.push(value),setPins:async(...args:any[])=>pins.push(args)};
  dom.window.confirm=()=>true;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url:any,init:any)=>{await responseReady;const body=JSON.parse(init.body);return Response.json({chat:{chatId:body.chat_id,connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{const creating=plugin.startNewChat(root as HTMLElement);await tick();plugin.workController.currentWorkId='work-2';plugin.setStatus(root,'目的 Work 状态保持');release();await creating;}finally{globalThis.fetch=originalFetch;}
  assert.equal(saved.length,1);assert.equal(saved[0].workId,'work-1');assert.equal(saved[0].state,'pending');
  assert.equal(pins.length,1);assert.equal(pins[0][0],saved[0].chatId);
  assert.equal(plugin.threads.some((item:any)=>item.id===saved[0].chatId),false);
  assert.equal(root.querySelector('[data-status]')!.textContent,'目的 Work 状态保持');
});

test('failed pin carry does not hide an already saved pending Chat', async()=>{
  const {plugin,root,dom}=pluginHarness();const saved:any[]=[];
  dom.window.confirm=()=>true;
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>[{documentId:ROOT,blockId:null,kind:'document'}],linkChat:async(value:any)=>saved.push(value),setPins:async()=>{throw new Error('pin write failed');}};
  const originalFetch=globalThis.fetch;globalThis.fetch=async(_url:any,init:any)=>{const body=JSON.parse(init.body);return Response.json({chat:{chatId:body.chat_id,connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(saved.length,1);assert.equal(plugin.activeThreadId,saved[0].chatId);
  assert.match(root.querySelector('[data-status]')!.textContent||'',/固定资料.*失败/);
});

test('unknown create transport outcome preserves local ID without re-sending', async()=>{
  const {plugin,root}=pluginHarness();const saved:any[]=[];let sends=0;
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{sends++;throw new Error('network lost');};
  try{await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(sends,1);assert.equal(saved.length,1);assert.equal(saved[0].state,'unknown');assert.match(saved[0].chatId,/^[0-9a-f-]{36}$/);
});

test('new Chat stops before external create when old fixed references cannot be read', async()=>{
  const {plugin,root}=pluginHarness();let sends=0;
  plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.workStore={getPins:async()=>{throw new Error('pins damaged');}};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{sends++;throw new Error('must not send');};
  try{await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(sends,0);assert.match(root.querySelector('[data-status]')!.textContent||'',/固定资料/);
});

test('server error after possible pending write retains an unknown local Chat', async()=>{
  const {plugin,root}=pluginHarness();const saved:any[]=[];let sends=0;
  plugin.connectionViews=[{id:'studio-default',kind:'studio',displayName:'Studio',state:'ready',profile:'default',installId:null}];plugin.selectedConnectionId='studio-default';plugin.confirmedConnectionId='studio-default';
  plugin.workStore={getPins:async()=>[],linkChat:async(value:any)=>saved.push(value)};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{sends++;return Response.json({error:{code:'internal_error',message:'private'}},{status:503});};
  try{await plugin.startNewChat(root as HTMLElement);}finally{globalThis.fetch=originalFetch;}
  assert.equal(sends,1);assert.equal(saved.length,1);assert.equal(saved[0].state,'unknown');assert.equal(saved[0].connectionId,'studio-default');
});

test('reconnect checks selected connection without reloading unrelated Chat histories', async()=>{
  const {plugin}=pluginHarness();const calls:string[]=[];
  plugin.onWorkChanged=async()=>assert.fail('reconnect must not reload every Work Chat');
  const originalFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{calls.push(String(url));return Response.json({data:[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}]});};
  try{await plugin.syncHermesSessions();}finally{globalThis.fetch=originalFetch;}
  assert.deepEqual(calls,['http://127.0.0.1:8782/connections']);
});

test('failed connection refresh disables stale ready selection', ()=>{
  const {plugin,root}=pluginHarness();plugin.connectionViews=[{id:'serve-local',kind:'serve',displayName:'Hermes 服务',state:'ready',profile:'default',installId:'install-1'}];
  plugin.updateConnectionUI(false,new Error('offline'));
  assert.throws(()=>plugin.checkSelectedConnection(),/未连接|不可用/);
  assert.match(renderConnectionChoices(plugin.connectionViews,plugin.selectedConnectionId),/未连接/);
});

test('old Studio Chat and its local title remain visible when history is offline', async()=>{
  const {plugin,root}=pluginHarness();
  const link={chatId:'old-local-chat',workId:'work-1',documentRootId:ROOT,connectionId:'studio-default',adapter:'studio',profile:'default',storedSessionId:'old-external',legacyBridgeUrl:'http://127.0.0.1:8784',installId:null,title:'保留的 Studio 对话',state:'ready'};
  plugin.workStore={listChats:async()=>[link],getResume:async()=>({chatId:link.chatId}),listPending:async()=>[]};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('offline');};
  try{await plugin.onWorkChanged('work-1');}finally{globalThis.fetch=originalFetch;}
  assert.equal(plugin.activeThreadId,link.chatId);assert.equal(plugin.threads[0].storedSessionId,'old-external');
  assert.match(root.querySelector('[data-thread-selector]')!.textContent||'',/保留的 Studio 对话.*Studio/);
  assert.match(root.querySelector('[data-status]')!.textContent||'',/历史暂不可读取/);
});
