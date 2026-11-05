import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-expect-error runtime ESM module
import {createBridgeServer} from '../scripts/bridge.mjs';
// @ts-expect-error runtime ESM module
import {probeStudio} from '../scripts/hermes-connections.mjs';
import {connectionAdvice,inspectLocalBridge,validatedConnections} from '../src/work/connection-settings.ts';
import {buildConnectionDiagnostic} from '../src/work/connection-report.ts';
import {fixture,W,tick} from './shared-ui-fixture.ts';

const warning='studio_sessions_unresolved';
const studio={id:'studio-default',kind:'studio',profile:'default',installId:null,displayName:'Studio',state:'ready'};
const response=(body:unknown)=>Response.json(body);
async function service(t:any,rows:{index:any[];pages:any[][]}){
 const dir=await mkdtemp(join(tmpdir(),'studio-partial-'));
 const files=[join(dir,'legacy.json'),join(dir,'v2.json')];
 for(const file of files)await writeFile(file,'{}');
 const before=await Promise.all(files.map(file=>readFile(file)));
 const {server}=createBridgeServer({capability:'c'.repeat(64),studioToken:'synthetic',studioBase:'http://127.0.0.1:8748',bindingsFile:files[0],bindingsV2File:files[1],connections:{connections:[studio]},fetchImpl:async(raw:URL|string)=>{
  const u=new URL(raw);if(u.pathname==='/api/studio/sessions')return response({sessions:rows.index});
  const offset=Number(u.searchParams.get('offset')),limit=Number(u.searchParams.get('limit'));
  const page=offset===0?0:Math.floor(offset/limit);
  return response({sessions:rows.pages[page]??[],offset,limit,hasMore:page<rows.pages.length-1});
 }});
 t.after(async()=>{server.closeAllConnections();if(server.listening)await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});});
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 const call=async(path:string,body?:unknown)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:body?'POST':'GET',signal:AbortSignal.timeout(2000),headers:{'X-Siyuan-Collab-Token':'c'.repeat(64),'X-Siyuan-Document-Root':W,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json()};};
 const unchanged=async()=>{assert.deepEqual((await readdir(dir)).sort(),['legacy.json','v2.json']);assert.deepEqual(await Promise.all(files.map(file=>readFile(file))),before);};
 return {call,unchanged};
}

test('mixed sample stays ready and both lists warn while both bind APIs reject unresolved exact IDs without writes',async t=>{
 const rows={index:[{id:'known',profile:'default',title:'Index'},{id:'hidden',profile:'other'}],pages:[[{id:'known',title:'Canonical'},{id:'unknown'},{id:'hidden'}]]};
 const f=await service(t,rows);
 const detected=await f.call('/connections');assert.equal(detected.body.data[0].state,'ready');assert.equal(detected.body.data[0].readWarning,warning);
 for(const path of ['/studio/sessions','/connections/studio-default/sessions']){const r=await f.call(path);assert.equal(r.status,200);assert.equal(r.body.readWarning,warning);assert.deepEqual(r.body.data.map((s:any)=>[s.id,s.title]),[['known','Index']]);}
 for(const id of ['unknown','Known']){
  assert.equal((await f.call('/studio/bind',{session_id:id})).status,404);
  assert.equal((await f.call('/chats/bind',{chat_id:'local-test',connection_id:'studio-default',stored_session_id:id,confirm:true})).status,404);
 }
 await f.unchanged();
 // Fresh exact index evidence removes the warning, without creating a binding.
 rows.index.push({id:'unknown',profile:'default',title:'Now verified'});
 assert.equal((await f.call('/connections')).body.data[0].readWarning,undefined);
 const fresh=await f.call('/studio/sessions');assert.equal(fresh.body.readWarning,undefined);assert.deepEqual(fresh.body.data.map((s:any)=>s.id),['known','unknown']);await f.unchanged();
});

test('all unknown rows yield ready service, warning and no eligible candidates',async t=>{
 const f=await service(t,{index:[],pages:[[{id:'unknown'},{id:'unknown'}]]});
 const detected=(await f.call('/connections')).body.data[0];assert.equal(detected.state,'ready');assert.equal(detected.readWarning,warning);
 for(const path of ['/studio/sessions','/connections/studio-default/sessions'])assert.deepEqual((await f.call(path)).body,{data:[],readWarning:warning});
 await f.unchanged();
});

