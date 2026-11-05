import test from 'node:test';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {SettingsDialog} from '../src/work/settings-dialog.ts';
import {BridgeInspectionError} from '../src/work/connection-settings.ts';
import {fixture,tick} from './shared-ui-fixture.ts';
const checkedAt='2026-10-22T12:34:56.000Z';
const studio={id:'fictional-studio',kind:'studio',state:'ready',profile:'private-profile',installId:null,displayName:'private-title'};
const result=(extra:any={})=>({url:'http://127.0.0.1:8782',message:'fictional-token private-path',bridgeAuthenticated:true,hermesReady:true,connections:[studio],selectedConnectionId:studio.id,saveOutcome:'not-requested',evidence:{checkedAt,code:'ok',reads:[{attempt:1,step:'health',httpStatus:200},{attempt:1,step:'connections',httpStatus:200}],companion:{schemaVersion:1,bridgeVersion:'0.3.9',capabilities:['hermes-connection-inspection-v1','private-title'],private:'fictional-token'}},...extra});
function ui(options:any={}){
 const dom=new JSDOM('<body><button id="source">设置</button></body>'),doc=dom.window.document;let requests=0,writes=0,copied='';
 Object.defineProperty(dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied=text;}}});
 const actions={bridgeUrl:()=> 'http://127.0.0.1:8782',bridgeStatus:()=>'',save:async()=>{writes++;},pluginVersion:()=> '0.3.9',confirmedKind:()=>null,connections:()=>[],inspectBridge:async()=>{requests++;return result();},...options};
 const view=new SettingsDialog(doc,actions);doc.querySelector<HTMLButtonElement>('#source')!.focus();view.open(doc.querySelector('#source')!,'hermes');
 const click=(action:string)=>{const button=doc.querySelector<HTMLButtonElement>(`[data-settings-action="${action}"]`);assert.ok(button,`action ${action}`);button.click();};
 return {dom,doc,view,click,requests:()=>requests,writes:()=>writes,copied:()=>copied,close:()=>{view.dispose();dom.window.close();}};
}
test('four reversible steps allow Hermes without Work or EKKO; later returns focus and writes nothing',async()=>{
 const f=ui();try{
  const steps=[...f.doc.querySelectorAll<HTMLDetailsElement>('[data-connection-step]')];assert.equal(steps.length,4);
  assert.deepEqual(steps.map(s=>s.querySelector('summary')!.textContent),['1. 准备本机配套','2. 配对本机 Bridge','3. 选择 Hermes 服务','4. 确认连接结果']);
  assert.doesNotMatch(f.doc.querySelector('[data-settings-pane="hermes"]')!.textContent||'',/先整理 Work/);
  assert.match(f.doc.querySelector('[data-hermes-results-label]')!.textContent||'',/尚未检测/);
  await f.click('detect-bridge');await tick();assert.equal(steps[0].open,false);assert.equal(steps[1].open,false);steps[1].open=true;assert.ok(f.doc.querySelector('[data-setting="bridgeToken"]'));
  f.click('later');assert.equal(f.doc.querySelector('.sac-settings-overlay'),null);assert.equal(f.doc.activeElement?.id,'source');assert.equal(f.writes(),0);
 }finally{f.close();}
});
// Removing an auxiliary fold, or moving a required control/status into it, must break this contract.
function shownOutsideFold(element:Element):boolean{
 for(let node:Element|null=element;node;node=node.parentElement){
  if(node.hasAttribute('hidden'))return false;
  if(node.parentElement?.matches('details:not([open])')&&node.tagName!=='SUMMARY')return false;
 }
 return true;
}
test('maintenance and diagnostic explanations start folded while detection, candidate and confirmation stay visible',()=>{
 const f=ui({lastInspection:()=>result()});try{
  for(const kind of ['maintenance','diagnostics','usage']){
   const help=f.doc.querySelector<HTMLDetailsElement>(`details[data-settings-help="${kind}"]`);
   assert.ok(help,`${kind} has a native labeled fold`);assert.equal(help.open,false);assert.ok(help.querySelector('summary')!.textContent!.trim());
  }
  for(const selector of ['[data-settings-action="detect-bridge"]','[data-setting="hermesConnection"]','[data-hermes-results]','[data-hermes-results-label]','[data-hermes-authorization]','[data-bridge-status]','[data-settings-action="confirm-bridge"]'])assert.equal(shownOutsideFold(f.doc.querySelector(selector)!),true,selector);
  for(const action of ['help-serve','help-studio','help-legacy-api','view-diagnostic'])assert.equal(shownOutsideFold(f.doc.querySelector(`[data-settings-action="${action}"]`)!),false,action);
  assert.equal(shownOutsideFold(f.doc.querySelector('[data-companion-info]')!),false);
 }finally{f.close();}
});
test('opening auxiliary help preserves candidates and evidence, and keyboard exit remains reachable',async()=>{
 const f=ui();try{
  const token=f.doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!;token.value='fictional-unsaved-token';
  const select=f.doc.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')!,candidate=select.value,label=f.doc.querySelector('[data-hermes-results-label]')!.textContent;
  const helpers=[...f.doc.querySelectorAll<HTMLDetailsElement>('[data-settings-help]')];assert.equal(helpers.length,3);
  for(const help of helpers){help.querySelector<HTMLElement>('summary')!.click();assert.equal(help.open,true);help.querySelector<HTMLElement>('summary')!.click();assert.equal(help.open,false);}
  await tick();assert.equal(f.requests(),0);assert.equal(f.writes(),0);assert.equal(token.value,'fictional-unsaved-token');assert.equal(select.value,candidate);assert.equal(f.doc.querySelector('[data-hermes-results-label]')!.textContent,label);
  const later=f.doc.querySelector<HTMLButtonElement>('[data-settings-action="later"]')!,close=f.doc.querySelector<HTMLButtonElement>('[data-settings-action="close"]')!;
  later.focus();later.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));assert.equal(f.doc.activeElement,close);
  close.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));assert.equal(f.doc.activeElement,later);
 }finally{f.close();}
});
test('failed inspections and unknown saves remain outside auxiliary help and EKKO expiry remains visible',async()=>{
 for(const options of [
  {inspectBridge:async()=>{throw new BridgeInspectionError({checkedAt,code:'health_unreachable',reads:[],companion:null});}},
  {connectBridge:async()=>{throw Object.assign(Error('fictional-private'),{saveOutcome:'unknown'});}}
 ]){
  const f=ui(options);try{f.click('connectBridge' in options?'confirm-bridge':'detect-bridge');await tick();
   for(const selector of ['[data-bridge-status]','[data-settings-error]'])assert.equal(shownOutsideFold(f.doc.querySelector(selector)!),true,selector);
   const help=f.doc.querySelector<HTMLDetailsElement>('[data-settings-help="diagnostics"]');assert.ok(help);assert.equal(help.open,false);
  }finally{f.close();}
 }
 const f=ui({checkEkko:async()=>({id:'fictional',deviceId:'fictional',accountUserId:7,accountName:'虚构账户',state:'auth_failed',authorization:{source:'app-login-record',expiresAt:1}})});
 try{f.click('ekko');await tick();assert.equal(shownOutsideFold(f.doc.querySelector('[data-ekko-status]')!),true);assert.equal(shownOutsideFold(f.doc.querySelector('[data-ekko-authorization]')!),true);}finally{f.close();}
});
test('preview and copy use exactly the same whitelist with no requests or writes',async()=>{
 const f=ui();try{f.click('detect-bridge');await tick();const before=f.requests();f.click('view-diagnostic');const preview=f.doc.querySelector('[data-diagnostic-preview]')!.textContent!;const report=JSON.parse(preview);
  assert.equal(report.pluginVersion,'0.3.9');assert.equal(report.checkedAt,checkedAt);assert.equal(report.freshness,'current');assert.deepEqual(report.services,[{kind:'studio',state:'ready'}]);assert.deepEqual(report.companion.capabilities,['hermes-connection-inspection-v1']);
  assert.doesNotMatch(preview,/fictional-token|private-profile|private-title|private-path/);assert.doesNotMatch(f.doc.querySelector('[data-settings-pane="hermes"]')!.textContent||'',/fictional-token|private-profile|private-title|private-path/);
  f.click('copy-diagnostic');await tick();assert.equal(f.copied(),preview);assert.equal(f.requests(),before);assert.equal(f.writes(),0);
 }finally{f.close();}
});
for(const meta of [null,{schemaVersion:1,bridgeVersion:'fictional-token',capabilities:[]},{schemaVersion:1,bridgeVersion:'1.2.3\n',capabilities:[]},{schemaVersion:1,bridgeVersion:'1.2.3+'+'a'.repeat(59),capabilities:[]},{schemaVersion:1,bridgeVersion:'1.2.3',capabilities:['x'.repeat(65)]},{schemaVersion:1,bridgeVersion:'1.2.3',capabilities:Array(17).fill('unknown')},{schemaVersion:2,bridgeVersion:'1.2.3',capabilities:[]}])test(`unrecognized companion ${JSON.stringify(meta)} preserves reading and drops display/diagnostic metadata`,async()=>{
 const r=result();r.evidence.companion=meta as any;const f=ui({inspectBridge:async()=>r});try{f.click('detect-bridge');await tick();assert.match(f.doc.querySelector('[data-companion-info]')!.textContent||'',/配套未提供可识别的能力信息/);f.click('view-diagnostic');const p=JSON.parse(f.doc.querySelector('[data-diagnostic-preview]')!.textContent!);assert.equal(p.companion,null);assert.equal(p.completed,true);assert.equal(p.services[0].state,'ready');assert.doesNotMatch(f.doc.querySelector('[data-settings-pane="hermes"]')!.textContent||'',/fictional-token|强制升级/);}finally{f.close();}
});
test('previous inspection keeps its actual time when reopened or candidates change; missing history stays unknown',async()=>{
 const previous=result();const f=ui({lastInspection:()=>previous});try{
  assert.match(f.doc.querySelector('[data-hermes-results-label]')!.textContent||'',/上次检测/);assert.match(f.doc.querySelector('[data-hermes-results-label]')!.textContent||'',new RegExp(checkedAt));f.click('view-diagnostic');assert.equal(JSON.parse(f.doc.querySelector('[data-diagnostic-preview]')!.textContent!).freshness,'previous');
  f.click('detect-bridge');await tick();const token=f.doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!;token.value='fictional-draft';token.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));assert.match(f.doc.querySelector('[data-hermes-results-label]')!.textContent||'',/上次检测/);
  f.view.close();f.view.open(f.doc.querySelector('#source')!,'hermes');assert.doesNotMatch(f.doc.querySelector('[data-hermes-results-label]')!.textContent||'',/本次/);
 }finally{f.close();}
 const unknown=ui();try{unknown.click('view-diagnostic');const p=JSON.parse(unknown.doc.querySelector('[data-diagnostic-preview]')!.textContent!);assert.equal(p.checkedAt,null);assert.equal(p.freshness,'unconfirmed');}finally{unknown.close();}
});
test('inspection error keeps safe HTTP evidence and unknown services; other errors never expose raw messages',async()=>{
 for(const error of [new BridgeInspectionError({checkedAt,code:'health_unreachable',reads:[{attempt:1,step:'health',httpStatus:null}],companion:null}),Error('fictional-token private-path private-title')]){
  const f=ui({lastInspection:()=>result(),inspectBridge:async()=>{throw error;}});try{f.click('detect-bridge');await tick();assert.equal(f.doc.querySelector('[data-settings-error]')!.hasAttribute('hidden'),false);f.click('view-diagnostic');const text=f.doc.querySelector('[data-diagnostic-preview]')!.textContent!,p=JSON.parse(text);assert.deepEqual(p.services,[]);assert.equal(p.checkedAt,error instanceof BridgeInspectionError?checkedAt:null);assert.equal(p.code,error instanceof BridgeInspectionError?'health_unreachable':null);assert.doesNotMatch(text+f.doc.querySelector('[data-settings-error]')!.textContent,/fictional-token|private-path|private-title/);}finally{f.close();}
 }
});
test('failed clipboard offers manual selection and preserves inspection',async()=>{
 const f=ui();try{Object.defineProperty(f.dom.window.navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw Error('fictional-token');}}});f.click('detect-bridge');await tick();f.click('view-diagnostic');const preview=f.doc.querySelector<HTMLElement>('[data-diagnostic-preview]')!,before=preview.textContent,label=f.doc.querySelector('[data-hermes-results-label]')!.textContent;f.click('copy-diagnostic');await tick();assert.match(f.doc.querySelector('[data-diagnostic-status]')!.textContent||'',/手动选择.*复制/);assert.equal(preview.textContent,before);assert.equal(f.doc.querySelector('[data-hermes-results-label]')!.textContent,label);assert.ok(preview.tabIndex>=0);}finally{f.close();}
});
for(const state of ['connected','auth_failed','expired'])test(`EKKO ${state} explains recorded expiry without treating it as live authentication`,async()=>{
 const now=Date.now(),expiresAt=Math.floor(now/1000)+(state==='expired'?-1:3*86400);
 const f=ui({checkEkko:async()=>({id:'fictional-account',deviceId:'fictional-device',accountUserId:7,accountName:'虚构账户',state:state==='connected'?'connected':'auth_failed',authorization:{source:'app-login-record',expiresAt}})});try{f.click('ekko');await tick();const status=f.doc.querySelector('[data-ekko-status]')!.textContent!,record=f.doc.querySelector('[data-ekko-authorization]')!.textContent!;assert.match(record,/签发记录/);assert.match(record,/核对时间/);if(state==='expired'){assert.match(status,/已过期，本次未验证服务认证/);assert.doesNotMatch(status,/已核对连接/);}else if(state==='auth_failed'){assert.match(status,/拒绝|暂不可用/);assert.doesNotMatch(status,/已核对连接/);}else assert.match(record,/七天|7 天/);assert.match(record,/不代表实时认证/);}finally{f.close();}
});
test('missing EKKO expiry and Hermes use explicit unknown expiry; static help cannot write or request',async()=>{
 const f=ui({checkEkko:async()=>null});try{assert.match(f.doc.querySelector('[data-hermes-authorization]')!.textContent||'',/有效期由原服务管理；当前未提供/);const before=f.requests();for(const key of ['companion','pairing','serve','studio','legacy-api','ekko']){f.click(`help-${key}`);assert.ok(f.doc.querySelector('[data-connection-help]')!.textContent!.length>20);assert.equal(f.doc.querySelector('[data-connection-help] a'),null);}assert.equal(f.requests(),before);assert.equal(f.writes(),0);f.click('ekko');await tick();assert.match(f.doc.querySelector('[data-ekko-authorization]')!.textContent||'',/未提供有效期/);}finally{f.close();}
});
test('actual plugin supplies manifest version and remembers read-only inspection as previous on reopen',async()=>{
 const f=await fixture({confirmed:false}),fetchBefore=globalThis.fetch;try{let requests=0,writes=0;globalThis.fetch=async u=>{requests++;return Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:[studio],meta:result().evidence.companion});};f.p.workHost.listNotebooks=async()=>[];const save=f.p.saveData.bind(f.p);f.p.saveData=async(k:string,v:any)=>{writes++;return save(k,v);};f.p.openSettings(f.root,'hermes');f.doc.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click();await tick();f.p.settingsDialog.close();f.p.openSettings(f.root,'hermes');assert.match(f.doc.querySelector('[data-hermes-results-label]')!.textContent||'',/上次检测/);let copied='';Object.defineProperty(f.dom.window.navigator,'clipboard',{value:{writeText:async(value:string)=>{copied=value;}}});f.doc.querySelector<HTMLButtonElement>('[data-settings-action="view-diagnostic"]')!.click();const text=f.doc.querySelector('[data-diagnostic-preview]')!.textContent!,p=JSON.parse(text);assert.equal(p.pluginVersion,JSON.parse(readFileSync(new URL('../plugin.json',import.meta.url),'utf8')).version);assert.equal(p.freshness,'previous');assert.ok(p.checkedAt);f.doc.querySelector<HTMLButtonElement>('[data-settings-action="copy-diagnostic"]')!.click();await tick();assert.equal(copied,text);assert.doesNotMatch(text,/fictional-token|private-profile|private-title|private-path/);assert.equal(requests,2);assert.equal(writes,0);}finally{globalThis.fetch=fetchBefore;f.close();}
});
test('write-unknown errors clear prior service evidence and expose only fixed save outcome',async()=>{
 const f=ui({lastInspection:()=>result(),connectBridge:async()=>{throw Object.assign(Error('fictional-token private-path'),{saveOutcome:'unknown'});}});try{f.click('confirm-bridge');await tick();f.click('view-diagnostic');const text=f.doc.querySelector('[data-diagnostic-preview]')!.textContent!,p=JSON.parse(text);assert.equal(p.saveOutcome,'unknown');assert.equal(p.checkedAt,null);assert.equal(p.bridgeAuthenticated,null);assert.equal(p.completed,false);assert.deepEqual(p.services,[]);assert.match(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/保存结果未知/);assert.doesNotMatch(text+f.doc.querySelector('[data-settings-error]')!.textContent,/fictional-token|private-path/);}finally{f.close();}
});
test('fresh opening does not imply an attempted save or uncertain write',()=>{
 const f=ui();try{assert.match(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/尚未检测/);assert.doesNotMatch(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/保存结果未知/);}finally{f.close();}
});
test('preview versions and capabilities are safe even when plugin and companion report hostile strings',async()=>{
 for(const pluginVersion of ['fictional-token','0.3.9\n','0.3.9\u2028']){
  const f=ui({pluginVersion:()=>pluginVersion});try{f.click('detect-bridge');await tick();f.click('view-diagnostic');const text=f.doc.querySelector('[data-diagnostic-preview]')!.textContent!;assert.equal(JSON.parse(text).pluginVersion,null);f.click('copy-diagnostic');await tick();assert.equal(f.copied(),text);assert.doesNotMatch(text,/fictional-token|private-profile|private-title|private-path/);}finally{f.close();}
 }
});

