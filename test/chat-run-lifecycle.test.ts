import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { createChatShell } from '../src/ui.ts';
import { streamThreadChat } from '../src/provider.ts';
import { WorkStore, type ChatLink } from '../src/work/store.ts';

const ROOT='20260923123456-abcdefg';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function pluginHarness(){
  const dom=new JSDOM('<!doctype html><html><body><div id="dock"></div></body></html>');
  Object.assign(globalThis,{document:dom.window.document,window:dom.window,MutationObserver:dom.window.MutationObserver});
  const originalLoad=(Module as any)._load;
  (Module as any)._load=function(request:string,parent:any,isMain:boolean){if(request==='siyuan')return {Plugin:class {},getAllEditor:()=>[]};return originalLoad.call(this,request,parent,isMain);};
  let PluginClass:any;
  try{PluginClass=createRequire(import.meta.url)('../dist/index.js').default;}finally{(Module as any)._load=originalLoad;}
  const plugin:any=new PluginClass();const root=dom.window.document.getElementById('dock')!;root.innerHTML=createChatShell();
  plugin.bridgeUrl='http://127.0.0.1:8782';plugin.bridgeToken='test-capability';plugin.currentDocumentId=()=>ROOT;
  plugin.workController={currentWorkId:'work-1',contextChoice:null,noteChat:()=>undefined,clearOnceContext:()=>undefined,updateReferenceSummary:()=>{}};
  const link={chatId:'local-1',workId:'work-1',documentRootId:ROOT,connectionId:'serve-local',adapter:'serve',profile:'default',storedSessionId:null,installId:'install-1',title:'新对话',state:'pending'};
  plugin.threads=[{id:'local-1',adapter:'serve',state:'pending',connectionId:'serve-local',profile:'default',installId:'install-1',storedSessionId:undefined,documentRootId:ROOT,title:'新对话',messages:[]}];plugin.activeThreadId='local-1';
  plugin.workStore={chatLink:async()=>link,listPending:async()=>[],confirmChatSession:async()=>({...link,state:'ready',storedSessionId:'stored-1'}),setPending:async()=>undefined,clearPending:async()=>undefined};
  plugin.prepareRequestSnapshot=async()=>({documentId:ROOT,contextText:'冻结资料',nearby:[]});
  plugin.roomViews.set(root,{leave:()=>{},dispose:()=>{}});return {plugin,root,link};
}

for(const route of ['legacy','v2'])test(`Studio ${route} completion-only output reaches the actual plugin reply and clipboard`,async()=>{
  const {plugin,root,link}=pluginHarness();
  Object.assign(link,{connectionId:'studio-default',adapter:'studio',state:'ready',storedSessionId:'stored-1',installId:null});
  Object.assign(plugin.threads[0],link,{id:link.chatId,hermesSessionId:'stored-1',...(route==='legacy'?{legacyBridgeUrl:plugin.bridgeUrl}:{})});
  root.querySelector<HTMLTextAreaElement>('textarea')!.value='synthetic question';
  const reply='完整回复\n\n必须保留的最后一段';const copies:string[]=[];let sends=0;
  Object.defineProperty(root.ownerDocument.defaultView!.navigator,'clipboard',{value:{writeText:async(value:string)=>{copies.push(value);}}});
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{
    if(String(url).endsWith('/chat/stream')){sends++;assert.equal(init.method,'POST');return new Response(`event: run.started\ndata: {"session_id":"stored-1","run_id":"synthetic-upstream"}\n\nevent: run.completed\ndata: ${JSON.stringify({output:reply,session_id:'stored-1'})}\n\n`);}
    assert.ok(String(url).endsWith('/chats/local-1'));return Response.json({chat:{...link,kind:'studio'}});
  };
  try{
    await plugin.send(root);assert.equal(sends,1);
    const assistant=plugin.threads[0].messages.filter((message:any)=>message.role==='assistant');
    assert.equal(assistant.at(-1)?.content,reply);
    assert.match(root.querySelector('.sac-message-assistant .sac-message-body')!.textContent||'',/必须保留的最后一段/);
    root.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click();await tick();
    assert.deepEqual(copies,[reply]);assert.equal(sends,1);
  }finally{globalThis.fetch=oldFetch;root.ownerDocument.defaultView!.close();}
});

