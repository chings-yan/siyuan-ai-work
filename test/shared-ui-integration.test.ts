import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,link,W,tick} from './shared-ui-fixture.ts';
test('shared settings preserve explicit connection choice with new shell',async()=>{
 const f=await fixture();try{f.p.confirmedConnectionId='serve-local';f.p.openSettings(f.root,'hermes');const select=f.doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]');assert.ok(select);assert.equal(select.value,'serve-local');assert.equal(f.root.querySelector('[data-connection-choice]'),null);}finally{f.close();}
});
test('shared drafts and remote history stay isolated across local UUID and formal connection',async()=>{
 const f=await fixture();try{const a=link('local-a'),b={...link('local-b','same-remote','serve-other'),profile:'other',installId:'other-install'};await f.p.workStore.linkChat(a);await f.p.workStore.linkChat(b);f.p.threads=[f.p.threadFromLink(a),f.p.threadFromLink(b)];f.p.activeThreadId=a.chatId;f.p.activateDraft();f.p.loadThreadMessages=async()=>{};
 f.input.value='draft a';f.input.dispatchEvent(new f.dom.window.Event('input'));await f.p.selectChat(f.root,b.chatId);assert.equal(f.input.value,'');f.input.value='draft b';f.input.dispatchEvent(new f.dom.window.Event('input'));await f.p.selectChat(f.root,a.chatId);assert.equal(f.input.value,'draft a');assert.equal(f.p.threads[0].storedSessionId,'same-remote');assert.notEqual(f.p.threads[0].id,f.p.threads[0].storedSessionId);
 }finally{f.close();}
});
test('shared durable unknown survives manual review reconnect and EKKO hidden controls',async()=>{
 const f=await fixture();try{const a=link('durable-local');await f.p.workStore.linkChat(a);f.p.threads=[f.p.threadFromLink(a)];f.p.activeThreadId=a.chatId;await f.p.workStore.setPending({id:'chat-run:'+a.chatId,kind:'chat',workId:W,state:'unknown',details:'queued fictional run',updatedAt:new Date().toISOString()});f.p.activateDraft();await f.p.restoreDurableNotice();f.p.updateConnectionUI(true);assert.match(f.root.querySelector('[data-status]')!.textContent||'',/queued fictional run/);f.root.querySelector<HTMLButtonElement>('[data-action="confirm-send-reviewed"]')!.click();assert.equal((await f.p.workStore.listPending()).length,1);const shell=f.root.querySelector<HTMLElement>('.sac')!;shell.dataset.surface='ekko';f.root.querySelector<HTMLButtonElement>('[data-action="confirm-send-reviewed"]')!.click();assert.equal((await f.p.workStore.listPending()).length,1);
 }finally{f.close();}
});

test('shared settings failure preserves saved identity unknown settings and runtime draft',async()=>{
 const f=await fixture();const original=globalThis.fetch;try{const before=f.p.bridgeUrl,token=f.p.bridgeToken;f.p.loadData=async()=>({bridgeUrl:before,bridgeToken:token,hermesConnectionId:f.p.confirmedConnectionId,unrelated:'preserve'});f.p.saveData=async()=>{throw Error('fictional disk failure');};const paths:string[]=[];globalThis.fetch=async(u)=>{paths.push(new URL(String(u)).pathname);return Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:[{id:'serve-local',kind:'serve',state:'ready',profile:'default',installId:'fictional-install',displayName:'Fictional'}]});};
 await assert.rejects(f.p.connectSettingsBridge({url:'http://127.0.0.1:8789',token:'candidate-fictional',detect:false}),(error:any)=>{assert.equal(error.saveOutcome,'unknown');assert.match(error.message,/保存结果未确认/);return true;});assert.equal(f.p.bridgeUrl,before);assert.equal(f.p.bridgeToken,token);assert.equal(f.input.value,'原 Chat 草稿');assert.deepEqual(paths,['/health','/connections']);
 }finally{globalThis.fetch=original;f.close();}
});
test('shared readonly reconnect with no document only probes connections',async()=>{
 const f=await fixture();const original=globalThis.fetch;try{f.setDocument('');f.p.threads=[];f.p.activeThreadId='';const paths:string[]=[];globalThis.fetch=async(u)=>{paths.push(new URL(String(u)).pathname);return Response.json({data:[{id:'serve-local',kind:'serve',state:'ready',profile:'default',installId:'fictional-install',displayName:'Fictional'}]});};assert.equal(await f.p.syncHermesSessions(),true);assert.deepEqual(paths,['/connections']);assert.equal(f.p.threads.length,0);}finally{globalThis.fetch=original;f.close();}
});