test('complete lists notice unresolved rows on later pages and duplicate rows before deduplication',async t=>{
 const f=await service(t,{index:[{id:'known',profile:'default'}],pages:[[{id:'known'},{id:'new',profile:'default'}],[{id:'new'}]]});
 assert.equal((await f.call('/connections')).body.data[0].readWarning,undefined);
 for(const path of ['/studio/sessions','/connections/studio-default/sessions']){const r=await f.call(path);assert.equal(r.body.readWarning,warning);assert.deepEqual(r.body.data.map((s:any)=>s.id),['known','new']);}
 await f.unchanged();
});

test('probe keeps explicit profile conflicts invalid and never carries partial warnings into failures',async()=>{
 for(const canonical of [[{id:'u'},{id:'u',profile:'default'}],[{id:'u',profile:'default'},{id:'u'}],[{id:'u'},{id:'bad',profile:null}],[{id:'u'},{id:'bad',profile:''}],[{id:'u'},{id:'bad',profile:2}]]){
  const result=await probeStudio('http://127.0.0.1:8748',{tokenProvider:()=> 'synthetic',fetchImpl:async(u:URL)=>response({sessions:u.pathname.endsWith('/hermes')?canonical:[]})});
  assert.deepEqual(result,{state:'incompatible',profile:'default'});
 }
});

test('concurrent probes retain separate exact index evidence',async()=>{
 const run=(known:boolean)=>probeStudio('http://127.0.0.1:8748',{tokenProvider:()=> 'synthetic',fetchImpl:async(u:URL)=>{await new Promise(r=>setTimeout(r,known?1:3));return response({sessions:u.pathname.endsWith('/hermes')?[{id:'same'}]:known?[{id:'same',profile:'default'}]:[]});}});
 assert.deepEqual(await Promise.all([run(true),run(false)]),[{state:'ready',profile:'default'},{state:'ready',profile:'default',readWarning:warning}]);
});

test('inspection and diagnostic accept only finite ready Studio warnings',async()=>{
 for(const value of [warning,'<img src=x>private-service-text',null,{},[warning]])for(const kind of ['studio','serve','legacy-api'])for(const state of ['ready','offline']){
  const raw={...studio,kind,state,installId:kind==='serve'?'synthetic-install':null,readWarning:value};
  const result=await inspectLocalBridge({bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'synthetic'},async u=>response(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:[raw]}));
  const accepted=value===warning&&kind==='studio'&&state==='ready';
  assert.equal(validatedConnections([raw])[0].readWarning,accepted?warning:undefined);
  const report=buildConnectionDiagnostic(result,{pluginVersion:'0.3.11',freshness:'current',candidateKind:null,confirmedKind:null,saveOutcome:'not-requested'});
  assert.equal((report.services[0] as any).readWarning,accepted?warning:undefined);
  assert.doesNotMatch(JSON.stringify(report),/private-service-text/);
  if(accepted){assert.match(result.message,/部分.*归属.*核验|部分.*归属.*核实/);assert.match(connectionAdvice(result.connections![0]),/无法关联|不可关联/);}
 }
});

for(const empty of [false,true])test(`actual built picker keeps fixed list warning through filtering and cancel, empty=${empty}`,async()=>{
 const f=await fixture();try{
  f.p.connectionViews=[studio];f.p.selectedConnectionId='studio-default';f.p.confirmedConnectionId='studio-default';
  const active=f.p.activeThreadId;let binds=0;
  f.p.bridgeClient=()=>({listCandidates:async()=>({data:empty?[]:[{id:'known',title:'Known'}],readWarning:warning}),bindChat:async()=>{binds++;assert.fail('selection/cancel must not bind');}});
  await f.p.associateStudio(f.root);
  const notice=f.doc.querySelector<HTMLElement>('[data-studio-read-warning]');assert.ok(notice);assert.equal(notice.hidden,false);assert.match(notice.textContent||'',/归属.*核验|归属.*核实/);assert.match(notice.textContent||'',/无法关联|不可关联/);
  const confirm=f.doc.querySelector<HTMLButtonElement>('[data-studio-confirm]')!;assert.equal(confirm.disabled,true);
  if(!empty){f.doc.querySelector<HTMLInputElement>('[data-studio-options] input')!.dispatchEvent(new f.dom.window.Event('change'));assert.equal(confirm.disabled,false);}
  else await (confirm.onclick as any)();
  const search=f.doc.querySelector<HTMLInputElement>('[data-studio-search]')!;search.value='no match';search.dispatchEvent(new f.dom.window.Event('input'));assert.equal(notice.isConnected,true);assert.equal(notice.hidden,false);
  assert.equal(f.p.activeThreadId,active);assert.equal(binds,0);assert.deepEqual(await f.p.workStore.listChats(W),[]);
  f.doc.querySelector<HTMLButtonElement>('[data-studio-cancel]')!.click();assert.equal(f.doc.querySelector('[data-studio-read-warning]'),null);
 }finally{f.close();}
});

