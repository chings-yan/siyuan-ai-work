import test from 'node:test';
import {studioProjectionFixture,partialStudioBinding,PROJECTION_CAP} from './studio-projection-fixture.ts';
import assert from 'node:assert/strict';
import {fixture,link,W,D} from './shared-ui-fixture.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

async function associationFixture(){
 const f=await fixture(),originalFetch=globalThis.fetch;
 const requests:{path:string;body:any}[]=[];
 let recovery:any[]=[],meta:any=undefined;
 let beforeReadback=async()=>{};
 let list=async()=>Response.json({data:[{id:'same-remote',title:'虚构已有对话'}]});
 let bind=async(body:any)=>Response.json({chat:{chatId:body.chat_id,connectionId:body.connection_id,storedSessionId:body.stored_session_id,title:body.title,documentRootId:W,kind:'serve',profile:'default',installId:'fictional-install',state:'ready'}});
 globalThis.fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname,body=init?.body?JSON.parse(String(init.body)):null;
  requests.push({path,body});
  if(path==='/connections')return Response.json({data:f.p.connectionViews,meta});
  if(path==='/chats'){await beforeReadback();assert.equal(new URL(String(url)).search,'?connection_id=serve-local');return Response.json({data:recovery});}
  if(path==='/connections/serve-local/sessions')return list();
  if(path==='/chats/bind')return bind(body);
  if(/^\/chats\/[^/]+\/messages$/.test(path))return Response.json({data:[{role:'assistant',content:'虚构原 Chat 历史'}]});
  assert.fail(`Unexpected request: ${path}`);
 };
 return {...f,requests,setReadback:(value:typeof beforeReadback)=>beforeReadback=value,setRecovery:(rows:any[])=>recovery=rows,async shared(value:any={schemaVersion:1,bridgeVersion:null,capabilities:['hermes-shared-session-v1']}){meta=value;await f.p.syncHermesSessions();},setList:(next:typeof list)=>list=next,setBind:(next:typeof bind)=>bind=next,
  async picker(){await f.p.associateStudio(f.root);return select(f);},
  close(){globalThis.fetch=originalFetch;f.close();}};
}
function select(f:Awaited<ReturnType<typeof fixture>>){
 const picker=f.root.querySelector<HTMLElement>('.sac-studio-picker')!;assert.ok(picker);
 picker.querySelector<HTMLInputElement>('[data-studio-options] input')!.dispatchEvent(new f.dom.window.Event('change'));
 const confirm=picker.querySelector<HTMLButtonElement>('[data-studio-confirm]')!;
 return {picker,confirm,confirmNow:()=> (confirm.onclick as any)() as Promise<void>};
}
function feedback(picker:HTMLElement,pattern:RegExp){
 const region=picker.querySelector<HTMLElement>('[data-studio-feedback]');assert.ok(region,'the open picker must contain its result');
 assert.equal(region.hidden,false);assert.match(region.textContent||'',pattern);
 assert.ok(['status','alert'].includes(region.getAttribute('role')||''),'feedback must be accessible');
 return region;
}
function unchanged(f:Awaited<ReturnType<typeof associationFixture>>){
 assert.equal(f.p.activeThreadId,f.chat);assert.equal(f.input.value,'原 Chat 草稿');
 assert.equal(f.requests.filter(x=>x.path.endsWith('/messages')).length,0);
}

// A ready duplicate must complete visibly without issuing another binding or activating it.
test('confirming an already ready association closes the picker and offers the original Chat',async()=>{
 const f=await associationFixture();try{
  await f.p.workStore.linkChat(link('fictional-original-chat'));const before=await f.p.workStore.listChats(W);
  const {confirmNow}=await f.picker();await confirmNow();
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);
  assert.deepEqual(await f.p.workStore.listChats(W),before);unchanged(f);
  assert.equal(f.root.querySelector('.sac-studio-picker'),null);
  const open=f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!;
  assert.equal(open.hidden,false);assert.equal(open.dataset.chatId,'fictional-original-chat');assert.equal(open.dataset.workId,W);
  assert.match(f.root.querySelector('[data-status]')!.textContent||'',/已关联|已完成/);
  assert.doesNotMatch(f.root.querySelector('[data-status]')!.textContent||'',/fictional-original-chat|Chat ID|分配/);
 }finally{f.close();}
});

for(const source of ['formal','pending'] as const)test(`existing unknown ${source} remains visible inside its picker without rebinding`,async()=>{
 const f=await associationFixture();try{
  if(source==='formal')await f.p.workStore.linkChat({...link('fictional-unknown-chat'),state:'unknown'});
  else await f.p.workStore.setPending({id:'chat:fictional-unknown-chat',kind:'chat',workId:W,state:'unknown',details:`connectionId=serve-local documentRootId=${W} storedSessionId=same-remote`,updatedAt:'2026-11-05T00:00:00Z'});
  const before={links:await f.p.workStore.listChats(W),pending:await f.p.workStore.listPending()};
  const {picker,confirm,confirmNow}=await f.picker();await confirmNow();
  assert.equal(picker.isConnected,true);feedback(picker,/核对.*勿重复关联/);assert.doesNotMatch(picker.querySelector('[data-studio-feedback]')!.textContent||'',/fictional-unknown-chat|Chat ID|分配/);assert.equal(confirm.disabled,false);
  assert.deepEqual({links:await f.p.workStore.listChats(W),pending:await f.p.workStore.listPending()},before);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);unchanged(f);
 }finally{f.close();}
});

