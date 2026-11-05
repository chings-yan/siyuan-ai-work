import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- Bridge runtime ESM module has no declaration.
import { createBridgeServer } from '../scripts/bridge.mjs';

const cap='c'.repeat(64), origin='http://127.0.0.1:6806', root='20260826094850-kronins';
const connection={connectionId:'conn-1',baseUrl:'http://127.0.0.1:8748',deviceId:'device-1',accountUserId:7,accountName:'测试用户',appConnectionId:4,token:'fictional-application-secret',expiresAt:Math.floor(Date.now()/1000)+3600};
const expectedHeaders={'X-Ekko-Connection-Id':'conn-1','X-Ekko-Device-Id':'device-1','X-Ekko-Account-User-Id':'7'};
for (const path of ['/ekko/rooms','/ekko/rooms/room-1','/ekko/rooms/room-1/events']) test(`old identity cannot read or subscribe ${path}`,async t=>{
 const h=await setup(t);h.setConnection({...connection,connectionId:'conn-B',accountUserId:8});
 const r=await h.request(path);assert.equal(r.status,403);assert.equal((await r.json()).error.code,'identity_changed');assert.equal(h.calls.length,0);
});
test('identity change during room read discards response',async t=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const h=await setup(t,{fetchImpl:async(url:URL)=>{if(url.pathname.includes('/rooms/room-1')){entered();await gate;}return undefined;}});
 const pending=h.request('/ekko/rooms/room-1');await started;h.setConnection({...connection,connectionId:'conn-B',accountUserId:8});release();
 const r=await pending;assert.equal(r.status,403);assert.equal((await r.json()).error.code,'identity_changed');
});
const message=(id:string)=>({id,roomId:'room-1',senderId:'auth:7',senderName:'测试用户',content:'虚构消息',timestamp:1,role:'user',mentions:[]});
class Socket extends EventEmitter {
 connected=true; sent:any[]=[]; disconnected=false; onMessage:(body:any,cb:any)=>void=(body,cb)=>cb({id:body.id});
 override emit(event:string,...args:any[]):boolean {
  if(event==='join'){args[1]({roomId:args[0].roomId,messages:[],agents:[],hasMore:false});return true;}
  if(event==='message'){this.sent.push(args[0]);this.onMessage(args[0],args[1]);return true;}
  return super.emit(event,...args);
 }
 disconnect(){this.disconnected=true;super.emit('disconnect','transport close');}
 server(event:string,value:any){super.emit(event,value);}
}
async function setup(t:any,options:any={}) {
 const dir=options.dir || await mkdtemp(join(tmpdir(),'ekko-routes-'));
 let saved:any=options.missing?null:{...connection};const socket=new Socket();const calls:string[]=[];let history:any[]=[];
 const fetchImpl=async(raw:string,init:any={})=>{
  const url=new URL(raw);calls.push(url.pathname+url.search);
  if(options.fetchImpl){const answer=await options.fetchImpl(url,init);if(answer)return answer;}
  if(url.pathname==='/api/auth/app-login'){const input=JSON.parse(init.body);return Response.json({token:connection.token,userId:7,appConnection:{id:4,device_code:input.device_code,token_expires_at:connection.expiresAt}});}
  if(url.pathname==='/api/auth/me')return Response.json({user:{id:7,username:'测试用户'}});
  if(url.pathname==='/api/devices/link-info')return Response.json({device_id:'device-1'});
  if(url.pathname==='/api/studio/group-chat/rooms')return Response.json({rooms:[{id:'room-1',name:'测试房间',token:connection.token,path:'C:/private/file'}],total:1,hasMore:false});
  if(url.pathname.startsWith('/api/studio/group-chat/rooms/'))return Response.json({room:{id:'room-1',name:'测试房间',password:'hidden'},messages:history,agents:[],hasMore:false});
  if(url.pathname==='/api/sessions')return Response.json({data:[{id:'legacy-1',title:`siyuan:${root}:旧会话`},{id:'foreign',title:'其他文档'}]});
  if(url.pathname.startsWith('/api/studio/sessions'))return Response.json({sessions:[],hasMore:false});
  throw new Error('Unexpected fake URL');
 };
 const authStore={read:async()=>saved,write:async(value:any)=>{saved=value;}};
 const {server}=createBridgeServer({capability:cap,studioToken:'fictional-studio',bindingsFile:join(dir,'bindings.json'),fetchImpl,ekko:{authStore,fetchImpl,socketFactory:()=>socket,pendingDirectory:join(dir,'pending')}});
 const stop=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
 t.after(async()=>{await stop();if(!options.dir)await rm(dir,{recursive:true,force:true});});
 let url='';
 const portProbe=options.portProbe || ((address:string)=>fetch(address,{signal:AbortSignal.timeout(2000)}));
 for(let attempt=0;attempt<5;attempt++) {
  await new Promise<void>((resolve,reject)=>{
   server.once('error',reject);
   server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});
  });
  url=`http://127.0.0.1:${server.address().port}`;
  try {
   // An OS-assigned ephemeral port can still be forbidden by Node fetch.
   // Probe only health before business requests; consume the response body.
   const response=await portProbe(url+'/health');
   assert.equal(response.status,200);await response.arrayBuffer();break;
  } catch(error) {
   await stop();
   if(!(error instanceof TypeError && error.cause instanceof Error && error.cause.message==='bad port') || attempt===4)throw error;
  }
 }
 const request=(path:string,init:any={})=>fetch(url+path,{...init,headers:{Origin:origin,'X-Siyuan-Collab-Token':cap,...expectedHeaders,...init.headers}});
 const send=(id='client-1',content='你好')=>request('/ekko/rooms/room-1/messages',{method:'POST',headers:{'X-Siyuan-Document-Root':root},body:JSON.stringify({clientMessageId:id,content,mentions:[]})});
 return {dir,url,request,send,socket,calls,stop,setHistory:(value:any[])=>{history=value;},saved:()=>saved,setConnection:(value:any)=>{saved=value;}};
}

