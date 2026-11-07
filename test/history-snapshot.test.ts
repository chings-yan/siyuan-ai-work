import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
// @ts-expect-error runtime module
import * as studio from '../scripts/studio-client.mjs';
// @ts-expect-error runtime module
import { createBridgeServer } from '../scripts/bridge.mjs';
// @ts-expect-error runtime module
import { createGatewayClient } from '../scripts/hermes-gateway-client.mjs';
// @ts-expect-error runtime module
import { captureHistorySnapshot, withSnapshotDeadline } from '../scripts/hermes-history-snapshot.mjs';
import { bridgeMessagesToChat, createBridgeClient } from '../src/bridge.ts';

const ROOT = '20990101000000-aaaaaaa', OTHER = '20990101000001-bbbbbbb', CAP = 'c'.repeat(64);
const row = (id:number, content='Answer', role='assistant') => ({ id, session_id:'session-1', role, content, timestamp:1 });
const page = (messages:any[], offset=0, total=messages.length, limit=200) => ({session:{id:'session-1',profile:'original'},messages,total,offset,limit,hasMore:offset+messages.length<total});
const strict = (fetchPage:any, extra:any={}) => studio.fetchStudioMessagesSnapshot({sessionId:'session-1',profile:'original',fetchPage,...extra});

test('strict Studio reader preserves stable IDs and exact order without content deduplication', async () => {
  const calls:number[]=[];
  const result=await strict(async (offset:number,limit:number)=>{calls.push(offset);assert.equal(limit,2);return offset===0?page([row(40),row(2)],0,3,2):page([row(19,'tool data','tool')],2,3,2);},{limit:2});
  assert.deepEqual(result.records.map((item:any)=>item.id),[40,2,19]);
  assert.deepEqual(calls,[0,2]);
});

const badPages:[string,(value:any)=>void][]=[
  ['missing session',p=>{delete p.session;}],['wrong session',p=>{p.session.id='elsewhere';}],
  ['missing profile',p=>{delete p.session.profile;}],['wrong profile',p=>{p.session.profile='elsewhere';}],
  ['string message ID',p=>{p.messages[0].id='1';}],['unsafe message ID',p=>{p.messages[0].id=Number.MAX_SAFE_INTEGER+1;}],
  ['zero message ID',p=>{p.messages[0].id=0;}],['missing row session',p=>{delete p.messages[0].session_id;}],
  ['wrong row session',p=>{p.messages[0].session_id='elsewhere';}],['unknown role',p=>{p.messages[0].role='mystery';}],
  ['non-string text',p=>{p.messages[0].content={text:'answer'};}],['missing total',p=>{delete p.total;}],
  ['fractional total',p=>{p.total=1.5;}],['missing offset',p=>{delete p.offset;}],['wrong offset',p=>{p.offset=1;}],
  ['missing limit',p=>{delete p.limit;}],['wrong limit',p=>{p.limit=199;}],['missing hasMore',p=>{delete p.hasMore;}],
  ['false completion',p=>{p.total=2;}],['false continuation',p=>{p.hasMore=true;}],
  ['duplicate IDs',p=>{p.messages.push({...p.messages[0]});p.total=2;}],
];
for(const [name,change] of badPages)test(`strict Studio reader rejects ${name} instead of claiming completeness`,async()=>{
  const value=page([row(1)]);change(value);
  await assert.rejects(()=>strict(async()=>value),{code:'history_snapshot_unverified'});
});
test('strict Studio reader rejects total/identity changes and duplicate IDs across pages',async()=>{
  for(const mode of ['total','profile','duplicate','short']){
    await assert.rejects(()=>strict(async(offset:number)=>{
      if(!offset)return page([row(1),row(2)],0,3,2);
      const result=page(mode==='short'?[]:[row(mode==='duplicate'?2:3)],2,mode==='total'?4:3,2);
      if(mode==='profile')result.session.profile='changed';return result;
    },{limit:2}),{code:'history_snapshot_unverified'});
  }
});
test('strict Studio reader page budget rejects an unfinished history',async()=>{
  await assert.rejects(()=>strict(async()=>page([row(1)],0,2,1),{limit:1,maxPages:1}),{code:'history_snapshot_unverified'});
});