test('precheck failure is readable inside the retained picker and does not bind',async()=>{
 const f=await associationFixture();try{
  const {picker,confirm,confirmNow}=await f.picker();
  f.p.workStore.listChats=async()=>{throw Error('虚构正式关系读取失败');};await confirmNow();
  assert.equal(picker.isConnected,true);feedback(picker,/检查失败.*虚构正式关系读取失败/);assert.equal(confirm.disabled,false);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);unchanged(f);
 }finally{f.close();}
});

test('an explicit Bridge refusal is readable inside the retained picker without unknown persistence',async()=>{
 const f=await associationFixture();try{
  f.setBind(async()=>Response.json({error:{code:'auth_failed',message:'虚构明确拒绝'}},{status:403}));
  const {picker,confirm,confirmNow}=await f.picker();await confirmNow();
  assert.equal(picker.isConnected,true);feedback(picker,/认证失败.*核对连接凭证/);assert.equal(confirm.disabled,false);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,1);
  assert.deepEqual(await f.p.workStore.listChats(W),[]);assert.deepEqual(await f.p.workStore.listPending(),[]);unchanged(f);
 }finally{f.close();}
});

test('delayed double confirmation shows processing and sends exactly one binding',async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  f.setBind(async body=>{started.resolve();await finish.promise;return Response.json({chat:{chatId:body.chat_id,connectionId:'serve-local',storedSessionId:'same-remote',title:'虚构已有对话',documentRootId:W,kind:'serve',profile:'default',installId:'fictional-install',state:'ready'}});});
  const {picker,confirm,confirmNow}=await f.picker();const first=confirmNow();await started.promise;await confirmNow();
  feedback(picker,/正在|处理中/);assert.equal(confirm.disabled,true);assert.equal(picker.querySelector<HTMLButtonElement>('[data-studio-cancel]')!.disabled,true);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,1);
  finish.resolve();await first;
  assert.equal(picker.isConnected,false);assert.equal((await f.p.workStore.listChats(W)).length,1);unchanged(f);
 }finally{finish.resolve();f.close();}
});

test('unknown binding outcome still closes and persists one unknown relation without changing Chat',async()=>{
 const f=await associationFixture();try{
  f.setBind(async()=>{throw Error('虚构回执丢失');});
  const {picker,confirmNow}=await f.picker();await confirmNow();await confirmNow();
  assert.equal(picker.isConnected,false);const saved=await f.p.workStore.listChats(W);
  assert.equal(saved.length,1);assert.equal(saved[0].state,'unknown');assert.equal(saved[0].storedSessionId,'same-remote');
  assert.match(f.root.querySelector('[data-status]')!.textContent||'',/核对/);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,1);unchanged(f);
 }finally{f.close();}
});

test('changing document after candidates appear closes only the stale picker without binding',async()=>{
 const f=await associationFixture();try{
  const {picker,confirmNow}=await f.picker();f.setDocument(D);await confirmNow();
  assert.equal(picker.isConnected,false);assert.equal(f.p.associationOpen,false);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);assert.deepEqual(await f.p.workStore.listChats(W),[]);unchanged(f);
 }finally{f.close();}
});

for(const outcome of ['ready','precheck-error','scope-error'] as const)test(`late ${outcome} callback cannot affect a replacement picker`,async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  if(outcome==='ready')await f.p.workStore.linkChat(link('fictional-original-chat'));
  const old=await f.picker();
  const original=outcome==='scope-error'?f.p.workService.readWork.bind(f.p.workService):f.p.workStore.listChats.bind(f.p.workStore);
  const delayed=async(...args:any[])=>{started.resolve();await finish.promise;if(outcome!=='ready')throw Error('虚构迟到失败');return original(...args);};
  if(outcome==='scope-error')f.p.workService.readWork=delayed;else f.p.workStore.listChats=delayed;
  const pending=old.confirmNow();await started.promise;
  if(outcome==='scope-error')f.p.workService.readWork=original;else f.p.workStore.listChats=original;
  f.p.invalidateAssociationFor(f.root);const replacement=await f.picker();
  f.p.setStatus(f.root,'新窗口独立状态');finish.resolve();await pending;await old.confirmNow();
  assert.equal(f.root.querySelector('.sac-studio-picker'),replacement.picker);assert.equal(f.p.associationOpen,true);
  assert.equal(f.root.querySelector('[data-status]')!.textContent,'新窗口独立状态');
  assert.equal(f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.hidden,true);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);unchanged(f);
 }finally{finish.resolve();f.close();}
});