test('EKKO reads require Bridge capability and allowed Origin but no document root',async t=>{
 const h=await setup(t);
 assert.equal((await fetch(h.url+'/ekko/connection',{headers:{Origin:origin}})).status,401);
 assert.equal((await h.request('/ekko/connection',{headers:{Origin:'http://evil.invalid'}})).status,403);
 assert.equal(h.calls.length,0);
 const r=await h.request('/ekko/connection');assert.equal(r.status,200);
 assert.deepEqual(await r.json(),{connection:{id:'conn-1',deviceId:'device-1',accountUserId:7,accountName:'测试用户',state:'connected',authorization:{source:'app-login-record',expiresAt:connection.expiresAt}}});
});
test('expired authorization record is projected without upstream authentication',async t=>{
 const h=await setup(t);const expiresAt=Math.floor(Date.now()/1000)-60;h.setConnection({...connection,expiresAt});
 const r=await h.request('/ekko/connection');assert.equal(r.status,200);
 assert.deepEqual((await r.json()).connection,{id:'conn-1',deviceId:'device-1',accountUserId:7,accountName:'测试用户',state:'expired',authorization:{source:'app-login-record',expiresAt}});
 assert.equal(h.calls.length,0);
});
test('invalid expiry records omit only authorization metadata',async t=>{
 const h=await setup(t);
 for(const expiresAt of [undefined,null,0,-1,1.5,'1800000000',NaN,Infinity,Number.MAX_SAFE_INTEGER+1,Number.MAX_SAFE_INTEGER,8_640_000_000_001]) {
  h.setConnection({...connection,expiresAt});const r=await h.request('/ekko/connection');assert.equal(r.status,200);
  const body=await r.json();assert.equal(body.connection.authorization,undefined,`Invalid expiry ${String(expiresAt)}`);
  assert.equal(body.connection.id,'conn-1');assert.equal(body.connection.state,(expiresAt as any)<=Math.floor(Date.now()/1000)?'expired':'connected');
 }
 h.setConnection({...connection,expiresAt:8_640_000_000_000});
 assert.deepEqual((await (await h.request('/ekko/connection')).json()).connection.authorization,{source:'app-login-record',expiresAt:8_640_000_000_000});
});
test('missing connection is explicit and pair never exposes or stores its password',async t=>{
 const h=await setup(t,{missing:true});assert.deepEqual(await (await h.request('/ekko/connection')).json(),{connection:null});
 const r=await h.request('/ekko/pair',{method:'POST',body:JSON.stringify({baseUrl:connection.baseUrl,username:'测试用户',password:'fictional-password'})});
 assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes('fictional'));assert.equal(JSON.parse(text).connection.authorization,undefined);assert.ok(!JSON.stringify(h.saved()).includes('fictional-password'));
 assert.equal(h.calls.filter(x=>x==='/api/auth/app-login').length,1);
});
test('pairing uncertainty returns safe Task 1 state without retry',async t=>{
 const logs:string[]=[];t.mock.method(console,'log',(...args:any[])=>logs.push(args.map(String).join(' ')));
 const diagnostic=process.env.SIYUAN_BRIDGE_DIAGNOSTICS;process.env.SIYUAN_BRIDGE_DIAGNOSTICS='1';
 t.after(()=>{if(diagnostic===undefined)delete process.env.SIYUAN_BRIDGE_DIAGNOSTICS;else process.env.SIYUAN_BRIDGE_DIAGNOSTICS=diagnostic;});
 const h=await setup(t,{fetchImpl:(url:URL)=>{if(url.pathname==='/api/auth/app-login')throw new Error('fictional-password '+connection.token+' C:/private/file');}});
 const r=await h.request('/ekko/pair',{method:'POST',body:JSON.stringify({baseUrl:connection.baseUrl,username:'user',password:'fictional-password'})});
 assert.equal(r.status,409);const body=await r.json();assert.equal(body.error.code,'ekko_pairing_unresolved');assert.ok(!JSON.stringify(body).includes('fictional'));assert.ok(!JSON.stringify(body).includes('C:/'));
 assert.equal(h.calls.filter(x=>x==='/api/auth/app-login').length,1);
 assert.ok(logs.length>0);assert.ok(!logs.join('').includes('fictional'));assert.ok(!logs.join('').includes('C:/private'));
});
test('room reads filter fields and validate room IDs and pagination before upstream',async t=>{
 const h=await setup(t);const rooms=await (await h.request('/ekko/rooms?offset=1&limit=2')).json();
 assert.deepEqual(rooms,{rooms:[{id:'room-1',name:'测试房间'}],total:1,hasMore:false});
 h.setHistory([{...message('m1'),token:connection.token,path:'C:/private/file'}]);
 const result=await (await h.request('/ekko/rooms/room-1?before=m2&limit=1')).json();assert.equal(result.messages[0].content,'虚构消息');assert.equal(result.room.password,undefined);assert.equal(result.messages[0].token,undefined);
 const count=h.calls.length;
 for(const path of ['/ekko/rooms/'+ 'a'.repeat(161),'/ekko/rooms/room%2F1','/ekko/rooms?limit=51','/ekko/rooms/room-1?before='+ 'a'.repeat(161)])assert.equal((await h.request(path)).status,400);
 assert.equal(h.calls.length,count);
});
test('message POST requires valid document root and bounded body and IDs',async t=>{
 const h=await setup(t);
 for(const headers of [{},{'X-Siyuan-Document-Root':'bad'}])assert.equal((await h.request('/ekko/rooms/room-1/messages',{method:'POST',headers,body:'{}'})).status,403);
 assert.equal((await h.send('bad/id')).status,400);
 assert.equal((await h.send('client-1','x'.repeat(120001))).status,413);
 assert.equal((await h.request('/ekko/pair',{method:'POST',body:'x'.repeat(500001)})).status,413);
 assert.equal(h.socket.sent.length,0);assert.equal(h.calls.length,0);
});
test('unknown ACK is checked by history and duplicate client ID never sends twice',async t=>{
 const h=await setup(t);h.socket.onMessage=(_body,cb)=>cb({error:'fictional-secret'});
 assert.deepEqual(await (await h.send()).json(),{state:'unknown'});
 h.setHistory([message('client-1')]);
 assert.deepEqual(await (await h.request('/ekko/rooms/room-1/send-status/client-1')).json(),{state:'sent',messageId:'client-1'});
 assert.deepEqual(await (await h.send()).json(),{state:'sent',messageId:'client-1'});assert.equal(h.socket.sent.length,1);
});
test('concurrent identical IDs claim once and persistent claims survive handler restart',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'ekko-restart-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const h=await setup(t,{dir});h.socket.onMessage=(_body,cb)=>setTimeout(()=>cb({error:'lost ACK'}),30);
 const responses=await Promise.all([h.send(),h.send()]);for(const r of responses)assert.equal(r.status,200);assert.equal(h.socket.sent.length,1);
 const files=await readdir(join(dir,'pending'),{recursive:true});let record='';for(const file of files)if(file.endsWith('.json'))record+=await readFile(join(dir,'pending',file),'utf8');
 assert.deepEqual(JSON.parse(record),{id:'client-1',roomId:'room-1',state:'unknown'});assert.ok(!record.includes('你好'));assert.ok(!record.includes(connection.token));
 await h.stop();const restarted=await setup(t,{dir});assert.deepEqual(await (await restarted.send()).json(),{state:'unknown'});assert.equal(restarted.socket.sent.length,0);
});
test('durable record failure prevents any socket message',async t=>{
 const h=await setup(t);await writeFile(join(h.dir,'pending'),'not-a-directory');
 const r=await h.send();assert.equal(r.status,503);assert.equal(h.socket.sent.length,0);assert.ok(!(await r.text()).includes(h.dir));
});
test('SSE emits only room events and disconnect state, strips secret fields and closes Socket',async t=>{
 const h=await setup(t);const controller=new AbortController();
 const response=await h.request('/ekko/rooms/room-1/events',{signal:controller.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type')!,/text\/event-stream/);
 const reader=response.body!.getReader();let text='';
 h.socket.server('message',{...message('sse-1'),token:connection.token,internalPath:'C:/private/file'});
 h.socket.emit('message_stream_delta',{roomId:'room-1',id:'sse-2',delta:'你好',password:'fictional-password'});
 h.socket.emit('disconnect',connection.token+' C:/private/file');
 while(!text.includes('room.disconnected')){const chunk=await reader.read();text+=new TextDecoder().decode(chunk.value);}
 assert.match(text,/event: room.message/);assert.match(text,/event: room.stream/);assert.ok(!text.includes('fictional'));assert.ok(!text.includes('C:/private'));
 controller.abort();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(h.socket.disconnected,true);
});
test('old sessions and Studio routes retain scope and results with EKKO mounted',async t=>{
 const h=await setup(t);
 assert.equal((await h.request('/sessions')).status,403);
 const legacy=await h.request('/sessions',{headers:{'X-Siyuan-Document-Root':root}});assert.equal(legacy.status,200);assert.deepEqual((await legacy.json()).data,[{id:'legacy-1',title:`siyuan:${root}:旧会话`}]);
 assert.deepEqual(await (await h.request('/studio/sessions',{headers:{'X-Siyuan-Document-Root':root}})).json(),{data:[]});
 assert.equal((await h.request('/ekko/not-a-route',{headers:{'X-Siyuan-Document-Root':root}})).status,404);
});
test('every EKKO route rejects missing capability and hostile Origin before contacting EKKO',async t=>{
 const h=await setup(t);
 for(const [method,path] of [['GET','/ekko/connection'],['POST','/ekko/pair'],['GET','/ekko/rooms'],['GET','/ekko/rooms/room-1'],['GET','/ekko/rooms/room-1/events'],['POST','/ekko/rooms/room-1/messages'],['GET','/ekko/rooms/room-1/send-status/client-1']]) {
  assert.equal((await fetch(h.url+path,{method,headers:{Origin:origin}})).status,401);
  assert.equal((await h.request(path,{method,headers:{Origin:'http://evil.invalid'}})).status,403);
 }
 assert.equal(h.calls.length,0);assert.equal(h.socket.sent.length,0);
});
test('connection identity drift and revoked access prevent room sends',async t=>{
 for(const mode of ['identity','revoked']) {
  const h=await setup(t,{fetchImpl:(url:URL)=>url.pathname==='/api/auth/me' ? mode==='identity'?Response.json({user:{id:8,username:'other'}}):new Response('{}',{status:401}):undefined});
  const status=await (await h.request('/ekko/connection')).json();assert.equal(status.connection.state,mode==='identity'?'identity_changed':'access_denied');
  assert.deepEqual(status.connection.authorization,{source:'app-login-record',expiresAt:connection.expiresAt});
  assert.equal((await h.send()).status,403);assert.equal(h.socket.sent.length,0);
 }
});
test('duplicate client ID cannot move to another room and unrecognized send status only reads history',async t=>{
 const h=await setup(t);await h.send();
 const conflict=await h.request('/ekko/rooms/room-2/messages',{method:'POST',headers:{'X-Siyuan-Document-Root':root},body:JSON.stringify({clientMessageId:'client-1',content:'test',mentions:[]})});
 assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,'message_id_conflict');
 assert.deepEqual(await (await h.request('/ekko/rooms/room-1/send-status/not-submitted')).json(),{state:'unknown'});assert.equal(h.socket.sent.length,1);
});
test('malformed upstream room totals never bypass the response field filter',async t=>{
 const h=await setup(t,{fetchImpl:(url:URL)=>url.pathname==='/api/studio/group-chat/rooms'?Response.json({rooms:[],total:{internalPath:'C:/private/file',password:'fictional-password'},hasMore:false}):undefined});
 const response=await h.request('/ekko/rooms');assert.equal(response.status,503);const text=await response.text();assert.ok(!text.includes('fictional-password'));assert.ok(!text.includes('C:/private'));
});
test('HTTP fixture rebinds after fetch rejects a bad port and serves the routes',async t=>{
 const probes:string[]=[];
 const h=await setup(t,{portProbe:async(url:string)=>{
  probes.push(url);
  // Port 1 is rejected by the real fetch implementation before any network I/O.
  return fetch(probes.length===1?'http://127.0.0.1:1/health':url);
 }});
 assert.ok(probes.length>=2 && probes.length<=5);
 assert.equal((await h.request('/ekko/connection')).status,200);
});
test('HTTP fixture surfaces non-port fetch failures without rebinding',async t=>{
 const failure=new TypeError('fetch failed',{cause:new Error('connection failed')});let probes=0;
 await assert.rejects(setup(t,{portProbe:async()=>{probes++;throw failure;}}),error=>error===failure);
 assert.equal(probes,1);
});
test('HTTP fixture stops after five bad-port bind attempts',async t=>{
 let probes=0;
 await assert.rejects(setup(t,{portProbe:async()=>{probes++;return fetch('http://127.0.0.1:1/health');}}),error=>error instanceof TypeError && error.cause instanceof Error && error.cause.message==='bad port');
 assert.equal(probes,5);
});
test('account paired during delayed preparation is rejected before any message claim or socket send',async t=>{
 const h=await setup(t,{fetchImpl:(url:URL)=>url.pathname==='/api/auth/me'?Response.json({user:{id:8,username:'new-account'}}):undefined});let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const request=(async()=>{await gate;return h.send();})();
 h.setConnection({...connection,connectionId:'conn-2',accountUserId:8});release();
 const response=await request;assert.equal(response.status,403);assert.equal((await response.json()).error.code,'identity_changed');
 assert.equal(h.calls.length,0);assert.equal(h.socket.sent.length,0);
 await assert.rejects(readdir(join(h.dir,'pending')),{code:'ENOENT'});
});
test('old pending status cannot resolve with a newly paired account and each identity field is required',async t=>{
 const h=await setup(t);h.socket.onMessage=(_body,cb)=>cb({error:'lost ACK'});await h.send();
 h.setHistory([message('client-1')]);
 for(const changed of [{...connection,connectionId:'conn-2'},{...connection,deviceId:'device-2'},{...connection,accountUserId:8}]){
  h.setConnection(changed);const before=h.calls.length;
  const response=await h.request('/ekko/rooms/room-1/send-status/client-1');
  assert.equal(response.status,403);assert.equal((await response.json()).error.code,'identity_changed');assert.equal(h.calls.length,before);
 }
 h.setConnection(connection);
 for(const field of Object.keys(expectedHeaders))for(const path of ['/ekko/rooms/room-1/messages','/ekko/rooms/room-1/send-status/client-1']){
  const response=await h.request(path,{method:path.endsWith('/messages')?'POST':'GET',headers:{[field]:'','X-Siyuan-Document-Root':root},...(path.endsWith('/messages')?{body:JSON.stringify({clientMessageId:'new-id',content:'test',mentions:[]})}:{})});
  assert.equal(response.status,400);assert.equal((await response.json()).error.code,'expected_identity_invalid');
 }
 assert.equal(h.socket.sent.length,1);
});
test('accepted request captures identity before asynchronous upstream verification',async t=>{
 let entered!:()=>void,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
 const h=await setup(t,{fetchImpl:async(url:URL)=>{if(url.pathname==='/api/auth/me'){entered();await gate;}return undefined;}});
 const sending=h.send();await started;h.saved().accountUserId=8;release();
 const response=await sending;assert.equal(response.status,200);assert.deepEqual(await response.json(),{state:'sent',messageId:'client-1'});assert.equal(h.socket.sent.length,1);
});
test('successful pairing terminates existing SSE before an old view can reconnect',async t=>{
 let pairing=false;
 const h=await setup(t,{fetchImpl:(url:URL,init:any)=>{
  if(url.pathname==='/api/auth/app-login'){pairing=true;const input=JSON.parse(init.body);return Response.json({token:connection.token,userId:8,appConnection:{id:5,device_code:input.device_code,token_expires_at:connection.expiresAt}});}
  if(pairing && url.pathname==='/api/auth/me')return Response.json({user:{id:8,username:'账号B'}});
 }});const controller=new AbortController();t.after(()=>controller.abort());
 const response=await h.request('/ekko/rooms/room-1/events',{signal:controller.signal});assert.equal(response.status,200);
 const stream=response.text();
 const paired=await h.request('/ekko/pair',{method:'POST',body:JSON.stringify({baseUrl:connection.baseUrl,username:'测试用户',password:'fictional-password'})});assert.equal(paired.status,200);
 assert.match(await stream,/identity_changed/);
 const again=await h.request('/ekko/rooms/room-1/events');assert.equal(again.status,403);assert.equal((await again.json()).error.code,'identity_changed');
 assert.equal(h.socket.disconnected,true);
});
for(const path of ['/ekko/rooms','/ekko/rooms/room-1','/ekko/rooms/room-1/events'])test(`missing expected identity rejected ${path}`,async t=>{
 const h=await setup(t);const r=await h.request(path,{headers:{'X-Ekko-Connection-Id':''}});assert.equal(r.status,400);assert.equal((await r.json()).error.code,'expected_identity_invalid');assert.equal(h.calls.length,0);
});
test('same identity token renewal closes stream without identity_changed',async t=>{
 const h=await setup(t);const controller=new AbortController();t.after(()=>controller.abort());
 const stream=await h.request('/ekko/rooms/room-1/events',{signal:controller.signal});assert.equal(stream.status,200);const text=stream.text();
 const paired=await h.request('/ekko/pair',{method:'POST',body:JSON.stringify({baseUrl:connection.baseUrl,username:'测试用户',password:'fictional-password'})});assert.equal(paired.status,200);assert.equal((await paired.json()).connection.id,connection.connectionId);
 const events=await text;assert.doesNotMatch(events,/identity_changed/);assert.match(events,/room.disconnected/);
});
test('same identity renewal during SSE startup is transient, not identity change',async t=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);
 const h=await setup(t,{fetchImpl:async(url:URL)=>{if(url.pathname.includes('/rooms/room-1')){entered();await gate;}return undefined;}});
 const pending=h.request('/ekko/rooms/room-1/events');await started;
 const paired=await h.request('/ekko/pair',{method:'POST',body:JSON.stringify({baseUrl:connection.baseUrl,username:'测试用户',password:'fictional-password'})});assert.equal(paired.status,200);release();
 const response=await pending;assert.equal(response.status,503);assert.notEqual((await response.json()).error.code,'identity_changed');
});

