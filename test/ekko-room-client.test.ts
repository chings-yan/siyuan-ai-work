import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { prepareRoomSend } from '../src/ekko/context.ts';
// @ts-expect-error -- the Node ESM room adapter has no TypeScript declaration.
import { listEkkoRooms, loadEkkoRoom, watchEkkoRoom, sendEkkoRoomMessage, findEkkoMessage } from '../scripts/ekko-room-client.mjs';

const connection = { connectionId:'connection-1', baseUrl:'http://127.0.0.1:8748', deviceId:'device-1', accountUserId:7, accountName:'测试用户', appConnectionId:4, token:'fictional-token', expiresAt:Math.floor(Date.now()/1000)+3600 };
const room = {id:'room-1',name:'测试房间'};
const identityFetch = fakeFetch(()=>Response.json({room,messages:[],agents:[],hasMore:false})).fetchImpl;
const agent = {id:'record-1',roomId:'room-1',agentId:'agent-1',agent:'hermes',name:'小助手',avatar:''};
const msg = (id:string, roomId='room-1', content='你好') => ({id,roomId,senderId:'auth:7',senderName:'测试用户',content,timestamp:1,role:'user',mentions:[]});
function fakeFetch(route:(url:URL)=>Response|Promise<Response>) {
 const urls:string[]=[];
 const fetchImpl=async (raw:string, init:any) => {
  const url=new URL(raw); urls.push(url.href);
  assert.equal(url.hostname,'127.0.0.1'); assert.equal(init.headers.Authorization,'Bearer fictional-token'); assert.equal(init.redirect,'error');
  if(url.pathname==='/api/auth/me') return Response.json({user:{id:7,username:'测试用户'}});
  if(url.pathname==='/api/devices/link-info') return Response.json({device_id:'device-1'});
  return route(url);
 };
 return {fetchImpl,urls};
}
class FakeSocket extends EventEmitter {
 connected=false; sent:{event:string,payload:any}[]=[]; disconnected=false;
 ack:(event:string,payload:any,callback:(value:any)=>void)=>void = ()=>{};
 override emit(event:string,...args:any[]):boolean {
  if(['join','message','load_messages'].includes(event)){this.sent.push({event,payload:args[0]});this.ack(event,args[0],args[1]);return true;}
  return super.emit(event,...args);
 }
 connect(){this.connected=true; super.emit('connect');}
 disconnect(){this.disconnected=true;this.connected=false;super.emit('disconnect','io client disconnect');}
 server(event:string,payload:any){super.emit(event,payload);}
}
function socketSetup(ack:FakeSocket['ack']) { const socket=new FakeSocket();socket.ack=ack;let address='';let options:any; return {socket,socketFactory:(url:string,config:any)=>{address=url;options=config;queueMicrotask(()=>socket.connect());return socket;},get address(){return address},get options(){return options}}; }