test('late candidate listing cannot close a replacement picker on the same root',async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  f.setList(async()=>{started.resolve();await finish.promise;return Response.json({data:[{id:'same-remote'}]});});
  const loading=f.p.associateStudio(f.root);await started.promise;
  f.p.invalidateAssociationFor(f.root);f.setList(async()=>Response.json({data:[{id:'same-remote',title:'新窗口候选'}]}));
  const replacement=await f.picker();finish.resolve();await loading;
  assert.equal(f.root.querySelector('.sac-studio-picker'),replacement.picker);assert.equal(f.p.associationOpen,true);unchanged(f);
 }finally{finish.resolve();f.close();}
});

for(const replacement of [false,true])test(`late candidate failure closes only its stale picker with replacement=${replacement}`,async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  f.setList(async()=>{started.resolve();await finish.promise;throw Error('虚构迟到候选读取失败');});
  const loading=f.p.associateStudio(f.root);await started.promise;
  const old=f.root.querySelector('.sac-studio-picker');f.setDocument(D);
  let next:HTMLElement|null=null;
  if(replacement){f.p.invalidateAssociationFor(f.root);f.setDocument(W);f.setList(async()=>Response.json({data:[{id:'same-remote'}]}));next=(await f.picker()).picker;}
  f.p.setStatus(f.root,'新场景独立状态');finish.resolve();await loading;
  assert.equal(old?.isConnected,false);assert.equal(f.root.querySelector('.sac-studio-picker'),next);
  assert.equal(f.p.associationOpen,replacement);assert.equal(f.root.querySelector('[data-status]')!.textContent,'新场景独立状态');unchanged(f);
 }finally{finish.resolve();f.close();}
});

test('explicit open loads the exact saved ready Chat when it is absent from the current threads',async()=>{
 const f=await associationFixture();try{
  const original=link('fictional-original-chat');await f.p.workStore.linkChat(original);
  assert.equal(f.p.threads.some((thread:any)=>thread.id===original.chatId),false);
  const {confirmNow}=await f.picker();await confirmNow();unchanged(f);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);assert.deepEqual(await f.p.workStore.listChats(W),[original]);
  const open=f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!;await (open.onclick as any)();
  assert.equal(f.p.activeThreadId,'fictional-original-chat');
  assert.deepEqual(f.requests.filter(x=>x.path.endsWith('/messages')).map(x=>x.path),['/chats/fictional-original-chat/messages']);
  assert.match(f.root.querySelector('[data-messages]')!.textContent||'',/虚构原 Chat 历史/);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);assert.deepEqual(await f.p.workStore.listChats(W),[original]);
  const loaded=f.p.threads.find((thread:any)=>thread.id===original.chatId);
  assert.equal(loaded.connectionId,'serve-local');assert.equal(loaded.profile,'default');assert.equal(loaded.installId,'fictional-install');assert.equal(loaded.storedSessionId,'same-remote');
 }finally{f.close();}
});

for(const busy of ['send','proposal'] as const)test(`explicit open keeps the original draft and Chat while ${busy} is active`,async()=>{
 const f=await associationFixture();try{
  await f.p.workStore.linkChat(link('fictional-original-chat'));const {confirmNow}=await f.picker();await confirmNow();
  if(busy==='send')f.p.sendInFlight=true;else f.p.pendingProposal={id:'fictional-proposal'};
  await (f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.onclick as any)();
  unchanged(f);assert.equal(f.p.threads.some((thread:any)=>thread.id==='fictional-original-chat'),false);
  assert.match(f.root.querySelector('[data-status]')!.textContent||'',/处理|生成|建议/);
 }finally{f.p.sendInFlight=false;f.p.pendingProposal=undefined;f.close();}
});

for(const change of ['document','bridge','view','busy'] as const)test(`explicit open ignores a formal link read completed after ${change} changes`,async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  await f.p.workStore.linkChat(link('fictional-original-chat'));const {confirmNow}=await f.picker();await confirmNow();
  const original=f.p.workStore.chatLink.bind(f.p.workStore);
  f.p.workStore.chatLink=async(id:string)=>{const result=await original(id);started.resolve();await finish.promise;return result;};
  const opening=(f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.onclick as any)() as Promise<void>;
  await Promise.race([started.promise,opening.then(()=>assert.fail('explicit open must re-read its saved formal link'))]);
  if(change==='document')f.setDocument(D);else if(change==='bridge')f.p.bridgeToken='fictional-replacement-token';else if(change==='view')f.p.render(f.root);else f.p.sendInFlight=true;
  f.p.setStatus(f.root,'新场景独立状态');finish.resolve();await opening;
  unchanged(f);assert.equal(f.p.threads.some((thread:any)=>thread.id==='fictional-original-chat'),false);
  assert.equal(f.root.querySelector('[data-status]')!.textContent,'新场景独立状态');
 }finally{finish.resolve();f.p.sendInFlight=false;f.close();}
});

