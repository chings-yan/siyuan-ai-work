import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveBridgeConfig } from './bridge-config.mjs';
import { pairEkkoAccount, probeEkkoAccount } from './ekko-auth.mjs';
import { createEkkoConnectionStore, ekkoConnectionFile } from './ekko-private-file.mjs';
import { listEkkoRooms, loadEkkoRoom, watchEkkoRoom, sendEkkoRoomMessage, findEkkoMessage } from './ekko-room-client.mjs';

const ID = /^[A-Za-z0-9_-]{1,160}$/;
const BODY_LIMIT = 500_000;
const CONTENT_LIMIT = 120_000;
const SAFE_REASONS = new Set(['connection_invalid','access_denied','identity_changed','room_not_found','redirect_denied','pagination_invalid','message_invalid','mention_invalid','join_room_mismatch','socket_auth_or_connect_failed','read_unavailable','invalid_response','history_gap_unresolved','history_limit_reached']);
const fail = (code, status = 400) => Object.assign(new Error(code), { code, status });
const digest = value => createHash('sha256').update(value).digest('hex');
const view = (c, state) => ({id:c.connectionId,deviceId:c.deviceId,accountUserId:c.accountUserId,accountName:c.accountName,state});

function cors({origin,origins}) {
  return origins?.includes(origin) ? {'Access-Control-Allow-Origin':origin,Vary:'Origin'} : {Vary:'Origin'};
}
function pick(value, fields) {
  const result={};
  for(const key of fields) if(['string','number','boolean'].includes(typeof value?.[key])) result[key]=value[key];
  return result;
}
const roomView = value => pick(value,['id','name','description','createdAt','updatedAt']);
const agentView = value => pick(value,['id','roomId','agentId','agent','name','avatar']);
function messageView(value) {
  const result=pick(value,['id','roomId','senderId','senderName','content','timestamp','role','isStreaming']);
  // Preserve invalid flag presence without exposing a rejected object or confusing it with omission.
  if(value && Object.hasOwn(value,'isStreaming') && !Object.hasOwn(result,'isStreaming'))result.isStreaming=null;
  // This local projection guarantee is never copied from upstream message fields.
  if(result.role==='tool')result.preservesStreamingFlagPresence=true;
  if(Array.isArray(value?.mentions))result.mentions=value.mentions.map(item=>pick(item,['type','participantId','displayName']));
  return result;
}
function redact(value, secrets) {
  if(typeof value==='string')return secrets.filter(Boolean).reduce((text,secret)=>text.split(secret).join('[redacted]'),value);
  if(Array.isArray(value))return value.map(item=>redact(item,secrets));
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redact(item,secrets)]));
  return value;
}
async function body(req) {
  if(Number(req.headers['content-length'])>BODY_LIMIT)throw fail('request_too_large',413);
  const chunks=[];let size=0;
  for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>BODY_LIMIT)throw fail('request_too_large',413);chunks.push(Buffer.from(chunk));}
  try {const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!parsed || Array.isArray(parsed) || typeof parsed!=='object')throw new Error();return parsed;}
  catch {throw fail('invalid_json');}
}
function integer(params,name,fallback,max) {
  if(!params.has(name))return fallback;
  const raw=params.get(name);const value=Number(raw);
  if(!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value<(name==='offset'?0:1) || value>max)throw fail('pagination_invalid');
  return value;
}
function decodedId(raw) {
  let value;try{value=decodeURIComponent(raw);}catch{throw fail('invalid_id');}
  if(!ID.test(value))throw fail('invalid_id');return value;
}
function expectedIdentity(headers) {
  const connectionId=headers['x-ekko-connection-id'],deviceId=headers['x-ekko-device-id'],account=headers['x-ekko-account-user-id'];
  if(typeof connectionId!=='string' || !ID.test(connectionId) || typeof deviceId!=='string' || !ID.test(deviceId) ||
      typeof account!=='string' || !/^[1-9]\d{0,15}$/.test(account) || !Number.isSafeInteger(Number(account)))throw fail('expected_identity_invalid');
  return {connectionId,deviceId,accountUserId:Number(account)};
}

