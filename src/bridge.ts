import { isValidDocumentRootId } from './core.ts';
import type { ChatThread } from './chat.ts';

export { isValidDocumentRootId } from './core.ts';

export type HermesSession = { id:string; title?:string; source?:string; message_count?:number; last_active?:number|string; preview?:string; [key:string]:unknown };
export type HermesMessage = { id?:string; session_id?:string; role:string; content?:string; timestamp?:number|string; [key:string]:unknown };
export type BridgeConfig = { bridgeUrl:string; capabilityToken?:string; documentRootId?:string; signal?:AbortSignal };
export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8782';
export function resolveBridgeUrl(settings: { bridgeUrl?: unknown; baseUrl?: unknown }|null|undefined): string {
  return typeof settings?.bridgeUrl === 'string' && settings.bridgeUrl.trim() ? settings.bridgeUrl : DEFAULT_BRIDGE_URL;
}
export class BridgeError extends Error { status:number; code?:string; constructor(message:string,status:number,code?:string){super(message);this.name='BridgeError';this.status=status;this.code=code;} }
export function checkedBridgeUrl(value:string):string{
  let parsed:URL;try{parsed=new URL(value.trim());}catch{throw new BridgeError('请输入有效的本机 Bridge 地址',400,'invalid_bridge_url');}
  if(parsed.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new BridgeError('Bridge 地址只能使用本机回环地址，例如 http://127.0.0.1:8782',400,'invalid_bridge_url');
  return parsed.origin;
}
export type StreamDelta = { delta?:string; done?:boolean; event?:string; raw?:unknown };
export type ChatRunResult = { state:'complete'|'queued'|'interrupted'|'failed'|'unknown'; text:string };
export type StudioReadWarning = 'studio_sessions_unresolved';
export function validatedStudioReadWarning(value:unknown):StudioReadWarning|undefined{return value==='studio_sessions_unresolved'?value:undefined;}
export type ConnectionView = { id:string; kind:'serve'|'studio'|'legacy-api'; displayName:string; state:string; profile:string; installId:string|null; readWarning?:StudioReadWarning };
export type ChatView = { chatId:string; connectionId:string; kind:'serve'|'studio'|'legacy-api'; profile:string; documentRootId:string; title:string; state:string; storedSessionId:string|null; installId:string|null };
export type LegacyClassification = { chatId:string; connectionId:string; adapter:'studio'|'legacy-api'; profile:string; storedSessionId:string; documentRootId:string; installId:null };
export type ChatRouteTarget = Pick<ChatThread,'id'|'adapter'|'state'|'connectionId'|'legacyBridgeUrl'|'storedSessionId'|'hermesSessionId'>;
export type ChatRoute = { kind:'legacy'; bridgeUrl:string; sessionId:string } | { kind:'v2'; chatId:string };

export function resolveThreadRoute(thread:ChatRouteTarget):ChatRoute|null {
  if(thread.adapter==='unresolved'||thread.state==='source-unknown')return null;
  const legacyAdapter=thread.adapter==='studio'||thread.adapter==='legacy-api';
  const originalUrl=thread.legacyBridgeUrl||(legacyAdapter&&thread.connectionId&&/^https?:\/\//.test(thread.connectionId)?thread.connectionId:undefined);
  if(legacyAdapter&&originalUrl){
    const sessionId=thread.storedSessionId||thread.hermesSessionId;
    if(!sessionId)throw new BridgeError('旧 Chat 缺少已确认的会话标识',409,'binding_unknown');
    return {kind:'legacy',bridgeUrl:originalUrl,sessionId};
  }
  if((thread.adapter==='studio'&&thread.connectionId!=='studio-default')
    ||(thread.adapter==='legacy-api'&&thread.connectionId!=='legacy-api')
    ||(thread.adapter==='serve'&&(!thread.connectionId||/^https?:\/\//.test(thread.connectionId))))throw new BridgeError('Chat 缺少已确认的路由绑定',409,'binding_unknown');
  return {kind:'v2',chatId:thread.id};
}

export async function readThreadMessages(thread:ChatRouteTarget&Pick<ChatThread,'documentRootId'>,config:Omit<BridgeConfig,'documentRootId'>):Promise<{data:HermesMessage[]}|null> {
  const route=resolveThreadRoute(thread);
  if(!route)return null;
  const client=createBridgeClient({...config,bridgeUrl:route.kind==='legacy'?route.bridgeUrl:config.bridgeUrl},thread.documentRootId);
  if(route.kind==='legacy'){const result=await client.messages(route.sessionId);return {data:result.data};}
  return client.messagesForChat(route.chatId);
}

const newRoute = (path:string) => /^\/(connections|chats|legacy-bindings)(\/|$)/.test(path);
const safeNewError:Record<string,string> = {
  install_mismatch:'Hermes 安装身份已变化，请核对连接后再继续', install_changed:'Hermes 安装身份已变化，请核对连接后再继续',
  auth_failed:'Hermes 认证失败，请核对连接凭证', source_unknown:'Chat 来源待确认，请先核对并关联',
  document_scope_required:'请先打开一个思源文档', invalid_document_root:'请先打开一个思源文档',
};
function bridgeHttpError(response:Response, data:any, path:string):BridgeError {
  const code=typeof data?.error?.code==='string'?data.error.code:undefined;
  const message=newRoute(path) ? (code && safeNewError[code]) || `Bridge 请求失败（HTTP ${response.status}）` : data?.error?.message||data?.error||`Bridge HTTP ${response.status}`;
  return new BridgeError(message,response.status,code);
}

export function isValidByteStringHeaderValue(value:unknown): value is string {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return false;
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) > 0xff) return false;
  return true;
}

function headerRecord(value:HeadersInit|undefined):Record<string,string> {
  if (!value) return {};
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    const result:Record<string,string> = {};
    value.forEach((headerValue, name) => { result[name] = headerValue; });
    return result;
  }
  if (Array.isArray(value)) return Object.fromEntries(value.map(([name, headerValue]) => [name, String(headerValue)]));
  return Object.fromEntries(Object.entries(value).map(([name, headerValue]) => [name, String(headerValue)]));
}

function checkedHeaders(value:Record<string,string>):Record<string,string> {
  for (const headerValue of Object.values(value)) {
    if (!isValidByteStringHeaderValue(headerValue)) throw new BridgeError('Bridge 请求头包含不安全字符，已阻止请求',400,'invalid_header_value');
  }
  return value;
}

export class HermesBridgeClient {
  constructor(private readonly config:BridgeConfig) {}
  private requestHeaders(path:string, initial?:HeadersInit):Record<string,string>{
    const headers:Record<string,string>={'Content-Type':'application/json',...headerRecord(initial)};
    if(path==='/health') return checkedHeaders(headers);
    if(newRoute(path) && !this.config.capabilityToken) throw new BridgeError('缺少 Bridge 能力凭证',401,'auth_failed');
    if(path!=='/connections' && !isValidDocumentRootId(this.config.documentRootId)) throw new BridgeError('请先打开一个思源文档',400,'invalid_document_root');
    if(this.config.capabilityToken) headers['X-Siyuan-Collab-Token']=this.config.capabilityToken;
    if(path!=='/connections') headers['X-Siyuan-Document-Root']=this.config.documentRootId!;
    return checkedHeaders(headers);
  }
  private async request<T>(path:string, init:RequestInit={}):Promise<T>{
    const headers=this.requestHeaders(path,init.headers);
    const base=checkedBridgeUrl(this.config.bridgeUrl); const response=await fetch(`${base}${path}`,{...init,signal:init.signal??this.config.signal,headers,redirect:'error',credentials:'omit'});
    const data:any=await response.json().catch(()=>({})); if(!response.ok) throw bridgeHttpError(response,data,path); return data as T;
  }
  health(){return this.request<{ok:boolean;service:string}>('/health');}
  listSessions(){return this.request<{data:HermesSession[]}>('/sessions');}
  listStudioSessions(){return this.request<{data:HermesSession[];readWarning?:StudioReadWarning}>('/studio/sessions');}
  listConnections(){return this.request<{data:ConnectionView[]}>('/connections');}
  listCandidates(connectionId:string){return this.request<{data:HermesSession[];readWarning?:StudioReadWarning}>(`/connections/${encodeURIComponent(connectionId)}/sessions`);}
  legacyBindings(){return this.request<{data:LegacyClassification[]}>('/legacy-bindings');}
  createChat(chatId:string,connectionId:string,title:string){return this.request<{chat:ChatView}>('/chats',{method:'POST',body:JSON.stringify({chat_id:chatId,connection_id:connectionId,title})});}
  bindChat(chatId:string,connectionId:string,storedSessionId:string,title:string){return this.request<{chat:ChatView}>('/chats/bind',{method:'POST',body:JSON.stringify({chat_id:chatId,connection_id:connectionId,stored_session_id:storedSessionId,title,confirm:true})});}
  messagesForChat(chatId:string){return this.request<{data:HermesMessage[]}>(`/chats/${encodeURIComponent(chatId)}/messages`);}
  chatForChat(chatId:string){return this.request<{chat:ChatView}>(`/chats/${encodeURIComponent(chatId)}`);}
  stopChat(chatId:string){return this.request<{state:'interrupted'|'unknown'|'not_running'}>(`/chats/${encodeURIComponent(chatId)}/stop`,{method:'POST'});}
  async streamChatForChat(chatId:string,text:string,context:{systemMessage?:string},onEvent:(event:StreamDelta)=>void,signal?:AbortSignal):Promise<ChatRunResult>{
    const path=`/chats/${encodeURIComponent(chatId)}/chat/stream`;
    const headers=this.requestHeaders(path);
    const activeSignal=signal??this.config.signal,base=checkedBridgeUrl(this.config.bridgeUrl);
    let response:Response;
    try { response=await fetch(`${base}${path}`,{method:'POST',signal:activeSignal,headers,redirect:'error',credentials:'omit',body:JSON.stringify({message:text,system_message:context.systemMessage})}); }
    catch { return {state:'unknown',text:''}; }
    if(!response.ok){const data:any=await response.json().catch(()=>({}));throw bridgeHttpError(response,data,path);}
    if(!response.body)return {state:'unknown',text:''};
    const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer=''; let received=''; let final:ChatRunResult|null=null;
    const emit=(block:string)=>{
      for(const [event,data] of parseSseEvents(block)){
        const delta=event==='message.delta' ? (typeof data.delta==='string'?data.delta:typeof data.text==='string'?data.text:undefined) : undefined;
        onEvent({event,raw:data,...(delta===undefined?{}:{delta})});
        if(delta!==undefined)received+=delta;
        if(event==='run.queued')final={state:'queued',text:received};
        else if(event==='run.unknown')final={state:'unknown',text:received};
        else if(event==='run.failed')final={state:'failed',text:received};
        else if(event==='run.interrupted')final={state:'interrupted',text:received};
        else if(event==='run.completed')final={state:data.state && data.state!=='complete'?'unknown':'complete',text:typeof data.text==='string'?data.text:received};
      }
    };
    try {
      while(!final){const {value,done}=await reader.read();if(done){buffer+=decoder.decode();break;}buffer+=decoder.decode(value,{stream:true});const parts=buffer.split(/\r?\n\r?\n/);buffer=parts.pop()||'';for(const part of parts)emit(part);}
      if(buffer.trim()&&!final)emit(buffer);
      return final||{state:'unknown',text:received};
    } catch { return final||{state:'unknown',text:received}; }
    finally {reader.releaseLock();}
  }
  bindStudioSession(sessionId:string){return this.request<{binding:HermesSession}>('/studio/bind',{method:'POST',body:JSON.stringify({session_id:sessionId})});}
  async createSession(title:string, sessionId?:string){const result=await this.request<{session?:HermesSession;data?:HermesSession}>('/sessions',{method:'POST',body:JSON.stringify({title,session_id:sessionId})}); const session=result.session??result.data; if(!session?.id) throw new BridgeError('Bridge returned an invalid session',502,'invalid_session_response'); return {session};}
  messages(sessionId:string){return this.request<{session_id:string;data:HermesMessage[]}>(`/sessions/${encodeURIComponent(sessionId)}/messages`);}
  chat(sessionId:string,message:string,context?:{systemMessage?:string},signal?:AbortSignal){return this.request<{session_id:string;message:{role:string;content:string}}>(`/sessions/${encodeURIComponent(sessionId)}/chat`,{method:'POST',signal,body:JSON.stringify({message,system_message:context?.systemMessage})});}
  async streamChat(sessionId:string,message:string,context?:{systemMessage?:string},onDelta?:(delta:StreamDelta)=>void,signal?:AbortSignal):Promise<string>{
    const headers=this.requestHeaders('/chat/stream');
    const activeSignal=signal??this.config.signal; const response=await fetch(`${checkedBridgeUrl(this.config.bridgeUrl)}/sessions/${encodeURIComponent(sessionId)}/chat/stream`,{method:'POST',signal:activeSignal,headers,redirect:'error',credentials:'omit',body:JSON.stringify({message,system_message:context?.systemMessage})});
    if(!response.ok) { const data:any=await response.json().catch(()=>({})); throw new BridgeError(data.error?.message||`Bridge HTTP ${response.status}`,response.status,data.error?.code); }
    if(!response.body) throw new BridgeError('会话流未收到完成确认',409,'chat_result_unknown');
    const reader=response.body.getReader(); const decoder=new TextDecoder(); let buffer=''; let full=''; let finished=false; let completed=false; let aborted=false;
    const abortReader=()=>{aborted=true; void reader.cancel();}; activeSignal?.addEventListener('abort',abortReader,{once:true});
    const interaction=(event:string):never=>{ void reader.cancel(); throw new BridgeError('需在 Hermes Studio 处理',409,'studio_interaction_required'); };
    const emit=(raw:string)=>{
      const lines=raw.split(/\r?\n/); let event='message'; const data:string[]=[];
      for(const line of lines){ if(line.startsWith('event:')) event=line.slice(6).trim()||'message'; else if(line.startsWith('data:')) data.push(line.slice(5).trim()); }
      if(!data.length)return; const value=data.join('\n');
      if(value==='[DONE]'){if(!finished){finished=true;onDelta?.({done:true,event});}return;}
      let parsed:any; try{parsed=JSON.parse(value);}catch{parsed={data:value};}
      if(event==='approval.requested'||event==='clarify.requested') interaction(event);
      if(event==='run.failed') throw new BridgeError(String(parsed?.error?.message??parsed?.error??parsed?.message??'Studio run failed'),502,'studio_run_failed');
      if(event==='run.completed'){if(!finished){completed=true;finished=true;onDelta?.({done:true,event,raw:parsed});}return;}
      if(event==='message.delta'||event==='message' || event==='delta'){
        const delta=String(parsed?.delta??parsed?.choices?.[0]?.delta?.content??'');
        if(delta){full+=delta;onDelta?.({delta,event,raw:parsed});}
      }
      if(parsed?.done&&!finished){finished=true;onDelta?.({done:true,event,raw:parsed});}
    };
    try { while(!finished&&!aborted){ const {value,done}=await reader.read(); if(done)break; buffer+=decoder.decode(value,{stream:true}); const parts=buffer.split(/\r?\n\r?\n/); buffer=parts.pop()||''; for(const part of parts)emit(part); } if(aborted) throw new DOMException('The operation was aborted','AbortError'); if(buffer.trim()&&!finished)emit(buffer); if(!completed)throw new BridgeError('会话流未收到完成确认',409,'chat_result_unknown'); return full; }
    finally { activeSignal?.removeEventListener('abort',abortReader); reader.releaseLock(); }
  }
}
export function createBridgeClient(config: Omit<BridgeConfig, 'documentRootId'>, documentRootId: string): HermesBridgeClient {
  return new HermesBridgeClient({...config, documentRootId});
}
export async function syncDocumentSessions(config:Omit<BridgeConfig,'documentRootId'>,documentRootId:string|null|undefined):Promise<{data:HermesSession[];documentScoped:boolean}>{
  if(!isValidDocumentRootId(documentRootId)){await new HermesBridgeClient(config).health();return {data:[],documentScoped:false};}
  const client=createBridgeClient(config,documentRootId);
  const result=await client.listSessions();
  return {data:result.data,documentScoped:true};
}
export function bridgeMessagesToChat(data:HermesMessage[]){return data.filter(m=>m.role==='user'||m.role==='assistant').map(m=>({role:m.role as 'user'|'assistant',content:String(m.content??'')}));}
export function parseSseEvents(text:string): Array<[string, Record<string, unknown>]> {
  return text.split(/\r?\n\r?\n/).flatMap(block => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length || data.join('') === '[DONE]') return [];
    try { return [[event, JSON.parse(data.join('\n')) as Record<string, unknown>]] as Array<[string, Record<string, unknown>]>; } catch { return []; }
  });
}
export function sessionScope(documentRootId:string){return `siyuan:${documentRootId}:`;}
export function isOwnedSession(title:string|undefined,documentRootId:string){return String(title||'').startsWith(sessionScope(documentRootId));}
