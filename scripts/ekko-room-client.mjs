import { assertEkkoBaseUrl } from './ekko-auth.mjs';

const READ_TIMEOUT_MS = 10_000;
const ACK_TIMEOUT_MS = 8_000;
const MAX_HISTORY_PAGES = 10;
const HISTORY_PAGE_SIZE = 150;
const MAX_WATCH_PAGES = 100;

function status(status, reason, extra = {}) { return { status, reason, ...extra }; }
function safeBase(connection) {
  if (!connection || typeof connection.token !== 'string' || !connection.token || !Number.isSafeInteger(connection.accountUserId) || !connection.deviceId || !Number.isSafeInteger(connection.expiresAt) || connection.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  try { return assertEkkoBaseUrl(connection.baseUrl).origin; } catch { return null; }
}
function roomIdValue(roomId) { return typeof roomId === 'string' && roomId.trim() && roomId.length <= 160 ? roomId : null; }
function messageIdValue(id) { return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id) ? id : null; }
async function getJson(connection, path, fetchImpl, { retries = 1 } = {}) {
  const base = safeBase(connection);
  if (!base) return status('denied', 'connection_invalid');
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetchImpl(new URL(path, base).href, { method:'GET', headers:{Accept:'application/json',Authorization:`Bearer ${connection.token}`}, redirect:'error', signal:AbortSignal.timeout(READ_TIMEOUT_MS) });
    } catch { if (attempt < retries) continue; return status('unknown', 'read_unavailable'); }
    if (response.status === 401 || response.status === 403) return status('denied', 'access_denied');
    if (response.status >= 300 && response.status < 400) return status('denied', 'redirect_denied');
    if (response.status >= 500 && attempt < retries) continue;
    if (!response.ok) return status(response.status >= 500 ? 'unknown' : 'denied', response.status === 404 ? 'room_not_found' : 'request_failed');
    try { return status('ok', null, { body:await response.json() }); }
    catch { return status('unknown', 'invalid_response'); }
  }
  return status('unknown', 'read_unavailable');
}
async function verifyIdentity(connection, fetchImpl) {
  const me = await getJson(connection, '/api/auth/me', fetchImpl);
  if (me.status !== 'ok') return me;
  const link = await getJson(connection, '/api/devices/link-info', fetchImpl);
  if (link.status !== 'ok') return link;
  if (me.body?.user?.id !== connection.accountUserId || link.body?.device_id !== connection.deviceId) return status('denied', 'identity_changed');
  return status('ok');
}
function validPage(value) { return value && typeof value === 'object' && Array.isArray(value.messages) && Array.isArray(value.agents) && typeof value.hasMore === 'boolean' && value.room && typeof value.room.id === 'string'; }
export async function listEkkoRooms(connection, { offset = 0, limit = 50, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return status('denied', 'pagination_invalid');
  const identity = await verifyIdentity(connection, fetchImpl);
  if (identity.status !== 'ok') return identity;
  const result = await getJson(connection, `/api/studio/group-chat/rooms?offset=${offset}&limit=${limit}`, fetchImpl);
  if (result.status !== 'ok') return result;
  const body = result.body;
  return Array.isArray(body?.rooms) && typeof body.hasMore === 'boolean' ? status('ok', null, { rooms:body.rooms, total:body.total, offset:body.offset, limit:body.limit, hasMore:body.hasMore }) : status('unknown', 'invalid_response');
}
async function loadRoomPage(connection, roomId, { offset = 0, before, limit = 150, fetchImpl = fetch } = {}) {
  if (!roomIdValue(roomId) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_PAGE_SIZE || before !== undefined && !roomIdValue(before)) return status('denied', 'pagination_invalid');
  const query = new URLSearchParams({offset:String(offset),limit:String(limit)});
  if (before) query.set('before',before);
  const result = await getJson(connection, `/api/studio/group-chat/rooms/${encodeURIComponent(roomId)}?${query}`, fetchImpl);
  if (result.status !== 'ok') return result;
  const body = result.body;
  if (!validPage(body) || body.room.id !== roomId || body.messages.some(message => message?.roomId !== roomId)) return status('unknown', 'invalid_response');
  return status('ok', null, {room:body.room,messages:body.messages,agents:body.agents,members:body.members || [],total:body.total,offset:body.offset,limit:body.limit,hasMore:body.hasMore});
}
export async function loadEkkoRoom(connection, roomId, options = {}) {
  const identity = await verifyIdentity(connection, options.fetchImpl || fetch);
  return identity.status === 'ok' ? loadRoomPage(connection, roomId, options) : identity;
}
export async function findEkkoMessage(connection, roomId, clientMessageId, { fetchImpl = fetch } = {}) {
  if (!messageIdValue(clientMessageId) || !roomIdValue(roomId)) return status('denied', 'message_id_invalid');
  const identity = await verifyIdentity(connection, fetchImpl);
  if (identity.status !== 'ok') return identity;
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const result = await loadRoomPage(connection, roomId, {offset:page * HISTORY_PAGE_SIZE, limit:HISTORY_PAGE_SIZE, fetchImpl});
    if (result.status !== 'ok') return result;
    const found = result.messages.find(message => message.id === clientMessageId && message.senderId === `auth:${connection.accountUserId}`);
    if (found) return status('ok', null, {messageId:clientMessageId,message:found});
    if (!result.hasMore) break;
  }
  return status('unknown', 'not_found_in_recent_history');
}
async function socketFor(connection, socketFactory) {
  const base = safeBase(connection);
  if (!base) return {result:status('denied','connection_invalid')};
  const factory = socketFactory || (await import('socket.io-client')).io;
  const socket = factory(`${base}/group-chat`, {auth:{token:connection.token},transports:['websocket'],reconnection:true});
  return {socket};
}
function ack(socket, event, payload, timeoutMs) {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => finish(status('unknown','ack_timeout')),timeoutMs);
    const finish = result => { if (settled) return; settled=true;clearTimeout(timer);resolve(result); };
    try { socket.emit(event,payload,value => {
      if (!value || typeof value !== 'object') return finish(status('unknown','ack_invalid'));
      if (value.error) return finish(status('denied',typeof value.code === 'string' ? value.code : 'server_rejected'));
      finish(status('ok',null,{ack:value}));
    }); } catch { finish(status('unknown','socket_emit_failed')); }
  });
}
function waitConnect(socket, timeoutMs) {
  if (socket.connected) return Promise.resolve(status('ok'));
  return new Promise(resolve => {
    let done=false;
    const finish = result => {if(done)return;done=true;clearTimeout(timer);socket.off?.('connect',connected);socket.off?.('connect_error',failed);resolve(result);};
    const connected=()=>finish(status('ok'));
    const failed=()=>finish(status('denied','socket_auth_or_connect_failed'));
    const timer=setTimeout(()=>finish(status('unknown','connect_timeout')),timeoutMs);
    socket.on('connect',connected);socket.on('connect_error',failed);
  });
}
const MENTION_END = new Set(['.',',','!','?',';',':','，','。','！','？','；','：',')',']','}','>']);
function mentionsName(content, name) {
  if (!content || !name) return false;
  const visible = content.replace(/<quoted_message(?:\s[^>]*)?>[\s\S]*?<\/quoted_message>/gi, match => match.replace(/[^\n]/g, ' '));
  const lower = visible.toLowerCase();
  const target = `@${name.toLowerCase()}`;
  let at = 0;
  while ((at = lower.indexOf(target, at)) !== -1) {
    const before = visible[at - 1], after = visible[at + target.length];
    if ((before === undefined || !/[a-zA-Z0-9_]/.test(before)) && (after === undefined || /\s/.test(after) || MENTION_END.has(after))) return true;
    at++;
  }
  return false;
}
function checkedMentions(content, mentions, agents) {
  if (!Array.isArray(mentions) || !Array.isArray(agents)) return null;
  const chosen = new Set();
  for (const mention of mentions) {
    if (!mention || mention.type !== 'agent' || typeof mention.participantId !== 'string' || typeof mention.displayName !== 'string' || chosen.has(mention.participantId)) return null;
    const candidate = agents.find(agent => agent.agentId === mention.participantId && agent.name === mention.displayName);
    if (!candidate || !mentionsName(content,candidate.name)) return null;
    chosen.add(mention.participantId);
  }
  for (const candidate of agents) if (mentionsName(content,candidate.name) && !chosen.has(candidate.agentId)) return null;
  return mentions.map(({type,participantId,displayName})=>({type,participantId,displayName}));
}
export async function sendEkkoRoomMessage(connection, {roomId,clientMessageId,content,mentions = []} = {}, {socketFactory,fetchImpl = fetch,ackTimeoutMs = ACK_TIMEOUT_MS} = {}) {
  if (!roomIdValue(roomId) || !messageIdValue(clientMessageId) || typeof content !== 'string' || !content.trim() || !Array.isArray(mentions)) return status('denied','message_invalid');
  const identity = await verifyIdentity(connection,fetchImpl);
  if (identity.status !== 'ok') return identity;
  const opened = await socketFor(connection,socketFactory);
  if (opened.result) return opened.result;
  const socket=opened.socket;
  try {
    const connected=await waitConnect(socket,ACK_TIMEOUT_MS);
    if (connected.status !== 'ok') return connected;
    const joined=await ack(socket,'join',{roomId,historyLimit:1},ACK_TIMEOUT_MS);
    if (joined.status !== 'ok') return joined;
    if (joined.ack.roomId !== roomId) return status('denied','join_room_mismatch');
    const validated=checkedMentions(content,mentions,joined.ack.agents);
    if (!validated) return status('denied','mention_invalid');
    const sent=await ack(socket,'message',{roomId,id:clientMessageId,content,mentions:validated},ackTimeoutMs);
    if (sent.status === 'ok' && sent.ack.id === clientMessageId) return status('ok',null,{messageId:clientMessageId});
    const found=await findEkkoMessage(connection,roomId,clientMessageId,{fetchImpl});
    return found.status === 'ok' ? found : status('unknown',found.reason || 'send_unresolved');
  } finally { socket.disconnect?.(); }
}
export async function watchEkkoRoom(connection, roomId, {socketFactory,fetchImpl = fetch,onEvent,signal,ackTimeoutMs = ACK_TIMEOUT_MS} = {}) {
  if (!roomIdValue(roomId) || typeof onEvent !== 'function') return status('denied','watch_invalid');
  const identity = await verifyIdentity(connection,fetchImpl);
  if (identity.status !== 'ok') return identity;
  const opened=await socketFor(connection,socketFactory);
  if (opened.result) return opened.result;
  const socket=opened.socket,seen=new Set(),streamSnapshots=new Map();
  let active=true,backfilling=false,gap=false,synchronizedMessageId=null;
  const pending=[];
  const events=['message','message_stream_start','message_stream_delta','message_reasoning_delta','message_stream_end'];
  const handlers=new Map();
  const markGap=()=>{if(active)gap=true;};
  const close=()=>{if(!active)return;active=false;socket.off?.('connect',rejoin);socket.off?.('disconnect',markGap);for(const [event,handler] of handlers)socket.off?.(event,handler);signal?.removeEventListener('abort',close);socket.disconnect?.();};
  const join=async()=>{
    if(!active)return status('denied','watch_closed');
    const checkpoint=synchronizedMessageId;
    if(checkpoint)gap=true;
    backfilling=true;
    try {
      const result=await ack(socket,'join',{roomId,historyLimit:150},ackTimeoutMs);
      if(result.status!=='ok')return result;
      if(result.ack.roomId!==roomId)return status('denied','join_room_mismatch');
      if(!Array.isArray(result.ack.messages))return status('unknown','history_invalid');
      const pages=[result.ack.messages];
      let more=result.ack.hasMore===true;
      while(checkpoint && more && !pages.at(-1).some(message=>message?.id===checkpoint)) {
        if(pages.length>=MAX_WATCH_PAGES)return status('unknown','history_limit_reached');
        const oldest=pages.at(-1).find(message=>message?.isStreaming!==true)?.id;
        if(typeof oldest!=='string')return status('unknown','history_cursor_missing');
        const older=await ack(socket,'load_messages',{roomId,before:oldest,limit:HISTORY_PAGE_SIZE,history:true},ackTimeoutMs);
        if(older.status!=='ok')return status('unknown',older.reason || 'history_unavailable');
        if(!Array.isArray(older.ack.messages) || older.ack.messages.length===0 || older.ack.messages.some(message=>message?.roomId!==roomId))return status('unknown','history_invalid');
        pages.push(older.ack.messages);
        more=older.ack.hasMore===true;
      }
      if(checkpoint && !pages.some(page=>page.some(message=>message?.id===checkpoint)))return status('unknown','history_gap_unresolved');
      const latest=pages[0].filter(message=>message?.isStreaming!==true).at(-1)?.id;
      for(const page of pages.reverse())for(const message of page)deliver('message',message,true);
      synchronizedMessageId=latest || synchronizedMessageId;
      gap=false;
      return status('ok');
    } finally {
      backfilling=false;
      for(const [event,payload] of pending.splice(0))deliver(event,payload);
    }
  };
  const rejoin=()=>{void join().then(result=>{if(result.status!=='ok')onEvent({type:'connection_status',status:result.status,reason:result.reason});});};
  const deliver=(type,payload,fromHistory=false)=>{
    if(!active || payload?.roomId!==roomId)return;
    if(backfilling && !fromHistory){pending.push([type,payload]);return;}
    if(type==='message'){
      if(typeof payload.id!=='string')return;
      if(payload.isStreaming===true){
        if(seen.has(payload.id))return;
        const snapshot=JSON.stringify(payload);
        if(streamSnapshots.get(payload.id)!==snapshot){streamSnapshots.set(payload.id,snapshot);onEvent({type:'message_stream_snapshot',data:payload});}
        return;
      }
      if(seen.has(payload.id))return;
      seen.add(payload.id);streamSnapshots.delete(payload.id);
      if(!fromHistory && !gap)synchronizedMessageId=payload.id;
      onEvent({type,message:payload});
    }else onEvent({type,data:payload});
  };
  for(const event of events){const handler=payload=>deliver(event,payload);handlers.set(event,handler);socket.on(event,handler);}
  socket.on('disconnect',markGap);
  signal?.addEventListener('abort',close,{once:true});
  if(signal?.aborted){close();return status('denied','watch_aborted');}
  const connected=await waitConnect(socket,ackTimeoutMs);
  if(connected.status!=='ok'){close();return connected;}
  const joined=await join();
  if(joined.status!=='ok'){close();return joined;}
  socket.on('connect',rejoin);
  return status('ok',null,{close});
}