async function fixture(options:any={}){
  const dir=await mkdtemp(join(tmpdir(),'history-snapshot-'));
  const bindingsFile=join(dir,'legacy.json'),bindingsV2File=join(dir,'v2.json'),tokenFile=join(dir,'token');
  const kind=options.kind||'studio';
  const binding={chatId:'chat-1',documentRootId:ROOT,connectionId:kind==='serve'?'serve-1':kind==='studio'?'studio-default':'legacy-api',kind,profile:'original',storedSessionId:'session-1',installId:kind==='serve'?'install-1':null,title:'Synthetic',state:options.state||'ready',anchor:options.anchor||null};
  await writeFile(bindingsFile,'{}');await writeFile(bindingsV2File,JSON.stringify({'chat-1':binding}));await writeFile(tokenFile,'synthetic-token');
  const calls:{path:string;method:string}[]=[];let historyReads=0;let latestSignal:AbortSignal|undefined;
  let statusReads=0;
  const fetchImpl=async(input:any,init:any={})=>{
    const url=new URL(input);calls.push({path:url.pathname,method:init.method||'GET'});latestSignal=init.signal;
    if(url.pathname==='/api/status')return Response.json({install_id:options.changedInstall||options.installChangesAfterRead&&++statusReads>1?'install-2':'install-1'});
    if(url.pathname.includes('/messages')){
      assert.equal(url.searchParams.get('profile'),'original');
      const count=++historyReads;
      if(options.onHistory)await options.onHistory({count,bindingsV2File,binding});
      if(options.response)return options.response({count,url,init});
      if(kind==='serve')return Response.json({session_id:'session-1',profile:'original',messages:[row(40),row(2,'same','user')],pagination:{offset:0,limit:500,order:'oldest',returned:2}});
      return Response.json(page([row(40),row(2,'same','user'),row(19,'hidden result','tool')]));
    }
    throw Error('Unexpected synthetic request');
  };
  const connections={defaultConnectionId:binding.connectionId,connections:[{id:binding.connectionId,kind,profile:'original',baseUrl:'http://127.0.0.1:9999/',tokenFile}]};
  const {server}=createBridgeServer({capability:CAP,bindingsFile,bindingsV2File,connections,studioToken:'synthetic-token',fetchImpl,snapshotTimeoutMs:options.timeoutMs??5000,
    gatewayFactory:({connection,token}:any)=>({...createGatewayClient({baseUrl:connection.baseUrl,profile:connection.profile,token,fetchImpl}),ping:async()=>({ok:true}),list:async()=>({sessions:[]})})});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  return {binding,calls,bindingsV2File,base,get signal(){return latestSignal;},get reads(){return historyReads;},
    call:(root=ROOT,cap=CAP,method='GET')=>fetch(`${base}/chats/chat-1/messages/snapshot`,{method,headers:{'X-Siyuan-Collab-Token':cap,'X-Siyuan-Document-Root':root}}),
    bytes:()=>Promise.all([readFile(bindingsFile,'utf8'),readFile(bindingsV2File,'utf8'),readFile(tokenFile,'utf8')]),
    close:async()=>{await new Promise<void>((resolve,reject)=>server.close((error?:Error)=>error?reject(error):resolve()));await rm(dir,{recursive:true,force:true});}};
}