for(const event of ['run.unknown','run.interrupted','run.queued'])test(`legacy ${event} preserves the plugin pending record and received text despite late completion`,async()=>{
  const {plugin,root,link}=pluginHarness();
  Object.assign(link,{connectionId:'studio-default',adapter:'studio',state:'ready',storedSessionId:'stored-1',installId:null});
  Object.assign(plugin.threads[0],link,{id:link.chatId,hermesSessionId:'stored-1',legacyBridgeUrl:plugin.bridgeUrl});
  root.querySelector<HTMLTextAreaElement>('textarea')!.value='synthetic question';
  const pending:any[]=[];let sends=0,clears=0;
  plugin.workStore.setPending=async(value:any)=>{pending.splice(0,pending.length,value);};
  plugin.workStore.listPending=async()=>pending;
  plugin.workStore.clearPending=async()=>{clears++;pending.length=0;};
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any,init:any)=>{
    assert.equal(String(url),'http://127.0.0.1:8782/sessions/stored-1/chat/stream');assert.equal(init.method,'POST');sends++;
    return new Response(`event: message.delta\ndata: {"delta":"已到达片段"}\n\nevent: ${event}\ndata: {}\n\nevent: message.delta\ndata: {"delta":"迟到文字"}\n\nevent: run.completed\ndata: {"output":"wrong turn"}\n\n`);
  };
  try{
    await plugin.send(root);
    assert.equal(sends,1);assert.equal(clears,0);assert.equal(pending.length,1);assert.equal(pending[0].state,'unknown');
    const assistant=plugin.threads[0].messages.filter((message:any)=>message.role==='assistant').at(-1);
    assert.equal(assistant.content,'已到达片段');assert.equal(assistant.status,'error');
    assert.match(root.querySelector('.sac-message-assistant .sac-message-body')!.textContent||'',/已到达片段/);
    assert.doesNotMatch(root.textContent||'',/迟到文字|wrong turn/);
  }finally{globalThis.fetch=oldFetch;root.ownerDocument.defaultView!.close();}
});

test('pending Serve chat keeps draft until acceptance and sends only once',async()=>{
  const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='问题';
  let controller!:ReadableStreamDefaultController<Uint8Array>;let submits=0,reads=0;
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{
    if(String(url).endsWith('/chat/stream')){submits++;return new Response(new ReadableStream<Uint8Array>({start(c){controller=c;}}),{status:200});}
    if(String(url).endsWith('/chats/local-1'))return Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:++reads===1?'pending':'ready',storedSessionId:reads===1?null:'stored-1',installId:'install-1'}});
    throw new Error('unexpected request');
  };
  try{
    const first=plugin.send(root),second=plugin.send(root);await tick();assert.equal(submits,1);assert.equal(textarea.value,'问题');
    controller.enqueue(new TextEncoder().encode('event: run.started\ndata: {"userRowId":12}\n\n'));await tick();assert.equal(textarea.value,'');
    controller.enqueue(new TextEncoder().encode('event: run.completed\ndata: {"text":"答复"}\n\n'));controller.close();await Promise.all([first,second]);
  }finally{globalThis.fetch=oldFetch;}
});

test('pending Serve is sendable while source-unknown stays blocked',async()=>{
  const snapshot:any={documentId:ROOT,contextText:'资料',nearby:[]};const thread:any={id:'local-1',adapter:'serve',state:'pending',connectionId:'serve-local',storedSessionId:undefined};
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>new Response('event: run.queued\ndata: {}\n\n',{status:200});
  try{const result=await streamThreadChat(thread,'问题',snapshot,{bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'test-capability',documentRootId:ROOT},()=>{});assert.equal(result.state,'queued');}
  finally{globalThis.fetch=oldFetch;}
  await assert.rejects(()=>streamThreadChat({...thread,adapter:'unresolved',state:'source-unknown'},'问题',snapshot,{bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'test-capability',documentRootId:ROOT},()=>{}),/待确认/);
});