for(const [field,value] of [['state','unknown'],['profile','fictional-other-profile'],['installId','fictional-other-install'],['storedSessionId','fictional-other-remote'],['documentRootId',D],['connectionId','fictional-other-connection'],['workId',D]])test(`explicit open rejects changed formal link ${field}`,async()=>{
 const f=await associationFixture();try{
  const original=link('fictional-original-chat');await f.p.workStore.linkChat(original);const {confirmNow}=await f.picker();await confirmNow();
  // Simulate an external reload in the fixture's in-memory storage; keep real Store validation.
  await f.p.workStore.registerWork(D);const formal=await f.p.loadData('work-formal-v2');
  await f.p.saveData('work-formal-v2',{...formal,chats:[{...original,[field]:value}]});
  await (f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.onclick as any)();
  unchanged(f);assert.equal(f.p.threads.some((thread:any)=>thread.id===original.chatId),false);
  assert.match(f.root.querySelector('[data-status]')!.textContent||'',/核对|变化|待确认/);
  assert.equal((await f.p.workStore.chatLink(original.chatId))[field],value);
 }finally{f.close();}
});

for(const returnToInitial of [false,true])test(`late explicit open preserves a newer Chat selection with returnToInitial=${returnToInitial}`,async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  await f.p.workStore.linkChat(link('fictional-original-chat'));
  const newer=link('fictional-newer-chat','fictional-newer-remote');await f.p.workStore.linkChat(newer);
  f.p.threads.push(f.p.threadFromLink(newer));
  const {confirmNow}=await f.picker();await confirmNow();
  const original=f.p.workStore.chatLink.bind(f.p.workStore);
  f.p.workStore.chatLink=async(id:string)=>{const result=await original(id);if(id==='fictional-original-chat'){started.resolve();await finish.promise;}return result;};
  const opening=(f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.onclick as any)() as Promise<void>;
  await started.promise;const navigation=f.p.workController.navigationVersion;
  await f.p.selectChat(f.root,'fictional-newer-chat','serve-local');
  if(returnToInitial)await f.p.selectChat(f.root,f.chat);
  assert.equal(f.p.workController.navigationVersion,navigation,'Chat selection must invalidate the old read without document navigation');
  const selected=returnToInitial?f.chat:'fictional-newer-chat',history=f.p.historyVersion;
  f.input.value='较新选择的草稿';f.input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  f.p.setStatus(f.root,'较新选择的独立状态');const requests=f.requests.length;
  finish.resolve();await opening;
  assert.equal(f.p.activeThreadId,selected);assert.equal(f.p.historyVersion,history);
  assert.equal(f.input.value,'较新选择的草稿');assert.equal(f.root.querySelector('[data-status]')!.textContent,'较新选择的独立状态');
  assert.equal(f.p.threads.some((thread:any)=>thread.id==='fictional-original-chat'),false);
  assert.deepEqual(f.requests.slice(requests),[],'the stale action must not read its original Chat history');
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);
 }finally{finish.resolve();f.close();}
});

test('explicit open adopts only its own completed Work navigation before the second formal read',async()=>{
 const f=await associationFixture();try{
  await f.p.workStore.registerWork(D);const target={...link('fictional-target-work-chat'),workId:D,documentRootId:D};await f.p.workStore.linkChat(target);
  // Replace only the native host opening boundary; keep the real WorkController navigation and source bundle.
  f.p.workController.options.openDocument=async(id:string)=>{assert.equal(id,D);f.setDocument(id);};
  await f.p.associateStudio(f.root,D);await select(f).confirmNow();
  const selected=f.p.activeThreadId;assert.equal(f.p.workController.currentWorkId,W);
  const reads:string[]=[];const original=f.p.workStore.chatLink.bind(f.p.workStore);
  f.p.workStore.chatLink=async(id:string)=>{reads.push(id);return original(id);};
  await (f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.onclick as any)();
  assert.notEqual(f.p.activeThreadId,selected);assert.equal(f.p.activeThreadId,'fictional-target-work-chat');
  assert.equal(f.p.workController.currentWorkId,D);assert.equal(f.p.currentDocumentId(),D);
  assert.deepEqual(reads,['fictional-target-work-chat','fictional-target-work-chat']);
  assert.deepEqual(f.requests.filter(x=>x.path.endsWith('/messages')).map(x=>x.path),['/chats/fictional-target-work-chat/messages','/chats/fictional-target-work-chat/messages']);
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,0);assert.deepEqual(await f.p.workStore.chatLink(target.chatId),target);
 }finally{f.close();}
});

