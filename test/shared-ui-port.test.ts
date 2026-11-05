import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createChatShell} from '../src/ui.ts';
import {WorkService} from '../src/work/service.ts';
import {WorkStore} from '../src/work/store.ts';

test('shared shell offers home and readonly review without inline legacy settings',()=>{
 const doc=new JSDOM(createChatShell()).window.document;
 assert.ok(doc.querySelector('[data-work-action="home"]'));
 assert.ok(doc.querySelector('[data-action="review-send"]'));
 assert.equal(doc.querySelector('[data-action="save-settings"]'),null);
});
test('shared Work can be read with no optional goal',async()=>{
 const host:any={getAttrs:async()=>({'custom-ai-work-v0':'1'}),getChildren:async()=>[],getDocumentTitle:async()=>'Fictional work'};
 const service=new WorkService(host,new WorkStore({loadData:()=>undefined,saveData:()=>{}}));
 assert.equal((await service.readWork('20261008000000-abcdefg'))?.goal,'');
});

test('shared pairing authenticates connections without a document and separates offline selected service',async()=>{
 const {inspectLocalBridge}=await import('../src/work/connection-settings.ts');const paths:string[]=[];
 const fetcher:any=async(url:string)=>{paths.push(new URL(url).pathname);return Response.json(url.endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:[{id:'serve-local',kind:'serve',displayName:'Fictional serve',profile:'default',installId:'fictional-install',state:'offline'}]});};
 const result=await inspectLocalBridge({bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'fictional-token'},fetcher);
 assert.deepEqual(paths,['/health','/connections']);assert.equal(result.bridgeAuthenticated,true);assert.equal(result.hermesReady,false);
});

test('all shared Bridge fetch paths reject nonlocal destinations before sending credentials',async()=>{
 const {createBridgeClient}=await import('../src/bridge.ts');const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({data:[]});};
 try{const client=createBridgeClient({bridgeUrl:'http://not-local.example',capabilityToken:'fictional'},'20261008000000-abcdefg');for(const read of [()=>client.listConnections(),()=>client.streamChatForChat('local-chat','text',{},()=>{}),()=>client.streamChat('remote','text',{},()=>{})])await assert.rejects(read,/回环|本机/);assert.equal(calls,0);}finally{globalThis.fetch=original;}
});

for(const state of ['ready','offline','auth_failed','install_mismatch','incompatible'])test(`shared inspection distinguishes selected ${state} without switching connection`,async()=>{
 const {inspectLocalBridge}=await import('../src/work/connection-settings.ts');const views=[{id:'selected',kind:'serve',state,profile:'fictional-profile',installId:'fictional-install',displayName:'Fictional selected'},{id:'serve-local',kind:'serve',state:'ready',profile:'default',installId:'another-install',displayName:'Other'}];
 const result=await inspectLocalBridge({bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'fictional',selectedConnectionId:'selected'},async(u)=>Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:{data:views}));assert.equal(result.bridgeAuthenticated,true);assert.equal(result.hermesReady,state==='ready');if(state==='auth_failed'){assert.equal(result.message,'Bridge 已配对；原服务拒绝了授权，请核对原服务的授权设置');assert.doesNotMatch(result.message,/过期|到期/);}if(state==='install_mismatch')assert.match(result.message,/安装身份/);
});
for(const payload of [{data:[{id:'serve-local'}]},{data:[{id:'serve-local',kind:'serve',state:'ready',profile:'default',installId:null,displayName:'Missing identity'}]}])test('shared inspection rejects malformed connection identity',async()=>{
 const {inspectLocalBridge}=await import('../src/work/connection-settings.ts');const result=await inspectLocalBridge({bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'fictional'},async(u)=>Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:payload));assert.equal(result.bridgeAuthenticated,false);assert.equal(result.hermesReady,false);
});