// An invalid optional flag must not collapse into the meaning of a genuinely missing flag.
const { roomMessageView: projectedFlagPresentation } = await import('../src/ekko/presentation.ts');
const flagProjectionCases = [
  { name: 'missing', own: false, value: undefined, expected: undefined, presentation: 'result' },
  { name: 'false', own: true, value: false, expected: false, presentation: 'result' },
  { name: 'true', own: true, value: true, expected: true, presentation: 'waiting' },
  { name: 'null', own: true, value: null, expected: null, presentation: 'reply' },
  { name: 'undefined', own: true, value: undefined, expected: null, presentation: 'reply' },
  { name: 'object', own: true, value: { privateMarker: 'must-not-appear-in-flag' }, expected: null, presentation: 'reply' },
  { name: 'array', own: true, value: ['must-not-appear-in-flag'], expected: null, presentation: 'reply' },
  { name: 'wrong-string', own: true, value: 'false', expected: 'false', presentation: 'reply' },
  { name: 'wrong-number', own: true, value: 0, expected: 0, presentation: 'reply' },
] as const;
const projectionToolMessage = (id: string) => ({ ...message(id), senderId: 'agent-one', senderName: '虚构助手', role: 'tool',
  content: ' \r\nfictional SQL rows\r\n', privateMetadata: 'must-not-appear-in-message' });