function chooseCandidate(f:Awaited<ReturnType<typeof associationFixture>>,picker:HTMLElement,id:string){
 const input=[...picker.querySelectorAll<HTMLInputElement>('[data-studio-options] input')].find(input=>input.value===id)!;
 assert.ok(input);input.checked=true;input.dispatchEvent(new f.dom.window.Event('change'));
}
for(const [code,reason] of [['session_claimed',/该会话已有其他关联/],['chat_conflict',/Chat 标识.*绑定/],['connection_changed',/连接配置已变化/],['install_changed',/安装身份已变化/],[undefined,/HTTP 409/]] as const)test(`409 ${code} keeps safe feedback and blocks only its candidate through search redraw`,async()=>{
 const f=await associationFixture();try{
  f.setList(async()=>Response.json({data:[{id:'same-remote',title:'虚构已有对话'},{id:'other-remote',title:'其他候选'}]}));
  f.setBind(async()=>Response.json({error:{code,message:'<b>fictional-private-upstream</b>',documentRootId:D}},{status:409}));
  const {picker,confirm,confirmNow}=await f.picker();await confirmNow();
  const region=feedback(picker,reason);assert.doesNotMatch(region.textContent||'',/属于其他文档|未写入|可安全重试|fictional-private-upstream/);
  const diagnostic=picker.querySelector<HTMLDetailsElement>('[data-studio-diagnostic]')!;assert.ok(diagnostic);assert.equal(diagnostic.open,false);
  assert.match(diagnostic.textContent||'',/HTTP 409/);if(code)assert.match(diagnostic.textContent||'',new RegExp(code));
  assert.doesNotMatch(diagnostic.textContent||'',/same-remote|serve-local|fictional-private-upstream|default|20261008/);
  assert.equal(confirm.disabled,true);assert.equal(picker.querySelector<HTMLButtonElement>('[data-studio-cancel]')!.disabled,false);
  await confirmNow();
  chooseCandidate(f,picker,'other-remote');assert.equal(confirm.disabled,false);
  const search=picker.querySelector<HTMLInputElement>('[data-studio-search]')!;search.value='虚构';search.dispatchEvent(new f.dom.window.Event('input'));
  chooseCandidate(f,picker,'same-remote');assert.equal(confirm.disabled,true);feedback(picker,reason);await confirmNow();
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,1);
  assert.deepEqual(await f.p.workStore.listChats(W),[]);assert.deepEqual(await f.p.workStore.listPending(),[]);unchanged(f);
  picker.querySelector<HTMLButtonElement>('[data-studio-cancel]')!.click();assert.equal(picker.isConnected,false);
 }finally{f.close();}
});
for(const code of ['constructor','__proto__','toString','<img src=x onerror=secret()>','unrecognized-private-code'])test(`untrusted conflict code ${code} cannot enter feedback or diagnostic`,async()=>{
 const f=await associationFixture();try{
  f.setBind(async()=>Response.json({error:{code,message:'secret-upstream-body'}},{status:409}));
  const {picker,confirmNow}=await f.picker();await confirmNow();
  feedback(picker,/HTTP 409/);const diagnostic=picker.querySelector('[data-studio-diagnostic]')!;assert.ok(diagnostic);
  assert.doesNotMatch(picker.querySelector('[data-studio-feedback]')!.textContent||'',new RegExp(code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.equal(diagnostic.textContent,'诊断信息HTTP 409');assert.doesNotMatch(picker.textContent||'',/secret-upstream-body/);unchanged(f);
 }finally{f.close();}
});
for(const phase of ['precheck','request'] as const)test(`candidate is frozen across ${phase} awaits and late 409 does not lock the new choice`,async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  f.setList(async()=>Response.json({data:[{id:'same-remote',title:'虚构已有对话'},{id:'other-remote',title:'其他候选'}]}));
  if(phase==='precheck'){
   const original=f.p.workStore.listChats.bind(f.p.workStore);let held=false;
   f.p.workStore.listChats=async(...args:any[])=>{if(!held){held=true;started.resolve();await finish.promise;}return original(...args);};
  }
  f.setBind(async(body)=>{if(body.stored_session_id==='same-remote'){if(phase==='request'){started.resolve();await finish.promise;}return Response.json({error:{code:'session_claimed'}},{status:409});}return Response.json({error:{code:'auth_failed'}},{status:403});});
  const {picker,confirm,confirmNow}=await f.picker();const pending=confirmNow();await started.promise;
  chooseCandidate(f,picker,'other-remote');finish.resolve();await pending;
  assert.equal(f.requests.find(x=>x.path==='/chats/bind')?.body.stored_session_id,'same-remote');
  assert.equal(confirm.disabled,false);assert.doesNotMatch(picker.querySelector('[data-studio-feedback]')!.textContent||'',/该会话已有其他关联/);
  await confirmNow();assert.deepEqual(f.requests.filter(x=>x.path==='/chats/bind').map(x=>x.body.stored_session_id),['same-remote','other-remote']);
  chooseCandidate(f,picker,'same-remote');assert.equal(confirm.disabled,true);feedback(picker,/该会话已有其他关联/);await confirmNow();
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,2);unchanged(f);
 }finally{finish.resolve();f.close();}
});
for(const change of ['document','bridge','page'] as const)test(`late conflict cannot overwrite newer ${change} scene feedback or draft`,async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();let pageCurrent=true;try{
  f.setBind(async()=>{started.resolve();await finish.promise;return Response.json({error:{code:'session_claimed'}},{status:409});});
  await f.p.associateStudio(f.root,undefined,()=>pageCurrent);const {confirmNow}=select(f);const pending=confirmNow();await started.promise;
  if(change==='document')f.setDocument(D);else if(change==='bridge')f.p.bridgeToken='fictional-replacement-token';else pageCurrent=false;
  f.input.value='新场景草稿';f.p.setStatus(f.root,'新场景独立状态');finish.resolve();await pending;
  assert.equal(f.input.value,'新场景草稿');assert.equal(f.p.activeThreadId,f.chat);assert.equal(f.root.querySelector('[data-status]')!.textContent,'新场景独立状态');
  assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,1);assert.deepEqual(await f.p.workStore.listChats(W),[]);
 }finally{finish.resolve();f.close();}
});