test('local ready promotion requires exact fixed identity and preserves the pending record on mismatch',async()=>{
  const values=new Map<string,unknown>();const store=new WorkStore({loadData:async key=>values.get(key),saveData:async(key,value)=>{values.set(key,structuredClone(value));}});
  const link:ChatLink={chatId:'local-1',workId:'work-1',documentRootId:ROOT,connectionId:'serve-local',adapter:'serve',profile:'default',storedSessionId:null,installId:'install-1',title:'新对话',state:'pending'};
  await store.registerWork('work-1');await store.linkChat(link);
  await assert.rejects(store.confirmChatSession({...link,connectionId:'serve-other'},'stored-1'),/身份/);
  assert.equal((await store.chatLink('local-1'))?.state,'pending');
  const ready=await store.confirmChatSession(link,'stored-1');assert.equal(ready.state,'ready');assert.equal(ready.storedSessionId,'stored-1');
  await assert.rejects(store.confirmChatSession(link,'stored-2'),/身份/);
  assert.equal((await store.chatLink('local-1'))?.storedSessionId,'stored-1');
});

test('Work or fixed connection changing while context loads leaves the draft unsent',async()=>{
  const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='保留草稿';
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let sends=0;
  plugin.prepareRequestSnapshot=async()=>{await gate;return {documentId:ROOT,contextText:'冻结资料',nearby:[]};};
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{sends++;throw new Error('must not send');};
  try{const run=plugin.send(root);await tick();plugin.threads[0].connectionId='serve-other';release();await run;assert.equal(sends,0);assert.equal(textarea.value,'保留草稿');assert.match(root.querySelector('[data-status]')!.textContent||'',/变化/);}
  finally{globalThis.fetch=oldFetch;}
});

test('queued acceptance clears draft but records an unresolved run and never parses a completion',async()=>{
  const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='排队问题';const pending:any[]=[];let reads=0;
  plugin.workStore.setPending=async(value:any)=>pending.push(value);
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>String(url).endsWith('/chat/stream')
    ? new Response('event: run.queued\ndata: {}\n\n',{status:200})
    : Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:++reads===1?null:'stored-1',installId:'install-1'}});
  try{await plugin.send(root);assert.equal(textarea.value,'');assert.equal(pending.length,2);assert.match(root.querySelector('[data-status]')!.textContent||'',/已排队/);assert.equal(plugin.pendingProposal,null);}
  finally{globalThis.fetch=oldFetch;}
});

test('Stop uses Bridge ownership result and does not abort the browser stream',async()=>{
  const {plugin,root}=pluginHarness();let stops=0;plugin.activeRunChatId='local-1';plugin.activeRunBridge={chatId:'local-1',documentRootId:ROOT,bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'test-capability'};plugin.abortController=new AbortController();
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{assert.match(String(url),/\/chats\/local-1\/stop$/);stops++;return Response.json({state:'unknown'});};
  try{await plugin.stopCurrentRun(root);assert.equal(stops,1);assert.equal(plugin.abortController.signal.aborted,false);assert.match(root.querySelector('[data-status]')!.textContent||'',/无法确认/);}
  finally{globalThis.fetch=oldFetch;}
});

test('Stop uses the frozen Bridge address and capability after settings change',async()=>{
  const {plugin,root}=pluginHarness();plugin.activeRunChatId='local-1';plugin.activeRunBridge={chatId:'local-1',documentRootId:ROOT,bridgeUrl:'http://127.0.0.1:8783',capabilityToken:'original-capability'};plugin.bridgeUrl='http://127.0.0.1:8785';plugin.bridgeToken='other-capability';
  const oldFetch=globalThis.fetch;const calls:any[]=[];globalThis.fetch=async(url:any,init:any)=>{calls.push({url:String(url),headers:init.headers});return Response.json({state:'unknown'});};
  try{await plugin.stopCurrentRun(root);assert.equal(calls.length,1);assert.equal(calls[0].url,'http://127.0.0.1:8783/chats/local-1/stop');assert.equal(calls[0].headers['X-Siyuan-Collab-Token'],'original-capability');}
  finally{globalThis.fetch=oldFetch;}
});