for (const scenario of flagProjectionCases) test(`flag projection history preserves ${scenario.name} flag presence without leaking invalid details`, async t => {
  const input = { ...projectionToolMessage('flag-history-' + scenario.name), ...(scenario.own ? { isStreaming: scenario.value } : {}) };
  const h = await setup(t, { fetchImpl: (url: URL) => {
    if (!url.pathname.startsWith('/api/studio/group-chat/rooms/')) return undefined;
    const payload = { room: { id: 'room-1', name: '测试房间' }, messages: [input], agents: [], hasMore: false };
    const response = Response.json(payload);
    // JSON cannot carry own undefined; a controlled decoder double exercises that defensive projection case.
    Object.defineProperty(response, 'json', { value: async () => payload }); return response;
  } });
  const response = await h.request('/ekko/rooms/room-1'); assert.equal(response.status, 200);
  const text = await response.text(); const projected = JSON.parse(text).messages[0];
  assert.equal(Object.hasOwn(projected, 'isStreaming'), scenario.own, scenario.name);
  if (scenario.own) assert.equal(projected.isStreaming, scenario.expected);
  assert.equal(projectedFlagPresentation(projected, [{ agentId: 'agent-one' }])?.presentation, scenario.presentation);
  assert.deepEqual(projected, { id: input.id, roomId: 'room-1', senderId: 'agent-one', senderName: '虚构助手',
    content: ' \r\nfictional SQL rows\r\n', timestamp: 1, role: 'tool', mentions: [], preservesStreamingFlagPresence: true, ...(scenario.own ? { isStreaming: scenario.expected } : {}) });
  assert.doesNotMatch(text, /must-not-appear-in-flag|must-not-appear-in-message/);
  assert.equal(Object.hasOwn(input, 'isStreaming'), scenario.own); if (scenario.own) assert.equal(input.isStreaming, scenario.value);
  assert.equal(h.socket.sent.length, 0);
});
for (const scenario of flagProjectionCases) test(`flag projection live SSE preserves ${scenario.name} lifecycle and safe invalid presence`, async t => {
  const h = await setup(t); const controller = new AbortController(); t.after(() => controller.abort());
  const response = await h.request('/ekko/rooms/room-1/events', { signal: controller.signal }); assert.equal(response.status, 200);
  const input = { ...projectionToolMessage('flag-sse-' + scenario.name), ...(scenario.own ? { isStreaming: scenario.value } : {}),
    ...(scenario.value === true ? { preservesStreamingFlagPresence: true } : {}) };
  const reader = response.body!.getReader(); h.socket.server('message', input);
  let text = ''; while (!text.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += new TextDecoder().decode(chunk.value); }
  const frame = text.split('\n\n').find(value => value.includes('\ndata: '))!;
  const event = frame.split('\n').find(line => line.startsWith('event: '))!.slice(7);
  const projected = JSON.parse(frame.split('\n').find(line => line.startsWith('data: '))!.slice(6));
  assert.equal(event, scenario.value === true ? 'room.stream' : 'room.message');
  assert.equal(Object.hasOwn(projected, 'isStreaming'), scenario.own, scenario.name);
  if (scenario.own) assert.equal(projected.isStreaming, scenario.expected);
  for (const key of ['id', 'roomId', 'senderId', 'senderName', 'content', 'timestamp', 'role'] as const) assert.equal(projected[key], input[key]);
  if (event === 'room.message') {
    assert.equal(projected.preservesStreamingFlagPresence, true);
    assert.deepEqual(projected.mentions, []);
    assert.equal(projectedFlagPresentation(projected, [{ agentId: 'agent-one' }])?.presentation, scenario.presentation);
  }
  else { assert.equal(projected.type, 'message_stream_snapshot'); assert.equal(Object.hasOwn(projected, 'preservesStreamingFlagPresence'), false); }
  assert.doesNotMatch(text, /must-not-appear-in-flag|must-not-appear-in-message/);
  assert.equal(Object.hasOwn(input, 'isStreaming'), scenario.own); if (scenario.own) assert.equal(input.isStreaming, scenario.value);
  assert.equal(h.socket.sent.length, 0); controller.abort();
});