for(const upstreamReason of ['同文档中其他 Chat 已占用','Studio 会话已属于其他文档'])test(`session_claimed does not infer ownership from upstream text: ${upstreamReason}`,async()=>{
 const f=await associationFixture();try{
  const original={...link('fictional-existing-chat'),storedSessionId:'fictional-existing-session'};await f.p.workStore.linkChat(original);
  f.setBind(async()=>Response.json({error:{code:'session_claimed',message:upstreamReason}},{status:409}));
  const {picker,confirmNow}=await f.picker();await confirmNow();feedback(picker,/该会话已有其他关联/);
  assert.doesNotMatch(picker.querySelector('[data-studio-feedback]')!.textContent||'',/属于其他文档|未写入|安全重试/);
  assert.deepEqual(await f.p.workStore.listChats(W),[original]);unchanged(f);
 }finally{f.close();}
});
for(const outcome of ['network','server'] as const)test(`late ${outcome} unknown persists the frozen candidate after selection changes`,async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  f.setList(async()=>Response.json({data:[{id:'same-remote',title:'虚构已有对话'},{id:'other-remote',title:'其他候选'}]}));
  f.setBind(async()=>{started.resolve();await finish.promise;if(outcome==='network')throw Error('fictional lost receipt');return Response.json({error:{code:'private-upstream',message:'private body'}},{status:503});});
  const {picker,confirmNow}=await f.picker();const pending=confirmNow();await started.promise;chooseCandidate(f,picker,'other-remote');finish.resolve();await pending;
  const links=await f.p.workStore.listChats(W);assert.equal(links.length,1);assert.equal(links[0].state,'unknown');assert.equal(links[0].storedSessionId,'same-remote');assert.equal(links[0].title,'虚构已有对话');
  assert.equal(picker.isConnected,false);assert.equal(f.requests.filter(x=>x.path==='/chats/bind').length,1);unchanged(f);
 }finally{finish.resolve();f.close();}
});

async function switchAssociationConnection(f:Awaited<ReturnType<typeof associationFixture>>,change:'selected'|'confirmed'|'settings'){
 if(change==='selected'){f.p.selectedConnectionId='studio-default';return;}
 if(change==='confirmed'){f.p.confirmedConnectionId='studio-default';return;}
 const priorFetch=globalThis.fetch,bridge=f.p.bridgeUrl,token=f.p.bridgeToken,generation=f.p.workLoadSeq;
 globalThis.fetch=async(url,init)=>{
  const path=new URL(String(url)).pathname;
  if(path==='/health')return Response.json({ok:true,service:'siyuan-ai-collab-bridge'});
  if(path==='/connections')return Response.json({data:[
   {id:'serve-local',kind:'serve',profile:'default',installId:'fictional-install',displayName:'虚构 Serve',state:'ready'},
   {id:'studio-default',kind:'studio',profile:'default',installId:null,displayName:'虚构 Studio',state:'ready'}
  ]});
  return priorFetch(url,init);
 };
 try{
  const result=await f.p.connectSettingsBridge({url:bridge,token:'',detect:false,connectionId:'studio-default'});
  assert.equal(result.saveOutcome,'saved');assert.equal(f.p.selectedConnectionId,'studio-default');assert.equal(f.p.confirmedConnectionId,'studio-default');
  assert.equal(f.p.bridgeUrl,bridge);assert.equal(f.p.bridgeToken,token);assert.equal(f.p.workLoadSeq,generation);
 }finally{globalThis.fetch=priorFetch;}
}
for(const change of ['selected','confirmed','settings'] as const)for(const outcome of ['precheck','conflict','ready','unknown'] as const)test(`same-Bridge connection identity ${change} invalidates late ${outcome} association UI`,async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{
  const {picker,confirmNow}=await f.picker(),originalThreads=f.p.threads.map((thread:any)=>thread.id);
  if(outcome==='precheck'){
   const original=f.p.workStore.listChats.bind(f.p.workStore);let held=false;
   f.p.workStore.listChats=async(...args:any[])=>{if(!held){held=true;started.resolve();await finish.promise;}return original(...args);};
  }
  f.setBind(async(body)=>{
   if(outcome!=='precheck'){started.resolve();await finish.promise;}
   if(outcome==='conflict')return Response.json({error:{code:'session_claimed'}},{status:409});
   if(outcome==='unknown')throw Error('fictional lost receipt');
   return Response.json({chat:{chatId:body.chat_id,connectionId:body.connection_id,storedSessionId:body.stored_session_id,title:body.title,documentRootId:W,kind:'serve',profile:'default',installId:'fictional-install',state:'ready'}});
  });
  const pending=confirmNow();await started.promise;await switchAssociationConnection(f,change);
  f.input.value='新连接场景草稿';f.input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));f.p.setStatus(f.root,'新连接场景独立状态');
  finish.resolve();await pending;
  assert.equal(f.root.querySelector('[data-status]')!.textContent,'新连接场景独立状态');assert.equal(f.input.value,'新连接场景草稿');assert.equal(f.p.activeThreadId,f.chat);
  assert.deepEqual(f.p.threads.map((thread:any)=>thread.id),originalThreads,'an old result must not add a thread to the new connection view');
  assert.equal(picker.isConnected,false);assert.equal(f.p.associationOpen,false);assert.equal(f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.hidden,true);
  const binds=f.requests.filter(request=>request.path==='/chats/bind'),links=await f.p.workStore.listChats(W);
  assert.equal(binds.length,outcome==='precheck'?0:1);assert.equal(f.requests.filter(request=>request.path.endsWith('/messages')).length,0);
  if(outcome==='ready'||outcome==='unknown'){
   assert.equal(links.length,1);assert.equal(links[0].chatId,binds[0].body.chat_id);assert.equal(links[0].state,outcome==='ready'?'ready':'unknown');
   assert.equal(links[0].connectionId,'serve-local');assert.equal(links[0].storedSessionId,'same-remote');assert.equal(links[0].installId,'fictional-install');
  }else assert.deepEqual(links,[]);
 }finally{finish.resolve();f.close();}
});