test('Studio Stop retains its abort path and does not claim confirmed interruption',async()=>{
  const {plugin,root}=pluginHarness();plugin.threads[0].adapter='studio';plugin.activeRunChatId='local-1';plugin.abortController=new AbortController();let requests=0;
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{requests++;throw new Error('unexpected');};
  try{await plugin.stopCurrentRun(root);assert.equal(plugin.abortController.signal.aborted,true);assert.equal(requests,0);assert.match(root.querySelector('[data-status]')!.textContent||'',/核对/);}
  finally{globalThis.fetch=oldFetch;}
});

test('run.completed without Bridge ready confirmation remains unresolved locally',async()=>{
  const {plugin,root}=pluginHarness();root.querySelector<HTMLTextAreaElement>('textarea')!.value='问题';const pending:any[]=[];let reads=0;
  plugin.workStore.setPending=async(value:any)=>pending.push(value);
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>String(url).endsWith('/chat/stream')
    ? new Response('event: run.started\ndata: {"userRowId":12}\n\nevent: run.completed\ndata: {"text":"答复"}\n\n',{status:200})
    : Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:++reads===1?null:'stored-1',installId:'install-1'}});
  try{await plugin.send(root);assert.equal(pending.length,2);assert.match(root.querySelector('[data-status]')!.textContent||'',/未确认/);assert.equal(plugin.pendingProposal,null);}
  finally{globalThis.fetch=oldFetch;}
});

test('failed durable run blocker prevents the first side-effect request and keeps draft',async()=>{
  const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='保留';let streams=0;
  plugin.workStore.setPending=async()=>{throw new Error('pending store failed');};
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{if(String(url).endsWith('/chat/stream'))streams++;return Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{await plugin.send(root);assert.equal(streams,0);assert.equal(textarea.value,'保留');assert.match(root.querySelector('[data-status]')!.textContent||'',/草稿已保留|未决/);}
  finally{globalThis.fetch=oldFetch;}
});

test('queued run keeps its initial durable blocker when a later detail update fails',async()=>{
  const {plugin,root}=pluginHarness();root.querySelector<HTMLTextAreaElement>('textarea')!.value='排队问题';const markers:any[]=[];let writes=0,streams=0;
  plugin.workStore.listPending=async()=>markers;
  plugin.workStore.setPending=async(value:any)=>{writes++;if(writes>1)throw new Error('detail update failed');markers.splice(0,markers.length,value);};
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>String(url).endsWith('/chat/stream')
    ? (assert.equal(markers.length,1,'durable blocker must predate stream POST'),streams++,new Response('event: run.queued\ndata: {}\n\n',{status:200}))
    : Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});
  try{await plugin.send(root);assert.equal(streams,1);assert.equal(markers.length,1);assert.equal(markers[0].id,'chat-run:local-1');const restarted=pluginHarness();restarted.plugin.workStore=plugin.workStore;restarted.root.querySelector<HTMLTextAreaElement>('textarea')!.value='重发';await restarted.plugin.send(restarted.root);assert.equal(streams,1,'a new plugin instance must still see the durable blocker');}
  finally{globalThis.fetch=oldFetch;}
});

test('changing Bridge URL or capability during context load prevents sending',async()=>{
  for(const field of ['bridgeUrl','bridgeToken']){
    const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='保留';let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let requests=0;
    plugin.prepareRequestSnapshot=async()=>{await gate;return {documentId:ROOT,contextText:'资料',nearby:[]};};
    const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{requests++;throw new Error('must not send');};
    try{const run=plugin.send(root);await tick();plugin[field]=field==='bridgeUrl'?'http://other':'changed-capability';release();await run;assert.equal(requests,0,field);assert.equal(textarea.value,'保留');}
    finally{globalThis.fetch=oldFetch;}
  }
});

