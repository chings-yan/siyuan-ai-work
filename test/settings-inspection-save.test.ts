import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,link,W,D,tick} from './shared-ui-fixture.ts';
const studio={id:'studio-default',kind:'studio',profile:'fictional-profile',installId:null,displayName:'Fictional Studio',state:'ready'};
const reads:typeof fetch=async u=>Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:[studio]});
const deferred=()=>{let release!:()=>void,enter!:()=>void;return {entered:new Promise<void>(r=>enter=r),wait:()=>new Promise<void>(r=>{release=r;enter();}),release:()=>release()};};
function fields(f:any){return {url:f.doc.querySelector('[data-setting="baseUrl"]') as HTMLInputElement,token:f.doc.querySelector('[data-setting="bridgeToken"]') as HTMLInputElement,select:f.doc.querySelector('[data-setting="hermesConnection"]') as HTMLSelectElement};}
function click(f:any,action:string){const button=f.doc.querySelector(`[data-settings-action="${action}"]`) as HTMLButtonElement;assert.ok(button,`visible ${action} entry`);button.click();}
test('actual settings inspect is read only; explicit confirm writes once and reads back before runtime changes',async()=>{
 const f=await fixture({confirmed:false}),fetchBefore=globalThis.fetch;
 try{
  globalThis.fetch=reads;f.p.workHost.listNotebooks=async()=>[];
  const old=link('inspection-original');await f.p.workStore.linkChat(old);await f.p.workStore.setPending({id:'fictional-unknown',kind:'chat',workId:W,state:'unknown',details:'fictional',updatedAt:'2026-10-22'});
  const relations=structuredClone(await f.p.loadData('work-formal-v2')),pending=await f.p.workStore.listPending(),views=structuredClone(f.p.connectionViews),target=f.p.selectedConnectionId,originalDraft=f.p.activeDraft;
  let writes=0,readbacks=0;const save=f.p.saveData.bind(f.p),load=f.p.loadData.bind(f.p);
  f.p.saveData=async(k:string,v:any)=>{if(k==='settings')writes++;return save(k,v);};
  f.p.loadData=async(k:string)=>{if(k==='settings'&&writes){assert.equal(f.p.selectedConnectionId,target);readbacks++;}return load(k);};
  f.p.openSettings(f.root,'hermes');await tick();const input=fields(f);input.token.value='fictional-unsaved-token';
  click(f,'detect-bridge');await tick();
  assert.equal(writes,0);assert.equal(f.p.selectedConnectionId,target);assert.equal(f.p.confirmedConnectionId,undefined);assert.deepEqual(f.p.connectionViews,views);assert.equal(input.token.value,'fictional-unsaved-token');assert.equal(input.select.value,studio.id);
  click(f,'confirm-bridge');await tick();
  assert.equal(writes,1);assert.equal(readbacks,1);assert.equal(f.p.selectedConnectionId,studio.id);assert.equal(input.token.value,'');
  assert.deepEqual(await f.p.loadData('work-formal-v2'),relations);assert.deepEqual(await f.p.workStore.listPending(),pending);assert.equal(originalDraft.text,'原 Chat 草稿');
 }finally{globalThis.fetch=fetchBefore;f.close();}
});
for(const phase of ['health','body','settings-read','save','readback'] as const)for(const change of ['candidate','document','connection','page','busy'] as const)
 test(`actual candidate ${change} invalidation at ${phase} preserves runtime and drafts`,async()=>{
  const f=await fixture({confirmed:false}),fetchBefore=globalThis.fetch,gate=deferred();let writes=0;
  try{
   const target=f.p.selectedConnectionId;const save=f.p.saveData.bind(f.p),load=f.p.loadData.bind(f.p);let gated=false;
   globalThis.fetch=async(u,i)=>{
    if(phase==='health'&&String(u).endsWith('/health'))await gate.wait();
    const response=await reads(u,i);
    if(phase==='body'&&String(u).endsWith('/connections'))return {status:200,ok:true,json:async()=>{await gate.wait();return {data:[studio]};}} as Response;
    return response;
   };
   f.p.loadData=async(k:string)=>{if(k==='settings'&&!gated&&((phase==='settings-read'&&!writes)||(phase==='readback'&&writes))){gated=true;await gate.wait();}return load(k);};
   f.p.saveData=async(k:string,v:any)=>{if(k==='settings'){writes++;if(phase==='save')await gate.wait();}return save(k,v);};
   let candidateCurrent=true;
   const connecting=f.p.connectSettingsBridge({url:f.p.bridgeUrl,token:'fictional-new-token',detect:false},()=>candidateCurrent);
   const rejected=assert.rejects(connecting,(error:any)=>{assert.equal(error.saveOutcome,phase==='save'||phase==='readback'?'unknown':'stale');return true;});
   await Promise.race([gate.entered,new Promise((_,reject)=>setTimeout(()=>reject(Error("expected await boundary not reached")),1500))]);
   if(change==='candidate'||change==='page')candidateCurrent=false;
   if(change==='document')f.setDocument(D);
   if(change==='connection')f.p.selectedConnectionId='externally-selected';
   if(change==='busy')f.p.sendInFlight=true;
   gate.release();await rejected;
   assert.equal(writes,phase==='save'||phase==='readback'?1:0);assert.equal(f.p.selectedConnectionId,change==='connection'?'externally-selected':target);assert.equal(f.p.bridgeToken,'fictional-token');assert.equal(f.input.value,'原 Chat 草稿');
  }finally{globalThis.fetch=fetchBefore;f.close();}
 });