test('rooms use paginated REST and preserve Chinese labels',async()=>{
 const api=fakeFetch(url=>Response.json({rooms:[{id:'room-1',name:'研发讨论'}],total:2,offset:1,limit:1,hasMore:false}));
 const result=await listEkkoRooms(connection,{offset:1,limit:1,fetchImpl:api.fetchImpl});
 assert.equal(result.status,'ok');assert.equal(result.rooms[0].name,'研发讨论');assert.equal(result.hasMore,false);
 assert.match(api.urls.at(-1)! , /offset=1&limit=1/);
});
test('history preserves Chinese text and cursor pagination',async()=>{
 const api=fakeFetch(url=>Response.json({room,messages:[msg('m-1','room-1','欢迎加入')],agents:[agent],total:3,offset:0,limit:1,hasMore:true}));
 const result=await loadEkkoRoom(connection,'room-1',{before:'m-2',limit:1,fetchImpl:api.fetchImpl});
 assert.equal(result.status,'ok');assert.equal(result.messages[0].content,'欢迎加入');assert.equal(result.hasMore,true);assert.equal(result.agents[0].agentId,'agent-1');
 assert.match(api.urls.at(-1)!,/before=m-2/);
});
test('REST permission refusal stays denied',async()=>{
 const api=fakeFetch(()=>new Response(JSON.stringify({error:'Access denied'}),{status:403}));
 const result=await loadEkkoRoom(connection,'room-1',{fetchImpl:api.fetchImpl});assert.equal(result.status,'denied');
});
test('identity mismatch blocks REST room access',async()=>{
 let roomRequests=0;const api=fakeFetch(url=>{roomRequests++;return Response.json({rooms:[]});});
 const changed={...connection,accountUserId:8};const result=await listEkkoRooms(changed,{fetchImpl:api.fetchImpl});
 assert.equal(result.status,'denied');assert.equal(roomRequests,0);
});
test('join refusal prevents sending',async()=>{
 const io=socketSetup((event,_payload,cb)=>{if(event==='join')cb({error:'Access denied'});});
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-1',content:'你好',mentions:[]},{socketFactory:io.socketFactory,fetchImpl:identityFetch});
 assert.equal(result.status,'denied');assert.deepEqual(io.socket.sent.map(x=>x.event),['join']);assert.equal(io.socket.disconnected,true);
});
test('watch deduplicates replay after reconnect and ignores another room',async()=>{
 const seen:any[]=[];const io=socketSetup((event,_payload,cb)=>{if(event==='join')cb({roomId:'room-1',messages:[msg('old')],agents:[agent]});});
 const controller=new AbortController();const watched=await watchEkkoRoom(connection,'room-1',{socketFactory:io.socketFactory,fetchImpl:identityFetch,onEvent:(event:any)=>seen.push(event),signal:controller.signal});
 io.socket.server('message',msg('new'));io.socket.server('message',msg('new'));io.socket.server('message',msg('wrong','room-2'));
 io.socket.server('disconnect','transport close');io.socket.connect();await new Promise(resolve=>setImmediate(resolve));
 io.socket.server('message',msg('new'));io.socket.server('message_stream_delta',{roomId:'room-1',id:'stream-1',delta:'中'});
 assert.equal(seen.filter(x=>x.type==='message'&&x.message?.id==='new').length,1);
 assert.equal(seen.some(x=>x.message?.roomId==='room-2'),false);
 assert.equal(seen.some(x=>x.type==='message_stream_delta'),true);
 assert.equal(io.socket.sent.filter(x=>x.event==='join').length,2);
 controller.abort();assert.equal(io.socket.disconnected,true);assert.equal(watched.status,'ok');
});
test('send uses selected structured Agent ID and exact Chinese content',async()=>{
 const io=socketSetup((event,payload,cb)=>{if(event==='join')cb({roomId:'room-1',agents:[agent]});if(event==='message')cb({id:'client-2'});});
 const content='请检查这段中文 @小助手';
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-2',content,mentions:[{type:'agent',participantId:'agent-1',displayName:'小助手'}]},{socketFactory:io.socketFactory,fetchImpl:identityFetch});
 assert.equal(result.status,'ok');assert.equal(result.messageId,'client-2');
 assert.deepEqual(io.socket.sent[1],{event:'message',payload:{roomId:'room-1',id:'client-2',content,mentions:[{type:'agent',participantId:'agent-1',displayName:'小助手'}]}});
 assert.equal(io.address,'http://127.0.0.1:8748/group-chat');assert.equal(io.options.auth.token,'fictional-token');
});
test('invalid Agent mention is denied before message emit',async()=>{
 const io=socketSetup((event,_payload,cb)=>{if(event==='join')cb({roomId:'room-1',agents:[agent]});});
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-3',content:'你好 @其他人',mentions:[{type:'agent',participantId:'missing',displayName:'其他人'}]},{socketFactory:io.socketFactory,fetchImpl:identityFetch});
 assert.equal(result.status,'denied');assert.deepEqual(io.socket.sent.map(x=>x.event),['join']);
});
test('lost ACK checks historical client ID without resending',async()=>{
 const io=socketSetup((event,_payload,cb)=>{if(event==='join')cb({roomId:'room-1',agents:[]});});
 const api=fakeFetch(()=>Response.json({room,messages:[msg('client-4')],agents:[],total:1,offset:0,limit:150,hasMore:false}));
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-4',content:'你好',mentions:[]},{socketFactory:io.socketFactory,fetchImpl:api.fetchImpl,ackTimeoutMs:15});
 assert.equal(result.status,'ok');assert.equal(result.messageId,'client-4');assert.equal(io.socket.sent.filter(x=>x.event==='message').length,1);
});
test('history search stops at ten pages and still reports unknown',async()=>{
 let pages=0;const api=fakeFetch(url=>{pages++;return Response.json({room,messages:[msg('other-'+pages)],agents:[],total:3000,offset:Number(url.searchParams.get('offset')||0),limit:150,hasMore:true});});
 const result=await findEkkoMessage(connection,'room-1','client-5',{fetchImpl:api.fetchImpl});
 assert.equal(result.status,'unknown');assert.equal(pages,10);assert.equal(api.urls.filter(x=>x.includes('/rooms/room-1')).length,10);
});
test('lost ACK and no history match remains unknown without second send',async()=>{
 const io=socketSetup((event,_payload,cb)=>{if(event==='join')cb({roomId:'room-1',agents:[]});});
 const api=fakeFetch(()=>Response.json({room,messages:[],agents:[],total:0,offset:0,limit:150,hasMore:false}));
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-6',content:'你好',mentions:[]},{socketFactory:io.socketFactory,fetchImpl:api.fetchImpl,ackTimeoutMs:15});
 assert.equal(result.status,'unknown');assert.equal(io.socket.sent.filter(x=>x.event==='message').length,1);
});
test('socket identity mismatch prevents join and send',async()=>{
 let opened=false;const io=socketSetup(()=>{});
 const result=await sendEkkoRoomMessage({...connection,deviceId:'another-device'},{roomId:'room-1',clientMessageId:'client-7',content:'你好',mentions:[]},{socketFactory:(url:string,options:any)=>{opened=true;return io.socketFactory(url,options)},fetchImpl:identityFetch});
 assert.equal(result.status,'denied');assert.equal(opened,false);
});
test('history match from another sender does not confirm our send',async()=>{
 const api=fakeFetch(()=>Response.json({room,messages:[{...msg('client-8'),senderId:'auth:8'}],agents:[],total:1,offset:0,limit:150,hasMore:false}));
 const result=await findEkkoMessage(connection,'room-1','client-8',{fetchImpl:api.fetchImpl});
 assert.equal(result.status,'unknown');
});