function recovered(overrides:any={}){return {chatId:'bridge-original',connectionId:'serve-local',kind:'serve',profile:'default',installId:'fictional-install',storedSessionId:'same-remote',documentRootId:W,title:'Recovered',state:'ready',...overrides};}
test('shared same-root read-only recovery saves exact original Chat and offers explicit open without POST',async()=>{
 const f=await associationFixture();try{await f.shared();f.setRecovery([recovered()]);await f.p.workStore.registerWork(D);
 const originalResume={workId:W,documentId:W,focusBlockId:null,chatId:f.chat,taskId:null,updatedAt:'2026-11-06T00:00:00Z'},otherResume={...originalResume,workId:D,documentId:D,chatId:'other-work-chat'};await f.p.workStore.saveResume(originalResume);await f.p.workStore.saveResume(otherResume);const beforeResume=structuredClone(await f.p.loadData('work-resume-v1'));
 const {picker,confirmNow}=await f.picker();assert.match(picker.textContent||'',/多篇文档将共用这段对话历史/);await confirmNow();
 assert.equal(f.requests.filter(r=>r.path==='/chats/bind').length,0);assert.equal((await f.p.workStore.listChats(W))[0].chatId,'bridge-original');unchanged(f);const open=f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!;assert.equal(open.dataset.chatId,'bridge-original');assert.deepEqual(await f.p.loadData('work-resume-v1'),beforeResume,'read-only recovery preserves Work-keyed Resume exactly');
 await (open.onclick as any)();await f.p.workController.flushResume();const afterResume=await f.p.workStore.getResume(W);assert.equal(afterResume.workId,W);assert.equal(afterResume.documentId,W);assert.equal(afterResume.chatId,'bridge-original');assert.deepEqual(await f.p.workStore.getResume(D),otherResume);assert.equal((await f.p.loadData('work-resume-v1')).schema,1);assert.deepEqual(Object.keys((await f.p.loadData('work-resume-v1')).items).sort(),[D,W].sort());
 }finally{f.close();}
});
for(const field of ['profile','installId','kind'])test('local precheck includes exact identity '+field,async()=>{
 const f=await associationFixture();try{await f.p.workStore.linkChat({...link('foreign-local'),[field==='kind'?'adapter':field]:field==='kind'?'studio':'other'} as any);const {confirmNow}=await f.picker();await confirmNow();assert.equal(f.requests.filter(r=>r.path==='/chats/bind').length,1);unchanged(f);}finally{f.close();}
});
for(const overrides of [{documentRootId:D},{profile:'other'},{installId:'other'},{kind:'studio'},{state:'unknown'}])test('shared recovery refuses foreign identity or unknown '+JSON.stringify(overrides),async()=>{
 const f=await associationFixture();try{await f.shared();f.setRecovery([recovered(overrides)]);const {confirmNow}=await f.picker();await confirmNow();assert.ok(!(await f.p.workStore.listChats(W)).some((r:any)=>r.chatId==='bridge-original'));unchanged(f);}finally{f.close();}
});
for(const meta of [undefined,{schemaVersion:2,bridgeVersion:'99.0.0',capabilities:['hermes-shared-session-v1']},{schemaVersion:1,bridgeVersion:'99.0.0',capabilities:[]}])test('old or invalid capability keeps original association path '+JSON.stringify(meta),async()=>{
 const f=await associationFixture();try{await f.shared(meta===undefined?null:meta);f.setRecovery([recovered()]);const {picker,confirmNow}=await f.picker();assert.doesNotMatch(picker.textContent||'',/多篇文档将共用/);await confirmNow();assert.equal(f.requests.filter(r=>r.path==='/chats').length,0);assert.equal(f.requests.filter(r=>r.path==='/chats/bind').length,1);}finally{f.close();}
});
test('duplicate refusal performs one same-root readback and offers concurrent winner without another POST',async()=>{
 const f=await associationFixture();try{await f.shared();f.setBind(async()=>{f.setRecovery([recovered()]);return Response.json({error:{code:'session_claimed'}},{status:409});});const {confirmNow}=await f.picker();await confirmNow();assert.equal(f.requests.filter(r=>r.path==='/chats/bind').length,1);assert.equal((await f.p.workStore.listChats(W))[0].chatId,'bridge-original');unchanged(f);}finally{f.close();}
});
test('pending local save blocks shared readback recovery without clearing evidence',async()=>{
 const f=await associationFixture();try{await f.shared();f.setRecovery([recovered()]);await f.p.workStore.setPending({id:'chat:lost',kind:'chat',workId:W,state:'unknown',details:`connectionId=serve-local documentRootId=${W} storedSessionId=same-remote`,updatedAt:'2026-11-06T00:00:00Z'});const {picker,confirmNow}=await f.picker();await confirmNow();feedback(picker,/核对.*勿重复关联/);assert.doesNotMatch(picker.querySelector('[data-studio-feedback]')!.textContent||'',/lost|Chat ID|分配/);assert.equal((await f.p.workStore.listPending())[0].id,'chat:lost');assert.equal((await f.p.workStore.listChats(W)).length,0);assert.equal(f.requests.filter(r=>r.path==='/chats').length,0);}finally{f.close();}
});