for(const mode of ['mismatch','throws','save-throws'] as const)test(`actual ${mode} is unknown after write and never rolls disk back`,async()=>{
 const f=await fixture({confirmed:false}),fetchBefore=globalThis.fetch;try{
  globalThis.fetch=reads;let writes=0;const target=f.p.selectedConnectionId,save=f.p.saveData.bind(f.p),load=f.p.loadData.bind(f.p);
  f.p.saveData=async(k:string,v:any)=>{writes++;await save(k,v);if(mode==='save-throws')throw Error('fictional write failure');};
  f.p.loadData=async(k:string)=>{if(k==='settings'&&writes){if(mode==='throws')throw Error('fictional read failure');return {...await load(k),bridgeToken:'fictional-other-token'};}return load(k);};
  await assert.rejects(f.p.connectSettingsBridge({url:f.p.bridgeUrl,token:'fictional-new-token',detect:false}),(error:any)=>error.saveOutcome==='unknown');
  assert.equal(writes,1);assert.equal(f.p.selectedConnectionId,target);assert.equal(f.p.bridgeToken,'fictional-token');assert.equal((await load('settings')).bridgeToken,'fictional-new-token');assert.equal(f.input.value,'原 Chat 草稿');
 }finally{globalThis.fetch=fetchBefore;f.close();}
});
test('empty confirmed preference does not impersonate startup Serve; offline confirmation is Bridge only',async()=>{
 const f=await fixture({confirmed:false}),fetchBefore=globalThis.fetch;try{
  globalThis.fetch=reads;const inspected=await f.p.inspectSettingsCandidate({url:f.p.bridgeUrl,token:'',detect:false},()=>true);
  assert.equal(inspected.selectedConnectionId,studio.id);assert.equal(inspected.saveOutcome,'not-requested');assert.equal(f.p.confirmedConnectionId,undefined);
  globalThis.fetch=async u=>Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:[{...studio,state:'offline'}]});
  const result=await f.p.connectSettingsBridge({url:f.p.bridgeUrl,token:'',detect:false});assert.equal(result.saveOutcome,'bridge-only');assert.equal(result.hermesReady,false);assert.equal(f.p.confirmedConnectionId,undefined);assert.equal((await f.p.loadData('settings')).hermesConnectionId,undefined);
 }finally{globalThis.fetch=fetchBefore;f.close();}
});
for(const phase of ['health','body','save','readback'] as const)test(`actual UI programmatic candidate edit during ${phase} invalidates frozen confirmation`,async()=>{
 const f=await fixture({confirmed:false}),fetchBefore=globalThis.fetch,gate=deferred();let writes=0;
 try{
  const save=f.p.saveData.bind(f.p),load=f.p.loadData.bind(f.p),target=f.p.selectedConnectionId;
  globalThis.fetch=async(u,i)=>{if(phase==='health'&&String(u).endsWith('/health'))await gate.wait();if(phase==='body'&&String(u).endsWith('/connections'))return {status:200,ok:true,json:async()=>{await gate.wait();return {data:[studio]};}} as Response;return reads(u,i);};
  f.p.saveData=async(k:string,v:any)=>{if(k==='settings'){writes++;if(phase==='save')await gate.wait();}return save(k,v);};
  f.p.loadData=async(k:string)=>{if(k==='settings'&&writes&&phase==='readback')await gate.wait();return load(k);};
  f.p.openSettings(f.root,'hermes');const input=fields(f);input.token.value='fictional-unsaved-token';click(f,'confirm-bridge');await gate.entered;
  input.token.value='fictional-replacement-token';gate.release();await tick();
  assert.equal(writes,phase==='save'||phase==='readback'?1:0);assert.equal(input.token.value,'fictional-replacement-token');assert.equal(f.p.selectedConnectionId,target);assert.equal(f.p.confirmedConnectionId,undefined);assert.equal(f.input.value,'原 Chat 草稿');
  assert.doesNotMatch(f.doc.querySelector('[data-hermes-results-label]')!.textContent||'',/本次/);
  f.p.settingsDialog.dispose();f.p.openSettings(f.root,'hermes');await tick();assert.equal(writes,phase==='save'||phase==='readback'?1:0,'reopening never retries writes');
 }finally{globalThis.fetch=fetchBefore;f.close();}
});
test('actual UI late old inspect cannot unlock a reopened page owned by a newer request',async()=>{
 const f=await fixture({confirmed:false}),fetchBefore=globalThis.fetch,old=deferred(),fresh=deferred();let checks=0;
 try{
  globalThis.fetch=async(u,i)=>{if(String(u).endsWith('/health')){if(++checks===1)await old.wait();else await fresh.wait();}return reads(u,i);};
  f.p.openSettings(f.root,'hermes');click(f,'detect-bridge');await old.entered;
  f.p.settingsDialog.dispose();f.p.openSettings(f.root,'hermes');click(f,'detect-bridge');await fresh.entered;
  old.release();await tick();
  const overlay=f.doc.querySelector('.sac-settings-overlay')!;assert.equal(overlay.getAttribute('aria-busy'),'true');assert.equal(f.p.settingsDialog.isBusy,true);assert.equal((overlay.querySelector('[data-settings-action="confirm-bridge"]') as HTMLButtonElement).disabled,true);
  fresh.release();await tick();assert.equal(overlay.hasAttribute('aria-busy'),false);assert.equal(f.p.settingsDialog.isBusy,false);assert.equal(f.p.confirmedConnectionId,undefined);
 }finally{globalThis.fetch=fetchBefore;f.close();}
});
for(const change of ['document','page','chat'] as const)test(`actual UI ${change} during committed private scope restore cannot replace destination draft`,async()=>{
 const f=await fixture({confirmed:false}),fetchBefore=globalThis.fetch,gate=deferred();try{
  globalThis.fetch=reads;f.p.workHost.listNotebooks=async()=>[];
  if(change==='chat'){const a=link('fictional-original-chat'),b=link('fictional-user-selected-chat');await f.p.workStore.linkChat(a);await f.p.workStore.linkChat(b);f.p.threads=[f.p.threadFromLink(a),f.p.threadFromLink(b)];f.p.activeThreadId=a.chatId;f.p.activateDraft();f.p.renderThreads(f.root);f.p.loadThreadMessages=async()=>true;}
  const list=f.p.workStore.listChats.bind(f.p.workStore);f.p.workStore.listChats=async(id:string)=>{await gate.wait();return list(id);};
  f.p.openSettings(f.root,'hermes');fields(f).token.value='fictional-new-private-scope';click(f,'confirm-bridge');await gate.entered;
  assert.equal((await f.p.loadData('settings')).bridgeToken,'fictional-new-private-scope','readback verified the committed settings before restore');
  if(change==='document')f.setDocument(D);else if(change==='chat'){const select=f.root.querySelector<HTMLSelectElement>('[data-thread-selector]')!;select.value=[...select.options].find(option=>option.value.includes('fictional-user-selected-chat'))!.value;select.dispatchEvent(new f.dom.window.Event('change'));await tick();assert.equal(f.p.activeThreadId,'fictional-user-selected-chat');}else{f.p.settingsDialog.dispose();f.p.openSettings(f.root,'hermes');}
  const active=f.p.activeThreadId;f.input.value='fictional destination draft';f.input.dispatchEvent(new f.dom.window.Event('input'));
  gate.release();await tick();assert.equal(f.input.value,'fictional destination draft');assert.equal(f.p.activeThreadId,active);assert.equal(f.p.bridgeToken,'fictional-new-private-scope');
  assert.doesNotMatch(f.doc.querySelector('[data-hermes-results-label]')!.textContent||'',/本次/);
 }finally{globalThis.fetch=fetchBefore;f.close();}
});
for(const phase of ['listChats','getResume'] as const)for(const lifecycle of ['page','panel'] as const)
 test(`private scopes retain A and B drafts after ${lifecycle} disposal during ${phase}`,async()=>{
  const f=await fixture(),fetchBefore=globalThis.fetch,gate=deferred();try{
   const old=link('fictional-private-scope-chat');await f.p.workStore.linkChat(old);f.p.loadThreadMessages=async()=>true;await f.p.onWorkChanged(W);
   globalThis.fetch=async u=>Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:f.p.connectionViews});f.p.workHost.listNotebooks=async()=>[];
   const other=f.doc.createElement('div');f.doc.body.append(other);f.p.connectionOk=true;f.p.render(other);await tick();
   f.input.value='fictional original private draft';f.input.dispatchEvent(new f.dom.window.Event('input'));
   const originalToken=f.p.bridgeToken,originalDraft=f.p.activeDraft,formal=structuredClone(await f.p.loadData('work-formal-v2'));
   const pending={kind:'unknown',message:'fictional original pending'};originalDraft.pending=pending;
   let once=true;const read=f.p.workStore[phase].bind(f.p.workStore);f.p.workStore[phase]=async(id:string)=>{if(once){once=false;await gate.wait();}return read(id);};
   f.p.openSettings(f.root,'hermes');fields(f).token.value='fictional-new-private-scope';click(f,'confirm-bridge');await gate.entered;
   if(lifecycle==='panel')f.p.disposeRoomView(f.root);else f.p.settingsDialog.dispose();
   f.p.openSettings(other,'hermes');gate.release();await tick();f.p.settingsDialog.dispose();
   const input=other.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;input.value='fictional destination private draft';input.dispatchEvent(new f.dom.window.Event('input'));
   const consistent=f.p.threadConnection===f.p.connectionIdentity(),isolated=f.p.activeDraft!==originalDraft;
   await f.p.connectSettingsBridge({url:f.p.bridgeUrl,token:originalToken,detect:false});
   assert.equal(input.value,'fictional original private draft','B editing must never replace the original A draft');assert.equal(f.p.activeDraft,originalDraft);assert.deepEqual(originalDraft.pending,pending);
   await f.p.connectSettingsBridge({url:f.p.bridgeUrl,token:'fictional-new-private-scope',detect:false});
   assert.equal(input.value,'fictional destination private draft','returning to B restores its own draft');assert.equal(consistent,true);assert.equal(isolated,true);assert.equal(f.p.threadConnection,f.p.connectionIdentity());assert.deepEqual(await f.p.loadData('work-formal-v2'),formal);
  }finally{globalThis.fetch=fetchBefore;f.close();}
 });