for(const kind of ['serve','studio'])test(`${kind} snapshot preserves ordered message identities and all binding bytes`,async()=>{
  const f=await fixture({kind});try{
    const before=await f.bytes();const response=await f.call();assert.equal(response.status,200);
    const {snapshot}=await response.json();
    assert.deepEqual(snapshot,{schemaVersion:1,complete:true,completeness:'display-history',consistency:'two-complete-reads-match',source:{chatId:'chat-1',documentRootId:ROOT,connectionId:kind==='serve'?'serve-1':'studio-default',kind,profile:'original',storedSessionId:'session-1',installId:kind==='serve'?'install-1':null},messages:[{id:'40',role:'assistant',content:'Answer'},{id:'2',role:'user',content:'same'}]});
    assert.equal(f.reads,2);assert.deepEqual(await f.bytes(),before);assert.ok(f.calls.every(c=>c.method==='GET'));
  }finally{await f.close();}
});
test('snapshot requires pairing, original scope and exact binding before source reads',async()=>{
  const f=await fixture();try{
    const before=await f.bytes();assert.equal((await f.call(ROOT,'bad')).status,401);assert.equal((await f.call(OTHER)).status,403);assert.equal((await f.call(ROOT,CAP,'POST')).status,405);assert.equal(f.reads,0);assert.deepEqual(await f.bytes(),before);
  }finally{await f.close();}
});
test('creating and unknown bindings stay byte-identical instead of being recovered by a read',async()=>{
  for(const state of ['creating','unknown']){const f=await fixture({state});try{const before=await f.bytes();assert.equal((await f.call()).status,200);assert.deepEqual(await f.bytes(),before);}finally{await f.close();}}
});
test('Serve snapshots validate the existing anchor but never advance it',async()=>{
  const projected={role:'assistant',text:'Answer',timestamp:1,row_id:40};
  for(const valid of [true,false]){const f=await fixture({kind:'serve',anchor:{messageId:'40',sha256:valid?createHash('sha256').update(JSON.stringify(projected)).digest('hex'):'0'.repeat(64)}});try{
    const before=await f.bytes();const response=await f.call();assert.equal(response.status,valid?200:409);if(!valid)assert.equal((await response.json()).error.code,'history_anchor_mismatch');assert.deepEqual(await f.bytes(),before);
  }finally{await f.close();}}
});
test('legacy snapshot is unsupported without redirect, upstream read or migration',async()=>{
  const f=await fixture({kind:'legacy-api'});try{const before=await f.bytes();const response=await f.call();assert.equal(response.status,422);assert.equal((await response.json()).error.code,'history_snapshot_unsupported');assert.equal(response.redirected,false);assert.equal(f.calls.length,0);assert.deepEqual(await f.bytes(),before);}finally{await f.close();}
});
for(const kind of ['serve','studio'])test(`${kind} hidden tool-row changes invalidate the complete-read comparison`,async()=>{
  const f=await fixture({kind,response:({count}:any)=>{
    const messages=[row(40),row(19,`tool result ${count}`,'tool')];
    return Response.json(kind==='studio'?page(messages):{session_id:'session-1',profile:'original',messages,pagination:{offset:0,limit:500,order:'oldest',returned:2}});
  }});try{const before=await f.bytes();const response=await f.call();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'history_snapshot_changed');assert.deepEqual(await f.bytes(),before);}finally{await f.close();}
});
test('binding changes during snapshot cannot receive a cursor for the previous identity',async()=>{
  const f=await fixture({onHistory:async({count,bindingsV2File,binding}:any)=>{if(count===2)await writeFile(bindingsV2File,JSON.stringify({'chat-1':{...binding,storedSessionId:'changed'}}));}});
  try{const response=await f.call();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'history_snapshot_changed');assert.equal(JSON.parse(await readFile(f.bindingsV2File,'utf8'))['chat-1'].storedSessionId,'changed');}finally{await f.close();}
});
test('snapshot total deadline covers stalled bodies and never retries an authentication denial',async()=>{
  for(const mode of ['body','401']){const f=await fixture({timeoutMs:60,response:()=>mode==='body'?{ok:true,status:200,redirected:false,json:()=>new Promise(()=>{})}:new Response('{}',{status:401})});
    try{const before=await f.bytes();const started=Date.now();const response=await f.call();assert.equal(response.status,mode==='body'?504:503);assert.equal((await response.json()).error.code,mode==='body'?'history_snapshot_timeout':'history_snapshot_unverified');assert.ok(Date.now()-started<1000);assert.equal(f.reads,1);assert.equal(f.signal?.aborted,true);assert.deepEqual(await f.bytes(),before);}finally{await f.close();}}
});
test('client consumes an independently validated snapshot without losing stable IDs',async()=>{
  const f=await fixture();try{const client=createBridgeClient({bridgeUrl:f.base,capabilityToken:CAP},ROOT);const snapshot=await client.historySnapshotForChat('chat-1');assert.deepEqual(snapshot.messages.map(m=>m.id),['40','2']);assert.equal(snapshot.source.documentRootId,ROOT);}finally{await f.close();}
});
test('Serve installation change after the two reads invalidates the result without advancing its anchor',async()=>{
  const f=await fixture({kind:'serve',installChangesAfterRead:true});try{const before=await f.bytes();const response=await f.call();assert.equal(response.status,409);assert.equal((await response.json()).error.code,'install_changed');assert.deepEqual(await f.bytes(),before);}finally{await f.close();}
});
test('snapshot client cancellation covers response bodies and never dispatches when already cancelled',{timeout:1000},async()=>{
  const original=globalThis.fetch;let calls=0,requestSignal:AbortSignal|undefined;
  globalThis.fetch=async(_input,init)=>{calls++;requestSignal=init?.signal as AbortSignal;return {ok:true,json:()=>new Promise(()=>{})} as any;};
  try{
    const client=createBridgeClient({bridgeUrl:'http://127.0.0.1:9999',capabilityToken:CAP},ROOT);
    const controller=new AbortController();const pending=client.historySnapshotForChat('chat-1',controller.signal);controller.abort();
    await assert.rejects(()=>pending,{name:'AbortError'});assert.equal(requestSignal?.aborted,true);
    const before=calls;await assert.rejects(()=>client.historySnapshotForChat('chat-1',controller.signal),{name:'AbortError'});assert.equal(calls,before);
  }finally{globalThis.fetch=original;}
});