test('association from another Work detail saves its full identity without switching current Chat',async()=>{
 const f=await fixture();try{const target='20261008120009-ccccccc';await f.p.workStore.registerWork(target);const active=f.p.activeThreadId;let reads=0;f.p.bridgeClient=(documentRootId:string)=>({listCandidates:async()=>({data:[{id:'remote-other',title:'Other Work chat'}]}),bindChat:async(chatId:string,connectionId:string,storedSessionId:string,title:string)=>({chat:{chatId,connectionId,storedSessionId,title,documentRootId,kind:'serve',profile:'default',installId:'fictional-install',state:'ready'}})});f.p.loadThreadMessages=async()=>{reads++;};await f.p.associateStudio(f.root,target,()=>true);const radio=f.doc.querySelector<HTMLInputElement>('[data-studio-options] input')!;radio.dispatchEvent(new f.dom.window.Event('change'));await (f.doc.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick as any)();assert.equal((await f.p.workStore.listChats(target)).length,1);assert.equal(f.p.workController.currentWorkId,W);assert.equal(f.p.activeThreadId,active);assert.equal(reads,0);assert.equal(f.input.value,'原 Chat 草稿');const open=f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!;assert.equal(open.hidden,false);assert.equal(open.dataset.workId,target);
 }finally{f.close();}
});

test('shared late reference read stays in the originating Chat draft',async()=>{
 const f=await fixture();let release!:(v:any)=>void;try{const {p,root,dom}=f;const a=link('ref-a'),b=link('ref-b');p.threads=[p.threadFromLink(a),p.threadFromLink(b)];p.activeThreadId=a.chatId;p.activateDraft();p.loadThreadMessages=async()=>{};
 const editor=dom.window.document.createElement('div');editor.className='protyle';editor.innerHTML='<div data-node-id="20261008120002-aaaaaaa"><div contenteditable="true">fictional selected text</div></div>';dom.window.document.body.append(editor);p.currentEditor=()=>({protyle:{element:editor,block:{rootID:W}}});const range=dom.window.document.createRange();range.selectNodeContents(editor.querySelector('[contenteditable]')!);dom.window.getSelection()!.addRange(range);p.api=async()=>new Promise(r=>release=r);
 const pending=p.addCurrentReference(root);await p.selectChat(root,b.chatId);release({kramdown:'fictional selected text'});await pending;assert.equal(p.references.list().length,0);await p.selectChat(root,a.chatId);assert.equal(p.references.list().length,1);
 }finally{f.close();}
});
test('shared late context snapshot cannot replace a newly selected document snapshot',async()=>{
 const f=await fixture();let release!:(v:any)=>void;try{const {p,root,dom}=f;let doc=W;const other='20261008120009-ccccccc';const editor=dom.window.document.createElement('div');editor.className='protyle';editor.innerHTML='<input class="protyle-title__input" value="Fictional original"><div data-node-id="20261008120002-aaaaaaa"><div contenteditable="true">fictional text</div></div>';dom.window.document.body.append(editor);p.currentDocumentId=()=>doc;p.currentEditor=()=>({protyle:{element:editor,block:{rootID:doc}}});const range=dom.window.document.createRange();range.selectNodeContents(editor.querySelector('[contenteditable]')!);dom.window.getSelection()!.addRange(range);p.api=async()=>new Promise(r=>release=r);const pending=p.takeSnapshot(root);await tick();doc=other;p.snapshot={documentId:other,title:'New snapshot'};release({kramdown:'fictional text'});await pending;assert.equal(p.snapshot.documentId,other);assert.equal(p.snapshot.title,'New snapshot');
 }finally{f.close();}
});