// A durable exclusive claim is written before any operation that can emit a
// message. Even a crash during the claim leaves an existing file: never resend.
// Partitioning by immutable connection ID prevents an account change from
// resolving an old account's claim. Records contain no message content.
async function claim(directory,connectionId,id,roomId) {
  const parent=join(directory,digest(connectionId));
  const path=join(parent,`${digest(id)}.json`);
  await mkdir(parent,{recursive:true,mode:0o700});
  let handle;
  try {handle=await open(path,'wx',0o600);}
  catch(error) {
    if(error.code!=='EEXIST')throw error;
    let record;try{record=JSON.parse(await readFile(path,'utf8'));}catch{return false;}
    if(record.id!==id || record.roomId!==roomId)throw fail('message_id_conflict',409);
    return false;
  }
  try {await handle.writeFile(JSON.stringify({id,roomId,state:'unknown'}));await handle.sync();}
  finally {await handle.close();}
  return true;
}

export function createEkkoRouteHandler({authStore=createEkkoConnectionStore(),fetchImpl=fetch,socketFactory,pendingDirectory=resolveBridgeConfig().pendingDirectory}={}) {
  const subscriptions=new Set();
  return async (req,res,context) => {
    const url=new URL(req.url,'http://bridge');
    const path=url.pathname;
    const route=path.match(/^\/ekko\/rooms\/([^/]+)(?:\/(events|messages)|\/send-status\/([^/]+))?$/);
    const known=path==='/ekko/connection' && req.method==='GET' || path==='/ekko/pair' && req.method==='POST' || path==='/ekko/rooms' && req.method==='GET' || route && (req.method==='GET' && route[2]!=='messages' || req.method==='POST' && route[2]==='messages');
    if(!known)return false;
    const secrets=[req.headers['x-siyuan-collab-token']];
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...cors(context)});res.end(JSON.stringify(redact(value,secrets)));};
    const resultError=result=>{const code=SAFE_REASONS.has(result.reason)?result.reason:'ekko_unavailable';json(result.status==='denied'?403:503,{error:{code,message:'EKKO room operation unavailable; verify the connection and room access'}});};
    try {
      if(context.authorized!==true){json(401,{error:{code:'unauthorized',message:'Bridge capability required'}});return true;}
      if(context.origin && !context.origins?.includes(context.origin)){json(403,{error:{code:'origin_denied',message:'Origin is not allowed'}});return true;}
      const roomId=route ? decodedId(route[1]) : null;
      const statusId=route?.[3] ? decodedId(route[3]) : null;
      let input;
      if(req.method==='POST') {
        if(route?.[2]==='messages') {
          const root=req.headers['x-siyuan-document-root'];
          if(!root)throw fail('document_scope_required',403);
          if(typeof root!=='string' || !/^\d{14}-[a-z0-9]{7}$/.test(root))throw fail('invalid_document_root',403);
        }
        input=await body(req);
        if(path==='/ekko/pair') {
          if(typeof input.password==='string')secrets.push(input.password);
          if(typeof input.username!=='string' || input.username.length>256 || typeof input.password!=='string' || input.password.length>4096 || typeof input.baseUrl!=='string' || input.baseUrl.length>128)throw fail('ekko_pairing_input_invalid');
          const paired=await pairEkkoAccount({...input,fetchImpl,store:authStore});
          for(const invalidate of [...subscriptions])invalidate(paired);
          json(200,{connection:view(paired,'connected')});return true;
        }
        if(typeof input.clientMessageId!=='string' || !ID.test(input.clientMessageId) || typeof input.content!=='string' || !input.content.trim() || !Array.isArray(input.mentions ?? []))throw fail('message_invalid');
        if(input.content.length>CONTENT_LIMIT)throw fail('request_too_large',413);
        if((input.mentions ?? []).length>50 || (input.mentions ?? []).some(m=>m?.type!=='agent' || typeof m.participantId!=='string' || !ID.test(m.participantId) || typeof m.displayName!=='string' || !m.displayName || m.displayName.length>256))throw fail('mention_invalid');
      }
      const offset=integer(url.searchParams,'offset',0,Number.MAX_SAFE_INTEGER);
      const limit=integer(url.searchParams,'limit',path==='/ekko/rooms'?50:150,path==='/ekko/rooms'?50:150);
      const before=url.searchParams.has('before')?decodedId(url.searchParams.get('before')):undefined;
      const expected=path!=='/ekko/connection' ? expectedIdentity(req.headers) : null;
      const stored=await authStore.read();
      const connection=stored ? Object.freeze({...stored}) : null;
      if(connection?.token)secrets.push(connection.token);
      if(expected && connection && (connection.connectionId!==expected.connectionId || connection.deviceId!==expected.deviceId || connection.accountUserId!==expected.accountUserId))throw fail('identity_changed',403);
      if(path==='/ekko/connection') {
        if(!connection){json(200,{connection:null});return true;}
        let state='connected';
        if(connection.expiresAt<=Math.floor(Date.now()/1000))state='expired';
        else try{await probeEkkoAccount({connection,fetchImpl});}catch(error){state=error.code==='ekko_identity_changed'?'identity_changed':error.code==='ekko_auth_failed'?'access_denied':'unavailable';}
        const projected=view(connection,state);
        const expiresAt=connection.expiresAt;
        if(Number.isSafeInteger(expiresAt) && expiresAt>0 && Number.isFinite(new Date(expiresAt*1000).getTime())) {
          projected.authorization={source:'app-login-record',expiresAt};
        }
        json(200,{connection:projected});return true;
      }
      if(!connection){json(409,{error:{code:'ekko_connection_missing',message:'Pair an EKKO account first'}});return true;}
      const assertCurrent=async()=>{
        const current=await authStore.read();
        if(!current || current.connectionId!==connection.connectionId || current.deviceId!==connection.deviceId || current.accountUserId!==connection.accountUserId)throw fail('identity_changed',403);
      };
      const guardedFetch=async(...args)=>{await assertCurrent();return fetchImpl(...args);};
      if(path==='/ekko/rooms') {
        const result=await listEkkoRooms(connection,{offset,limit,fetchImpl:guardedFetch});
        await assertCurrent();
        if(result.status!=='ok')resultError(result);
        else if(!Number.isSafeInteger(result.total) || result.total<0)resultError({status:'unknown',reason:'invalid_response'});
        else json(200,{rooms:result.rooms.map(roomView),total:result.total,hasMore:result.hasMore});
      } else if(route && !route[2] && !statusId) {
        const result=await loadEkkoRoom(connection,roomId,{before,limit,fetchImpl:guardedFetch});
        await assertCurrent();
        if(result.status!=='ok')resultError(result);
        else json(200,{room:roomView(result.room),messages:result.messages.map(messageView),agents:result.agents.map(agentView),hasMore:result.hasMore});
      } else if(statusId || route[2]==='messages') {
        const id=statusId || input.clientMessageId;
        let first=false;
        if(!statusId)try{first=await claim(pendingDirectory,connection.connectionId,id,roomId);}catch(error){if(error.code==='message_id_conflict')throw error;throw fail('pending_store_unavailable',503);}
        const result=first ? await sendEkkoRoomMessage(connection,{roomId,clientMessageId:id,content:input.content,mentions:input.mentions ?? []},{fetchImpl,socketFactory}) : await findEkkoMessage(connection,roomId,id,{fetchImpl});
        if(result.status==='denied')resultError(result);
        else json(200,result.status==='ok'?{state:'sent',messageId:id}:{state:'unknown'});
      } else if(route[2]==='events') {
        const controller=new AbortController();
        let closeWatch,heartbeat,socket,disconnect,renewed=false;
        const close=()=>{controller.abort();clearInterval(heartbeat);subscriptions.delete(invalidate);socket?.off?.('disconnect',disconnect);closeWatch?.();};
        const invalidate=current=>{
          const unchanged=current && current.connectionId===connection.connectionId && current.deviceId===connection.deviceId && current.accountUserId===connection.accountUserId;
          renewed=Boolean(unchanged);
          if(res.headersSent)emit('room.disconnected',unchanged?{state:'unknown'}:{state:'denied',reason:'identity_changed'});
          close();if(res.headersSent)res.end();
        };
        subscriptions.add(invalidate);
        req.on('aborted',close);res.on('close',close);
        const emit=(event,data)=>{if(!res.destroyed && !res.writableEnded)res.write(`event: ${event}\ndata: ${JSON.stringify(redact(data,secrets))}\n\n`);};
        // Verify identity and room access before starting the HTTP event stream.
        const allowed=await loadEkkoRoom(connection,roomId,{limit:1,fetchImpl:guardedFetch});
        try{await assertCurrent();if(controller.signal.aborted)throw fail(renewed?'ekko_unavailable':'identity_changed',renewed?503:403);}catch(error){close();throw error;}
        if(allowed.status!=='ok'){close();resultError(allowed);return true;}
        res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store',Connection:'keep-alive',...cors(context)});res.flushHeaders();
        const factory=socketFactory || (await import('socket.io-client')).io;
        const watched=await watchEkkoRoom(connection,roomId,{fetchImpl:guardedFetch,signal:controller.signal,socketFactory:(...args)=>{
          socket=factory(...args);disconnect=()=>emit('room.disconnected',{state:'unknown'});socket.on('disconnect',disconnect);return socket;
        },onEvent:event=>{
          if(controller.signal.aborted)return;
          if(event.type==='message')emit('room.message',messageView(event.message));
          else if(event.type==='connection_status'){
            if(event.reason==='identity_changed')invalidate();
            else {emit('room.disconnected',{state:event.status==='denied'?'denied':'unknown'});if(event.status==='denied'){close();res.end();}}
          }
          else emit('room.stream',{type:event.type,...pick(event.data,['id','roomId','senderId','senderName','content','delta','timestamp','role','isStreaming'])});
        }});
        closeWatch=watched.close;
        try{await assertCurrent();}catch{invalidate();return true;}
        if(watched.status!=='ok'){emit('room.disconnected',{state:watched.status==='denied'?'denied':'unknown'});close();res.end();}
        else if(controller.signal.aborted)close();
        else {heartbeat=setInterval(()=>{void assertCurrent().then(()=>{if(!res.destroyed)res.write(': keepalive\n\n');}).catch(invalidate);},1000);heartbeat.unref();}
      }
    } catch(error) {
      if(res.headersSent){if(!res.destroyed){res.write('event: room.disconnected\ndata: {"state":"unknown"}\n\n');res.end();}}
      else {
        const pairing=error.code==='ekko_pairing_unresolved';
        const knownCode=pairing || ['ekko_auth_failed','ekko_invalid_address','ekko_pairing_input_invalid','request_too_large','invalid_json','invalid_id','pagination_invalid','message_invalid','mention_invalid','document_scope_required','invalid_document_root','message_id_conflict','pending_store_unavailable','expected_identity_invalid','identity_changed'].includes(error.code);
        json(pairing?409:error.status || (error.code==='ekko_auth_failed'?403:knownCode?400:503),{error:{code:knownCode?error.code:'ekko_unavailable',message:pairing?'EKKO pairing result unknown; check EKKO application connections before retrying':'EKKO request could not be completed; verify input, connection and local storage'}});
      }
    }
    return true;
  };
}