test('empty verified Studio history is complete, while all real roles retain their source classification',async()=>{
  assert.deepEqual(await strict(async()=>page([])),{records:[]});
  const f=await fixture({response:()=>Response.json(page([row(1,'system','system'),row(2,'tools','tool'),row(3,'commands','command'),row(4,'orchestration','moa'),row(5,'','assistant'),row(6,'same'),row(7,'same')]))});
  try{const {snapshot}=await(await f.call()).json();assert.deepEqual(snapshot.messages,[{id:'1',role:'system',content:'system'},{id:'5',role:'assistant',content:''},{id:'6',role:'assistant',content:'same'},{id:'7',role:'assistant',content:'same'}]);}finally{await f.close();}
});
test('the second read does not receive a fresh timeout budget',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let reads=0;let signal:AbortSignal;
  const pending=withSnapshotDeadline((current:AbortSignal)=>{signal=current;return captureHistorySnapshot({source:{},signal:current,verifyUnchanged:async()=>{},readComplete:async()=>{reads++;await new Promise(resolve=>setTimeout(resolve,80));return {records:[row(1)],messages:[{id:'1',role:'assistant',content:'Answer'}]};}});},120);
  const rejection=assert.rejects(()=>pending,{code:'history_snapshot_timeout'});
  try{assert.equal(reads,1);t.mock.timers.tick(80);await Promise.resolve();await Promise.resolve();assert.equal(reads,2);t.mock.timers.tick(40);await rejection;assert.equal(signal!.aborted,true);}finally{t.mock.timers.reset();}
});
test('redirected Studio replies are never treated as history from the approved source',async()=>{
  const f=await fixture({response:()=>({ok:true,status:200,redirected:true,json:()=>page([row(1)])})});
  try{const response=await f.call();assert.equal(response.status,503);assert.equal((await response.json()).error.code,'history_snapshot_unverified');assert.equal(f.reads,1);}finally{await f.close();}
});
test('Serve incomplete source identities and page envelopes cannot produce a complete snapshot',async()=>{
  for(const mutate of [
    (body:any)=>{body.profile='other';},(body:any)=>{body.session_id='other';},(body:any)=>{body.messages[0].id='1';},
    (body:any)=>{body.messages[0].role='unknown';},(body:any)=>{body.pagination.returned=0;},
  ]){const f=await fixture({kind:'serve',response:()=>{const body={session_id:'session-1',profile:'original',messages:[row(1)],pagination:{offset:0,limit:500,order:'oldest',returned:1}};mutate(body);return Response.json(body);}});
    try{const before=await f.bytes(),response=await f.call();assert.equal(response.status,503);assert.equal((await response.json()).error.code,'history_snapshot_unverified');assert.deepEqual(await f.bytes(),before);}finally{await f.close();}}
});
test('Studio compatibility history stays permissive without claiming snapshot completeness',async()=>{
  const result=await studio.fetchStudioMessagesPaginated({sessionId:'session-1',fetchPage:async()=>({messages:[{role:'assistant',content:'legacy body'}]})});
  assert.equal(result.messages[0].content,'legacy body');assert.equal(Object.hasOwn(result,'complete'),false);
});
test('legacy Serve history retains its original result shape unless snapshot records are requested',async()=>{
  const gateway=createGatewayClient({baseUrl:'http://127.0.0.1:9999/',token:'synthetic',profile:'original',fetchImpl:async()=>Response.json({session_id:'session-1',profile:'original',messages:[row(1)],pagination:{offset:0,limit:500,order:'oldest',returned:1}})});
  try{assert.deepEqual(await gateway.history('session-1'),{count:1,messages:[{role:'assistant',text:'Answer',timestamp:1,row_id:1}]});}finally{gateway.close();}
});