test('unknown new Chat activates a separate draft and preserves the original on return',async()=>{
 const f=await fixture();try{
  const old=link('original-before-create');await f.p.workStore.linkChat(old);f.p.threads=[f.p.threadFromLink(old)];f.p.activeThreadId=old.chatId;f.p.activateDraft();f.p.loadThreadMessages=async()=>{};f.dom.window.confirm=()=>false;
  const original=f.p.activeThreadId,oldText='fictional old draft before unknown create';
  f.input.value=oldText;
  let creates=0;
  f.p.bridgeClient=()=>({createChat:async()=>{creates++;throw new TypeError('fictional connection lost after create');}});
  await f.p.startNewChat(f.root);
  const unknownId=f.p.activeThreadId,initialUnknownText=f.input.value;
  assert.notEqual(unknownId,original);
  const saved=await f.p.workStore.chatLink(unknownId);
  assert.equal(saved.state,'unknown');assert.equal(saved.storedSessionId,null);assert.equal(saved.connectionId,'serve-local');assert.equal(saved.installId,'fictional-install');
  f.input.value='fictional draft only for unknown Chat';f.input.dispatchEvent(new f.dom.window.Event('input'));
  await f.p.selectChat(f.root,original);
  assert.equal(f.input.value,oldText,'typing in the new unknown Chat must not replace the original draft');
  assert.equal(initialUnknownText,'','unknown creation must activate an empty new draft');
  await f.p.selectChat(f.root,unknownId);
  assert.equal(f.input.value,'fictional draft only for unknown Chat');assert.equal(creates,1,'returning to an unknown Chat must not retry create');
  assert.equal((await f.p.workStore.chatLink(unknownId)).state,'unknown');
 }finally{f.close();}
});

test('unstored new Chat activates its own draft while preserving pending identity evidence',async()=>{
 const f=await fixture();try{
  const old=link('original-before-unstored');await f.p.workStore.linkChat(old);f.p.threads=[f.p.threadFromLink(old)];f.p.activeThreadId=old.chatId;f.p.activateDraft();f.p.loadThreadMessages=async()=>{};f.dom.window.confirm=()=>false;
  f.input.value='fictional original before failed formal save';
  let creates=0;f.p.bridgeClient=(documentRootId:string)=>({createChat:async(chatId:string,connectionId:string,title:string)=>{creates++;return {chat:{chatId,connectionId,title,documentRootId,kind:'serve',profile:'default',installId:'fictional-install',storedSessionId:null,state:'pending'}};}});
  f.p.workStore.linkChat=async()=>{throw Error('fictional formal write failure');};
  await f.p.startNewChat(f.root);
  const unstored=f.p.activeThreadId,initial=f.input.value;assert.notEqual(unstored,old.chatId);
  f.input.value='fictional unstored Chat draft';f.input.dispatchEvent(new f.dom.window.Event('input'));
  await f.p.selectChat(f.root,old.chatId);
  assert.equal(f.input.value,'fictional original before failed formal save');assert.equal(initial,'');
  await f.p.selectChat(f.root,unstored);assert.equal(f.input.value,'fictional unstored Chat draft');assert.equal(creates,1);
  const pending=await f.p.workStore.listPending();assert.equal(pending.length,1);assert.equal(pending[0].id,'chat:'+unstored);assert.match(pending[0].details,/connectionId=serve-local/);assert.equal(f.p.threads.find((t:any)=>t.id===unstored).state,'unknown');
 }finally{f.close();}
});

for(const switchBeforeResolve of [false,true])test(`legacy classification carries the draft to its confirmed connection identity${switchBeforeResolve?' after switching Chat':''}`,async()=>{
 const f=await fixture(),originalFetch=globalThis.fetch;let release!:(value:Response)=>void;
 try{
  const legacyId='fictional-legacy-local',other=link('fictional-other-chat');
  await f.p.workStore.linkChat({chatId:legacyId,workId:W,documentRootId:W,connectionId:'http://127.0.0.1:8784'});await f.p.workStore.linkChat(other);
  globalThis.fetch=async(url)=>String(url).endsWith('/legacy-bindings')?new Promise(resolve=>{release=resolve;}):Response.json({data:[]});
  const restoring=f.p.onWorkChanged(W);await tick();assert.equal(typeof release,'function');assert.equal(f.p.activeThreadId,legacyId);
  f.input.value='fictional draft while classifying';f.input.dispatchEvent(new f.dom.window.Event('input'));
  if(switchBeforeResolve){await f.p.selectChat(f.root,other.chatId);f.input.value='fictional other Chat during classification';f.input.dispatchEvent(new f.dom.window.Event('input'));}
  release(Response.json({data:[{chatId:legacyId,documentRootId:W,storedSessionId:legacyId,connectionId:'studio-default',adapter:'studio',profile:'default',installId:null}]}));await restoring;
  const saved=await f.p.workStore.chatLink(legacyId);assert.equal(saved.adapter,'studio');assert.equal(saved.connectionId,'studio-default');assert.equal(saved.storedSessionId,legacyId);
  if(switchBeforeResolve){assert.equal(f.p.activeThreadId,other.chatId);assert.equal(f.input.value,'fictional other Chat during classification');await f.p.selectChat(f.root,legacyId);}
  assert.equal(f.input.value,'fictional draft while classifying');
  f.input.value='fictional draft after confirmed identity';f.input.dispatchEvent(new f.dom.window.Event('input'));
  await f.p.selectChat(f.root,other.chatId);await f.p.selectChat(f.root,legacyId);
  assert.equal(f.input.value,'fictional draft after confirmed identity','classification must rekey the draft before subsequent editing');
 }finally{globalThis.fetch=originalFetch;f.close();}
});