function settingsAction(f:Awaited<ReturnType<typeof fixture>>,action:string){f.doc.querySelector<HTMLButtonElement>(`[data-settings-action="${action}"]`)!.click();}
function settingsDiagnostic(f:Awaited<ReturnType<typeof fixture>>){settingsAction(f,'view-diagnostic');return JSON.parse(f.doc.querySelector('[data-diagnostic-preview]')!.textContent!);}
function assertUnknownWrite(f:Awaited<ReturnType<typeof fixture>>,hasNewRead=false){
 const diagnostic=settingsDiagnostic(f);
 assert.match(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/保存结果未知.*不要重复提交/);
 assert.equal(diagnostic.saveOutcome,'unknown');
 if(!hasNewRead){assert.equal(diagnostic.checkedAt,null);assert.equal(diagnostic.bridgeAuthenticated,null);assert.deepEqual(diagnostic.services,[]);assert.equal(f.doc.querySelector('[data-hermes-results]')!.children.length,0);}
 assert.doesNotMatch(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/fictional-disk-result-unknown/);
 return diagnostic;
}
for(const failure of ['write-throws','readback-throws'] as const)test(`actual ${failure} remains unknown after reopen and read-only checks until explicit verified confirmation`,async()=>{
 const f=await fixture(),fetchBefore=globalThis.fetch;
 try{
  let requests=0,writes=0,failed=false;const views=structuredClone(f.p.connectionViews),formal=structuredClone(await f.p.loadData('work-formal-v2')),save=f.p.saveData.bind(f.p),load=f.p.loadData.bind(f.p);
  globalThis.fetch=async url=>{requests++;return Response.json(String(url).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:views});};f.p.workHost.listNotebooks=async()=>[];
  f.p.openSettings(f.root,'hermes');settingsAction(f,'detect-bridge');await tick();
  f.p.saveData=async(key:string,value:any)=>{if(key==='settings')writes++;await save(key,value);if(key==='settings'&&failure==='write-throws'&&!failed){failed=true;throw Error('fictional-disk-result-unknown');}};
  f.p.loadData=async(key:string)=>{if(key==='settings'&&failure==='readback-throws'&&writes&&!failed){failed=true;throw Error('fictional-disk-result-unknown');}return load(key);};
  const settings=structuredClone(await load('settings'));settingsAction(f,'confirm-bridge');await tick();
  assert.equal(writes,1);assert.deepEqual(await load('settings'),settings,'write stays committed and is never rolled back');assertUnknownWrite(f);assert.deepEqual(f.p.connectionViews,views);assert.equal(f.input.value,'原 Chat 草稿');
  const beforeReopen=requests;f.p.settingsDialog.close();f.p.openSettings(f.root,'hermes');await tick();assertUnknownWrite(f);assert.equal(requests,beforeReopen);assert.equal(writes,1,'reopening never retries');
  settingsAction(f,'detect-bridge');await tick();const read=assertUnknownWrite(f,true);assert.equal(read.services.length,1);assert.ok(read.checkedAt);assert.equal(writes,1,'new read-only evidence cannot resolve an unknown write');
  f.p.settingsDialog.close();f.p.openSettings(f.root,'hermes');await tick();assertUnknownWrite(f,true);
  settingsAction(f,'confirm-bridge');await tick();const confirmed=settingsDiagnostic(f);assert.equal(writes,2);assert.equal(confirmed.saveOutcome,'saved');assert.ok(confirmed.checkedAt);assert.doesNotMatch(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/保存结果未知/);
  f.p.settingsDialog.close();f.p.openSettings(f.root,'hermes');await tick();assert.equal(settingsDiagnostic(f).saveOutcome,'saved');assert.deepEqual(await load('work-formal-v2'),formal);assert.equal(f.input.value,'原 Chat 草稿');
 }finally{globalThis.fetch=fetchBefore;f.close();}
});
for(const invalidation of ['page','candidate'] as const)test(`actual unknown write survives ${invalidation} invalidation without current-page evidence`,async()=>{
 const f=await fixture(),fetchBefore=globalThis.fetch;let release!:()=>void;
 try{
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve),views=structuredClone(f.p.connectionViews),save=f.p.saveData.bind(f.p);let writes=0;
  globalThis.fetch=async url=>Response.json(String(url).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:views});f.p.workHost.listNotebooks=async()=>[];
  f.p.saveData=async(key:string,value:any)=>{if(key==='settings'){writes++;await save(key,value);entered();await wait;throw Error('fictional-disk-result-unknown');}return save(key,value);};
  f.p.openSettings(f.root,'hermes');settingsAction(f,'confirm-bridge');await started;
  if(invalidation==='candidate'){const input=f.doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!;input.value='fictional-new-candidate';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));}else{f.p.settingsDialog.dispose();f.p.openSettings(f.root,'hermes');}
  release();await tick();f.p.settingsDialog.dispose();f.p.openSettings(f.root,'hermes');await tick();assertUnknownWrite(f);assert.equal(writes,1);assert.deepEqual(f.p.connectionViews,views);assert.equal(f.input.value,'原 Chat 草稿');
 }finally{release?.();globalThis.fetch=fetchBefore;f.close();}
});
for(const invalidation of ['page','candidate'] as const)test(`actual late ${invalidation} inspection cannot replace a newer verified saved report`,async()=>{
 const f=await fixture(),fetchBefore=globalThis.fetch;let release!:()=>void;
 try{
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve),views=structuredClone(f.p.connectionViews);let delayed=true;
  globalThis.fetch=async url=>{if(String(url).endsWith('/health')&&delayed){delayed=false;entered();await wait;}return Response.json(String(url).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:views});};f.p.workHost.listNotebooks=async()=>[];
  f.p.openSettings(f.root,'hermes');settingsAction(f,'detect-bridge');await started;
  if(invalidation==='candidate'){const input=f.doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!;input.value='fictional-later-candidate';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));}
  f.p.settingsDialog.dispose();f.p.openSettings(f.root,'hermes');settingsAction(f,'confirm-bridge');await tick();const before=settingsDiagnostic(f);assert.equal(before.saveOutcome,'saved');
  release();await tick();f.p.settingsDialog.close();f.p.openSettings(f.root,'hermes');const after=settingsDiagnostic(f);assert.equal(after.saveOutcome,'saved');assert.equal(after.checkedAt,before.checkedAt);assert.equal(after.freshness,'previous');assert.equal(after.services.length,1);assert.doesNotMatch(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/保存结果未知/);
 }finally{release?.();globalThis.fetch=fetchBefore;f.close();}
});
test('late unknown from an old committed scope restore cannot overwrite a newer verified confirmation',async()=>{
 const f=await fixture(),fetchBefore=globalThis.fetch;let release!:()=>void;
 try{
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve),list=f.p.workStore.listChats.bind(f.p.workStore),views=structuredClone(f.p.connectionViews);let delayed=true;
  f.p.workStore.listChats=async(id:string)=>{if(delayed){delayed=false;entered();await wait;}return list(id);};
  globalThis.fetch=async url=>Response.json(String(url).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:views});f.p.workHost.listNotebooks=async()=>[];
  f.p.openSettings(f.root,'hermes');f.doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!.value='fictional-committed-private-scope';settingsAction(f,'confirm-bridge');await started;
  assert.equal((await f.p.loadData('settings')).bridgeToken,'fictional-committed-private-scope');f.p.settingsDialog.dispose();f.p.openSettings(f.root,'hermes');settingsAction(f,'confirm-bridge');await tick();const before=settingsDiagnostic(f);assert.equal(before.saveOutcome,'saved');
  release();await tick();f.p.settingsDialog.close();f.p.openSettings(f.root,'hermes');const after=settingsDiagnostic(f);assert.equal(after.saveOutcome,'saved');assert.equal(after.checkedAt,before.checkedAt);assert.doesNotMatch(f.doc.querySelector('[data-bridge-status]')!.textContent||'',/保存结果未知/);
 }finally{release?.();globalThis.fetch=fetchBefore;f.close();}
});
test('a newer blocked check cannot erase the older pending write when it later becomes unknown',async()=>{
 const f=await fixture(),fetchBefore=globalThis.fetch;let release!:()=>void;
 try{
  let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve),wait=new Promise<void>(resolve=>release=resolve),save=f.p.saveData.bind(f.p),views=structuredClone(f.p.connectionViews);let writes=0;
  globalThis.fetch=async url=>Response.json(String(url).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:views});f.p.workHost.listNotebooks=async()=>[];
  f.p.saveData=async(key:string,value:any)=>{await save(key,value);if(key==='settings'){writes++;entered();await wait;throw Error('fictional-disk-result-unknown');}};
  f.p.openSettings(f.root,'hermes');settingsAction(f,'confirm-bridge');await started;f.p.settingsDialog.dispose();f.p.openSettings(f.root,'hermes');settingsAction(f,'detect-bridge');await tick();assert.equal(f.p.settingsDialog.isBusy,false);
  release();await tick();f.p.settingsDialog.close();f.p.openSettings(f.root,'hermes');await tick();assertUnknownWrite(f);assert.equal(writes,1);assert.deepEqual(f.p.connectionViews,views);
 }finally{release?.();globalThis.fetch=fetchBefore;f.close();}
});