test('actual picker ignores unsafe warning from list and ignores stale inspection warning',async()=>{
 const f=await fixture();try{
  f.p.connectionViews=[{...studio,readWarning:warning}];f.p.selectedConnectionId='studio-default';f.p.confirmedConnectionId='studio-default';
  f.p.bridgeClient=()=>({listCandidates:async()=>({data:[],readWarning:'<img src=x>private-service-text'})});
  await f.p.associateStudio(f.root);assert.doesNotMatch(f.doc.body.innerHTML,/private-service-text/);
  assert.equal(f.doc.querySelector<HTMLElement>('[data-studio-read-warning]')?.hidden,true);
 }finally{f.close();}
});

test('actual settings show partial status, detection stays read-only and only explicit confirmation saves',async()=>{
 const f=await fixture({confirmed:false}),original=globalThis.fetch;try{
  const active=f.p.activeThreadId,paths:string[]=[];let saves=0;
  const save=f.p.saveData.bind(f.p);f.p.saveData=async(k:string,v:any)=>{if(k==='settings')saves++;return save(k,v);};
  f.p.workHost.listNotebooks=async()=>[];
  globalThis.fetch=async u=>{const path=new URL(String(u)).pathname;paths.push(path);return response(path==='/health'?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:[{...studio,readWarning:warning}]});};
  f.p.openSettings(f.root,'hermes');await tick();
  f.doc.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click();await tick();
  assert.equal(saves,0);assert.equal(f.p.confirmedConnectionId,undefined);assert.deepEqual(paths,['/health','/connections']);
  assert.match(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/部分.*归属.*核验/);
  assert.match(f.doc.querySelector('[data-hermes-results]')!.textContent||'',/无法关联/);
  f.doc.querySelector<HTMLButtonElement>('[data-settings-action="view-diagnostic"]')!.click();
  const preview=f.doc.querySelector('[data-diagnostic-preview]')!.textContent!;
  assert.equal(JSON.parse(preview).services[0].readWarning,warning);
  let copied='';Object.defineProperty(f.dom.window.navigator,'clipboard',{value:{writeText:async(text:string)=>{copied=text;}}});
  f.doc.querySelector<HTMLButtonElement>('[data-settings-action="copy-diagnostic"]')!.click();await tick();assert.equal(copied,preview);
  f.doc.querySelector<HTMLButtonElement>('[data-settings-action="confirm-bridge"]')!.click();await tick();
  assert.equal(saves,1);assert.equal(f.p.confirmedConnectionId,'studio-default');assert.equal(f.p.activeThreadId,active);assert.equal(f.input.value,'原 Chat 草稿');
 }finally{globalThis.fetch=original;f.p.settingsDialog?.dispose();f.close();}
});

test('actual picker receives list warning through client and confirmed known association leaves active Chat unchanged',async()=>{
 const f=await fixture(),original=globalThis.fetch;try{
  f.p.connectionViews=[studio];f.p.selectedConnectionId='studio-default';f.p.confirmedConnectionId='studio-default';
  const active=f.p.activeThreadId,paths:string[]=[];
  globalThis.fetch=async(u,init)=>{const path=new URL(String(u)).pathname;paths.push(path);
   if(path==='/connections/studio-default/sessions')return response({data:[{id:'known',title:'Known'}],readWarning:warning});
   assert.equal(path,'/chats/bind');const b=JSON.parse(String(init?.body));assert.equal(b.confirm,true);assert.equal(b.stored_session_id,'known');
   return response({chat:{chatId:b.chat_id,documentRootId:W,connectionId:'studio-default',storedSessionId:'known',kind:'studio',profile:'default',installId:null,title:'Known',state:'ready'}});
  };
  await f.p.associateStudio(f.root);assert.deepEqual(paths,['/connections/studio-default/sessions']);
  assert.equal(f.doc.querySelector<HTMLElement>('[data-studio-read-warning]')!.hidden,false);
  f.doc.querySelector<HTMLInputElement>('[data-studio-options] input')!.dispatchEvent(new f.dom.window.Event('change'));
  assert.equal(f.p.activeThreadId,active);assert.deepEqual(paths,['/connections/studio-default/sessions']);
  await (f.doc.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick as any)();
  assert.deepEqual(paths,['/connections/studio-default/sessions','/chats/bind']);assert.equal((await f.p.workStore.listChats(W))[0].storedSessionId,'known');
  assert.equal(f.p.activeThreadId,active);assert.equal(f.input.value,'原 Chat 草稿');assert.equal(f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.hidden,false);
 }finally{globalThis.fetch=original;f.close();}
});