for(const destination of ['work','bridge-url','bridge-token'] as const)test(`legacy draft migration survives formal save completing after ${destination} switch`,async()=>{
 const f=await fixture(),originalFetch=globalThis.fetch;let releaseSave!:()=>void;
 try{
  const legacyId='fictional-gated-legacy',otherWork='20261008120009-ccccccc';
  await f.p.workStore.linkChat({chatId:legacyId,workId:W,documentRootId:W,connectionId:'http://127.0.0.1:8784'});
  await f.p.workStore.registerWork(otherWork);await f.p.workStore.linkChat({...link('fictional-other-work-chat'),workId:otherWork,documentRootId:otherWork});
  const originalUrl=f.p.bridgeUrl,originalToken=f.p.bridgeToken,save=f.p.saveData.bind(f.p);let gate=true,classifications=0;const requests:string[]=[];
  let saveStarted!:()=>void;const started=new Promise<void>(resolve=>saveStarted=resolve);
  f.p.saveData=async(key:string,value:any)=>{if(gate&&key==='work-formal-v2'&&value.chats.some((c:any)=>c.chatId===legacyId&&c.state==='ready')){gate=false;saveStarted();await new Promise<void>(resolve=>releaseSave=resolve);}await save(key,value);};
  globalThis.fetch=async(url)=>{
   const path=new URL(String(url)).pathname;requests.push(path);
   if(path==='/health')return Response.json({ok:true,service:'siyuan-ai-collab-bridge'});
   if(path==='/connections')return Response.json({data:[{id:'serve-local',kind:'serve',state:'ready',profile:'default',installId:'fictional-install',displayName:'Fictional'}]});
   if(path==='/legacy-bindings')return Response.json({data:classifications++===0?[{chatId:legacyId,documentRootId:W,storedSessionId:legacyId,connectionId:'studio-default',adapter:'studio',profile:'default',installId:null}]:[]});
   return Response.json({data:[]});
  };
  const resolving=f.p.onWorkChanged(W);await started;
  f.input.value='fictional original draft during formal save';f.input.dispatchEvent(new f.dom.window.Event('input'));
  if(destination==='work'){f.p.workController.workId=otherWork;f.p.workController.documentId=otherWork;f.setDocument(otherWork);await f.p.onWorkChanged(otherWork);}
  else await f.p.connectSettingsBridge({url:destination==='bridge-url'?'http://127.0.0.1:8799':originalUrl,token:destination==='bridge-token'?'fictional-other-token':originalToken,detect:false});
  const selected=f.p.activeThreadId;
  f.input.value='fictional destination draft';f.input.dispatchEvent(new f.dom.window.Event('input'));
  const requestsBeforeLateSave=requests.length;releaseSave();await resolving;
  assert.equal(requests.length,requestsBeforeLateSave,'late migration must not request history for the destination Chat');
  assert.equal(f.p.activeThreadId,selected);assert.equal(f.input.value,'fictional destination draft','late migration must not alter the destination composer');
  const saved=await f.p.workStore.chatLink(legacyId);assert.equal(saved.state,'ready');assert.equal(saved.adapter,'studio');assert.equal(saved.connectionId,'studio-default');
  if(destination==='work'){f.p.workController.workId=W;f.p.workController.documentId=W;f.setDocument(W);await f.p.onWorkChanged(W);}
  else await f.p.connectSettingsBridge({url:originalUrl,token:originalToken,detect:false});
  assert.equal(f.p.activeThreadId,legacyId);assert.equal(f.input.value,'fictional original draft during formal save','the original Work and private Bridge scope must retain its migrated draft');
 }finally{releaseSave?.();globalThis.fetch=originalFetch;f.close();}
});