test('client refuses malformed source, incomplete proofs, duplicate IDs and non-display roles',async()=>{
  const original=globalThis.fetch;
  const bad:[string,(value:any)=>void][]=[
    ['root',v=>{v.source.documentRootId=OTHER;}],['chat',v=>{v.source.chatId='another';}],['profile',v=>{delete v.source.profile;}],
    ['install',v=>{v.source.installId=4;}],['kind',v=>{v.source.kind='legacy-api';}],['complete',v=>{v.complete=false;}],
    ['schema',v=>{v.schemaVersion=2;}],['proof',v=>{v.consistency='one-read';}],['scope',v=>{delete v.completeness;}],
    ['ID',v=>{v.messages[0].id=1;}],['unsafeID',v=>{v.messages[0].id='9007199254740992';}],['duplicate',v=>{v.messages.push({...v.messages[0]});}],
    ['tool',v=>{v.messages[0].role='tool';}],['content',v=>{v.messages[0].content=null;}],
  ];
  try{for(const [name,change] of bad){const snapshot:any={schemaVersion:1,complete:true,completeness:'display-history',consistency:'two-complete-reads-match',source:{chatId:'chat-1',documentRootId:ROOT,connectionId:'studio-default',kind:'studio',profile:'original',storedSessionId:'session-1',installId:null},messages:[{id:'1',role:'assistant',content:'answer'}]};change(snapshot);
    globalThis.fetch=async()=>Response.json({snapshot});const client=createBridgeClient({bridgeUrl:'http://127.0.0.1:9999',capabilityToken:CAP},ROOT);await assert.rejects(()=>client.historySnapshotForChat('chat-1'),{code:'history_snapshot_unverified'},name);
  }}finally{globalThis.fetch=original;}
});
test('elapsed synchronous body work cannot clear an already exhausted snapshot budget',async()=>{
  await assert.rejects(()=>withSnapshotDeadline(async()=>{const end=performance.now()+25;while(performance.now()<end){}return 'late success';},5),{code:'history_snapshot_timeout'});
});
test('snapshot client deadline covers a body that ignores cancellation',async t=>{
  const original=globalThis.fetch;let signal:AbortSignal|undefined,bodyStarted=false;
  t.mock.timers.enable({apis:['setTimeout']});
  globalThis.fetch=async(_input,init)=>{signal=init?.signal as AbortSignal;return {ok:true,json:()=>{bodyStarted=true;return new Promise(()=>{});}} as any;};
  try{const client=createBridgeClient({bridgeUrl:'http://127.0.0.1:9999',capabilityToken:CAP},ROOT);const pending=client.historySnapshotForChat('chat-1');const rejected=assert.rejects(()=>pending,{code:'history_snapshot_timeout'});await Promise.resolve();await Promise.resolve();assert.equal(bodyStarted,true);t.mock.timers.tick(10_000);await rejected;assert.equal(signal?.aborted,true);}finally{globalThis.fetch=original;t.mock.timers.reset();}
});
test('ordinary history projection retains exact unique remote IDs without inventing IDs for missing history',()=>{
  const projected=bridgeMessagesToChat([{id:'remote-a',role:'assistant',content:'answer'},{id:42,role:'user',content:'question'},{role:'assistant',content:'older response'},{id:'tool-row',role:'tool',content:'internal'}] as any);
  assert.deepEqual(projected,[{id:'remote-a',role:'assistant',content:'answer'},{id:'42',role:'user',content:'question'},{role:'assistant',content:'older response'}]);
});
test('ordinary history projection never promotes duplicate or invalid IDs into remote identity',()=>{
  const input:any[]=[{id:7,role:'assistant',content:'first'},{id:'7',role:'user',content:'second'},{id:'hidden-collision',role:'assistant',content:'third'},{id:'hidden-collision',role:'tool',content:'hidden'}];
  for(const id of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,{},null,'',' ','line\nbreak'])input.push({id,role:'assistant',content:'kept'});
  const projected=bridgeMessagesToChat(input);assert.equal(projected.length,input.length-1);assert.ok(projected.every(message=>!Object.hasOwn(message,'id')));assert.equal(projected[0].content,'first');
});