const capabilityProjectionCases = [
  { name: 'tool-missing-upstream-marker', role: 'tool', marker: undefined, own: false, expected: true },
  { name: 'tool-forged-false', role: 'tool', marker: false, own: true, expected: true },
  { name: 'tool-forged-object', role: 'tool', marker: { secret: 'must-not-leak-capability-object' }, own: true, expected: true },
  { name: 'assistant-forged-true', role: 'assistant', marker: true, own: true, expected: false },
  { name: 'user-forged-object', role: 'user', marker: { secret: 'must-not-leak-capability-object' }, own: true, expected: false },
] as const;
for (const transport of ['history', 'live-SSE'] as const) for (const scenario of capabilityProjectionCases) {
  test(`Bridge capability projection ${transport} ${scenario.name} is generated locally without upstream identity claims`, async t => {
    const input = { ...projectionToolMessage('capability-' + scenario.name), role: scenario.role,
      ...(scenario.own ? { preservesStreamingFlagPresence: scenario.marker } : {}) };
    const h = await setup(t); let text: string; let projected: any;
    if (transport === 'history') {
      h.setHistory([input]); const response = await h.request('/ekko/rooms/room-1'); assert.equal(response.status, 200);
      text = await response.text(); projected = JSON.parse(text).messages[0];
    } else {
      const controller = new AbortController(); t.after(() => controller.abort());
      const response = await h.request('/ekko/rooms/room-1/events', { signal: controller.signal }); assert.equal(response.status, 200);
      const reader = response.body!.getReader(); h.socket.server('message', input); text = '';
      while (!text.includes('\n\n')) { const chunk = await reader.read(); assert.equal(chunk.done, false); text += new TextDecoder().decode(chunk.value); }
      assert.match(text, /event: room.message/); projected = JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6)); controller.abort();
    }
    assert.equal(Object.hasOwn(projected, 'preservesStreamingFlagPresence'), scenario.expected);
    if (scenario.expected) assert.equal(projected.preservesStreamingFlagPresence, true);
    assert.equal(Object.hasOwn(projected, 'isStreaming'), false);
    for (const key of ['id', 'roomId', 'senderId', 'senderName', 'content', 'timestamp', 'role'] as const) assert.equal(projected[key], input[key]);
    assert.doesNotMatch(text, /must-not-leak-capability-object|must-not-appear-in-message/);
    assert.equal(Object.hasOwn(input, 'preservesStreamingFlagPresence'), scenario.own);
    if (scenario.own) assert.equal(input.preservesStreamingFlagPresence, scenario.marker);
    assert.equal(h.socket.sent.length, 0);
  });
}