test('a stale Bridge address with mismatched Chat identity is rejected before POST stream',async()=>{
  const {plugin,root}=pluginHarness();root.querySelector<HTMLTextAreaElement>('textarea')!.value='保留';let streams=0;
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{if(String(url).endsWith('/chat/stream'))streams++;return Response.json({chat:{chatId:'local-1',connectionId:'serve-other',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});};
  try{await plugin.send(root);assert.equal(streams,0);assert.equal(root.querySelector<HTMLTextAreaElement>('textarea')!.value,'保留');}
  finally{globalThis.fetch=oldFetch;}
});

test('Stop while the preflight Chat GET is pending cancels locally without POST or Bridge stop',async()=>{
  const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='保留草稿';
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let reads=0,posts=0,stops=0;
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{
    if(String(url).endsWith('/chats/local-1')){reads++;await gate;return Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});}
    if(String(url).endsWith('/chat/stream'))posts++;
    if(String(url).endsWith('/stop'))stops++;
    throw new Error('unexpected side effect');
  };
  try{const sending=plugin.send(root);for(let i=0;i<20&&reads===0;i++)await tick();assert.equal(reads,1);await plugin.stopCurrentRun(root);release();await sending;assert.equal(posts,0);assert.equal(stops,0);assert.equal(textarea.value,'保留草稿');}
  finally{release();globalThis.fetch=oldFetch;}
});

test('Stop during durable intent write clears the intent only after it is known unsent',async()=>{
  const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='保留草稿';
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let writing=false,posts=0,stops=0,clears=0;const markers:any[]=[];
  plugin.workStore.setPending=async(value:any)=>{writing=true;await gate;markers.push(value);};
  plugin.workStore.clearPending=async()=>{clears++;markers.length=0;};
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{
    if(String(url).endsWith('/chats/local-1'))return Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});
    if(String(url).endsWith('/chat/stream'))posts++;
    if(String(url).endsWith('/stop'))stops++;
    throw new Error('unexpected side effect');
  };
  try{const sending=plugin.send(root);for(let i=0;i<20&&!writing;i++)await tick();assert.equal(writing,true);await plugin.stopCurrentRun(root);release();await sending;assert.equal(posts,0);assert.equal(stops,0);assert.equal(clears,1);assert.equal(markers.length,0);assert.equal(textarea.value,'保留草稿');}
  finally{release();globalThis.fetch=oldFetch;}
});

test('failed cleanup after pre-submit Stop keeps the durable blocker and draft',async()=>{
  const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='保留草稿';
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let writing=false,posts=0,stops=0;const markers:any[]=[];
  plugin.workStore.setPending=async(value:any)=>{writing=true;await gate;markers.push(value);};
  plugin.workStore.clearPending=async()=>{throw new Error('clear failed');};
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{
    if(String(url).endsWith('/chats/local-1'))return Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:null,installId:'install-1'}});
    if(String(url).endsWith('/chat/stream'))posts++;
    if(String(url).endsWith('/stop'))stops++;
    throw new Error('unexpected side effect');
  };
  try{const sending=plugin.send(root);for(let i=0;i<20&&!writing;i++)await tick();await plugin.stopCurrentRun(root);release();await sending;assert.equal(posts,0);assert.equal(stops,0);assert.equal(markers.length,1);assert.equal(textarea.value,'保留草稿');assert.match(root.querySelector('[data-status]')!.textContent||'',/未决|阻塞|核对/);}
  finally{release();globalThis.fetch=oldFetch;}
});

test('Stop after stream POST crosses the submit boundary uses Bridge ownership result',async()=>{
  const {plugin,root}=pluginHarness();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;textarea.value='问题';let posts=0,stops=0,reads=0;let stream!:ReadableStreamDefaultController<Uint8Array>;
  const oldFetch=globalThis.fetch;globalThis.fetch=async(url:any)=>{
    if(String(url).endsWith('/chats/local-1'))return Response.json({chat:{chatId:'local-1',connectionId:'serve-local',kind:'serve',profile:'default',documentRootId:ROOT,title:'新对话',state:'pending',storedSessionId:++reads===1?null:'stored-1',installId:'install-1'}});
    if(String(url).endsWith('/chat/stream')){posts++;return new Response(new ReadableStream<Uint8Array>({start(c){stream=c;}}),{status:200});}
    if(String(url).endsWith('/stop')){stops++;return Response.json({state:'unknown'});}
    throw new Error('unexpected');
  };
  try{const sending=plugin.send(root);for(let i=0;i<20&&posts===0;i++)await tick();assert.equal(posts,1);await plugin.stopCurrentRun(root);assert.equal(stops,1);assert.equal(textarea.value,'问题');stream.enqueue(new TextEncoder().encode('event: run.queued\ndata: {}\n\n'));stream.close();await sending;}
  finally{globalThis.fetch=oldFetch;}
});