test('shared repeated duplicate without precise winner stays blocked and never retries POST',async()=>{
 const f=await associationFixture();try{await f.shared();f.setBind(async()=>Response.json({error:{code:'session_claimed'}},{status:409}));const {picker,confirm,confirmNow}=await f.picker();await confirmNow();await confirmNow();assert.equal(f.requests.filter(r=>r.path==='/chats/bind').length,1);assert.equal(confirm.disabled,true);feedback(picker,/核对/);assert.deepEqual(await f.p.workStore.listChats(W),[]);}finally{f.close();}
});
test('late shared readback cannot save or publish a recovered ready relation into a new scene',async()=>{
 const f=await associationFixture(),started=deferred(),finish=deferred();try{await f.shared();f.setRecovery([recovered()]);f.setReadback(async()=>{started.resolve();await finish.promise;});const {confirmNow}=await f.picker();const confirming=confirmNow();await started.promise;f.setDocument(D);f.p.setStatus(f.root,'新场景原提示');finish.resolve();await confirming;assert.deepEqual(await f.p.workStore.listChats(W),[]);assert.equal(f.root.querySelector('[data-status]')!.textContent,'新场景原提示');assert.equal(f.requests.filter(r=>r.path==='/chats/bind').length,0);}finally{finish.resolve();f.close();}
});

test('failed duplicate readback never fabricates an unknown binding for the rejected requested ID',async()=>{
 const f=await associationFixture();try{await f.shared();f.setBind(async()=>{f.setReadback(async()=>{throw Error('synthetic readback offline');});return Response.json({error:{code:'session_claimed'}},{status:409});});const {picker,confirm,confirmNow}=await f.picker();await confirmNow();assert.deepEqual(await f.p.workStore.listChats(W),[]);assert.equal(picker.isConnected,true);assert.equal(confirm.disabled,true);feedback(picker,/核对/);assert.equal(f.requests.filter(r=>r.path==='/chats/bind').length,1);}finally{f.close();}
});

for(const mode of ['conflict','missing'] as const)test(`actual Studio ${mode} partial bind cannot be adopted by the subsequent component recovery`,async t=>{
 const f=await fixture(),remote=await studioProjectionFixture(W);try{
  const before=await partialStudioBinding(remote,mode,t.mock);await f.p.workStore.registerWork(D);
  const resumes=[{workId:W,documentId:W,focusBlockId:null,chatId:f.chat,taskId:null,updatedAt:'2026-11-06T00:00:00Z'},{workId:D,documentId:D,focusBlockId:null,chatId:'other-work-chat',taskId:null,updatedAt:'2026-11-06T01:00:00Z'}];for(const item of resumes)await f.p.workStore.saveResume(item);
  const savedResume=structuredClone(await f.p.loadData('work-resume-v1'));
  f.p.bridgeUrl=remote.base;f.p.bridgeToken=PROJECTION_CAP;f.p.connectionViews=[{id:'studio-default',kind:'studio',profile:'default',installId:null,displayName:'Synthetic Studio',state:'ready'}];f.p.selectedConnectionId='studio-default';f.p.confirmedConnectionId='studio-default';await f.p.syncHermesSessions();
  await f.p.associateStudio(f.root);const {picker,confirmNow}=select(f);await confirmNow();
  assert.deepEqual(await f.p.workStore.listChats(W),[]);assert.equal(f.p.activeThreadId,f.chat);assert.equal(f.input.value,'原 Chat 草稿');assert.equal(f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.hidden,true);assert.notEqual(f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.dataset.chatId,'requested');assert.equal(picker.isConnected,true);feedback(picker,/核对/);assert.equal(remote.calls.filter(c=>c.method==='POST').length,1,'readback must neither retry the failed bind nor allocate another ID');assert.deepEqual(await remote.snapshot(),before);assert.deepEqual(await f.p.loadData('work-resume-v1'),savedResume,'read-only recovery must preserve original Work-keyed Resume');assert.deepEqual((await f.p.workStore.listResume()).map((r:any)=>r.workId).sort(),[D,W].sort());
 }finally{f.close();await remote.close();}
});