test('stream snapshot is replaced by complete persisted message with the same ID',async()=>{
 const seen:any[]=[];let joins=0;
 const partial={...msg('stream-9','room-1','正在生成'),role:'assistant',senderId:'agent-1',isStreaming:true};
 const io=socketSetup((event,_payload,cb)=>{if(event==='join'){joins++;cb({roomId:'room-1',messages:joins===1?[partial]:[{...partial,content:'正在生成更多'}],agents:[],hasMore:false});}});
 const controller=new AbortController();
 await watchEkkoRoom(connection,'room-1',{socketFactory:io.socketFactory,fetchImpl:identityFetch,onEvent:(event:any)=>seen.push(event),signal:controller.signal});
 io.socket.server('disconnect','transport close');io.socket.connect();await new Promise(resolve=>setImmediate(resolve));
 io.socket.server('message',{...partial,content:'完整回复',isStreaming:false});
 assert.equal(seen.filter(x=>x.type==='message'&&x.message?.id==='stream-9').length,1);
 assert.equal(seen.find(x=>x.type==='message'&&x.message?.id==='stream-9')?.message.content,'完整回复');
 assert.equal(seen.some(x=>x.type==='message_stream_snapshot'&&x.data?.content==='正在生成更多'),true);
 controller.abort();
});
test('post-submit error ACK resolves from history and never sends twice',async()=>{
 const io=socketSetup((event,_payload,cb)=>{if(event==='join')cb({roomId:'room-1',agents:[]});if(event==='message')cb({error:'Message could not be saved'});});
 const api=fakeFetch(()=>Response.json({room,messages:[msg('client-error')],agents:[],total:1,offset:0,limit:150,hasMore:false}));
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-error',content:'你好',mentions:[]},{socketFactory:io.socketFactory,fetchImpl:api.fetchImpl});
 assert.equal(result.status,'ok');assert.equal(io.socket.sent.filter(x=>x.event==='message').length,1);
});
test('post-submit error ACK remains unknown when history has no matching ID',async()=>{
 const io=socketSetup((event,_payload,cb)=>{if(event==='join')cb({roomId:'room-1',agents:[]});if(event==='message')cb({error:'Access denied'});});
 const api=fakeFetch(()=>Response.json({room,messages:[],agents:[],total:0,offset:0,limit:150,hasMore:false}));
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-error-2',content:'你好',mentions:[]},{socketFactory:io.socketFactory,fetchImpl:api.fetchImpl});
 assert.equal(result.status,'unknown');assert.equal(io.socket.sent.filter(x=>x.event==='message').length,1);
});
test('reconnect backfills more than one page to the last known message',async()=>{
 let joins=0;const seen:any[]=[];
 const latest=Array.from({length:150},(_,i)=>msg(`new-${i+2}`));
 const io=socketSetup((event,payload,cb)=>{
  if(event==='join'){joins++;cb(joins===1?{roomId:'room-1',messages:[msg('old')],agents:[],hasMore:false}:{roomId:'room-1',messages:latest,agents:[],hasMore:true});}
  if(event==='load_messages'){assert.equal(payload.roomId,'room-1');assert.equal(payload.before,'new-2');assert.equal(payload.history,true);cb({messages:[msg('old'),msg('new-1')],hasMore:false});}
 });
 const controller=new AbortController();
 await watchEkkoRoom(connection,'room-1',{socketFactory:io.socketFactory,fetchImpl:identityFetch,onEvent:(event:any)=>seen.push(event),signal:controller.signal});
 io.socket.server('disconnect','transport close');io.socket.connect();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(io.socket.sent.filter(x=>x.event==='load_messages').length,1);
 assert.equal(seen.filter(x=>x.type==='message').length,152);
 assert.equal(seen.filter(x=>x.type==='message'&&x.message?.id==='old').length,1);
 assert.equal(seen.some(x=>x.type==='message'&&x.message?.id==='new-1'),true);
 controller.abort();
});
test('initial watch accepts the newest batch without loading all older history and checkpoints it',async()=>{
 const events:any[]=[];let joins=0;
 const io=socketSetup((event,_payload,cb)=>{
  if(event==='join')cb({roomId:'room-1',messages:joins++===0?[msg('recent')]:[msg('recent'),msg('next')],agents:[],hasMore:true});
  if(event==='load_messages')cb({messages:[msg('ancient')],hasMore:true});
 });
 const controller=new AbortController();
 const watched=await watchEkkoRoom(connection,'room-1',{socketFactory:io.socketFactory,fetchImpl:identityFetch,onEvent:(event:any)=>events.push(event),signal:controller.signal});
 assert.equal(watched.status,'ok');
 assert.deepEqual(events.filter(x=>x.type==='message').map(x=>x.message.id),['recent']);
 assert.equal(io.socket.sent.filter(x=>x.event==='load_messages').length,0);
 io.socket.server('disconnect','transport close');io.socket.connect();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(events.filter(x=>x.type==='message').map(x=>x.message.id),['recent','next']);
 assert.equal(io.socket.sent.filter(x=>x.event==='load_messages').length,0);
 controller.abort();
});
test('reconnect beyond the bounded history reports unknown without claiming a synchronized gap',async()=>{
 const events:any[]=[];let joins=0,loads=0;
 const io=socketSetup((event,_payload,cb)=>{
  if(event==='join')cb({roomId:'room-1',messages:[msg(joins++===0?'checkpoint':'latest')],agents:[],hasMore:joins>1});
  if(event==='load_messages')cb({messages:[msg(`older-${++loads}`)],hasMore:true});
 });
 const controller=new AbortController();
 const watched=await watchEkkoRoom(connection,'room-1',{socketFactory:io.socketFactory,fetchImpl:identityFetch,onEvent:(event:any)=>events.push(event),signal:controller.signal});
 assert.equal(watched.status,'ok');
 io.socket.server('disconnect','transport close');io.socket.connect();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(loads,99);
 assert.equal(events.some(x=>x.type==='connection_status'&&x.status==='unknown'&&x.reason==='history_limit_reached'),true);
 assert.deepEqual(events.filter(x=>x.type==='message').map(x=>x.message.id),['checkpoint']);
 controller.abort();
});
test('mention matching follows server boundaries and quoted-message filtering',async()=>{
 const helper={...agent,agentId:'helper-1',name:'Helper'};
 const helper2={...agent,agentId:'helper-2',name:'Helper2'};
 const io=socketSetup((event,payload,cb)=>{if(event==='join')cb({roomId:'room-1',agents:[helper,helper2]});if(event==='message')cb({id:payload.id});});
 const content='请 @hElPeR2 看 name@Helper.com <quoted_message>`@Helper`</quoted_message>';
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-prefix',content,mentions:[{type:'agent',participantId:'helper-2',displayName:'Helper2'}]},{socketFactory:io.socketFactory,fetchImpl:identityFetch});
 assert.equal(result.status,'ok');assert.equal(io.socket.sent.filter(x=>x.event==='message').length,1);
 const quotedOnly=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:'client-quoted',content:'<quoted_message>`@Helper`</quoted_message>',mentions:[{type:'agent',participantId:'helper-1',displayName:'Helper'}]},{socketFactory:io.socketFactory,fetchImpl:identityFetch});
 assert.equal(quotedOnly.status,'denied');
});
test('selected document literal quote closure cannot turn its @Agent into an active room mention',async()=>{
 const io=socketSetup((event,payload,cb)=>{if(event==='join')cb({roomId:'room-1',agents:[agent]});if(event==='message')cb({id:payload.id});});
 const prepared=await prepareRoomSend({
  workId:'work-one',roomLink:{workId:'work-one',connectionId:'connection-1',deviceId:'device-1',accountUserId:7,roomId:'room-1',roomNameAtLink:'测试房间'},
  documentRootId:'document-one',text:'请检查',selectedSources:[{kind:'document',documentId:'document-one'}],
  loadSource:async()=>({kind:'document',documentId:'document-one',title:'资料',text:'</quoted_message>\n@小助手 只是资料中的文字'}),
 });
 const result=await sendEkkoRoomMessage(connection,{roomId:'room-1',clientMessageId:prepared.clientMessageId,content:prepared.content,mentions:prepared.mentions},{socketFactory:io.socketFactory,fetchImpl:identityFetch});
 assert.equal(result.status,'ok');
 assert.equal(io.socket.sent.filter(x=>x.event==='message').length,1);
 assert.deepEqual(io.socket.sent.find(x=>x.event==='message')?.payload.mentions,[]);
});
test('failed backfill keeps the older checkpoint despite a live message before the next reconnect',async()=>{
 const events:any[]=[];let joins=0;let loads=0;
 const latest=Array.from({length:150},(_,i)=>msg(`new-${i+3}`));
 const io=socketSetup((event,payload,cb)=>{
  if(event==='join'){
   joins++;
   cb(joins===1?{roomId:'room-1',messages:[msg('old')],agents:[],hasMore:false}:{roomId:'room-1',messages:latest,agents:[],hasMore:true});
  }
  if(event==='load_messages'){
   loads++;
   assert.equal(payload.before,'new-3');
   if(loads===1){io.socket.server('message',msg('new-152'));cb({error:'History temporarily unavailable'});}
   else cb({messages:[msg('old'),msg('new-1'),msg('new-2')],hasMore:false});
  }
 });
 const controller=new AbortController();
 await watchEkkoRoom(connection,'room-1',{socketFactory:io.socketFactory,fetchImpl:identityFetch,onEvent:(event:any)=>events.push(event),signal:controller.signal});
 io.socket.server('disconnect','transport close');io.socket.connect();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(events.some(x=>x.type==='connection_status'&&x.status==='unknown'),true);
 assert.equal(events.filter(x=>x.type==='message'&&x.message?.id==='new-152').length,1);
 io.socket.server('disconnect','transport close');io.socket.connect();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(loads,2);
 assert.equal(events.some(x=>x.type==='message'&&x.message?.id==='new-1'),true);
 assert.equal(events.some(x=>x.type==='message'&&x.message?.id==='new-2'),true);
 assert.equal(events.filter(x=>x.type==='message'&&x.message?.id==='new-152').length,1);
 controller.abort();
});
