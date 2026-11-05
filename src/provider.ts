import type { Snapshot, EditPlan } from './core.ts';
import { validatePlan } from './core.ts';
import { formatQuestionWithReferences, type Reference } from './references.ts';
import type { TransportMessage, ChatThread } from './chat.ts';
import { createBridgeClient, BridgeError, resolveThreadRoute, type ChatRunResult } from './bridge.ts';
export type ProviderResult = { text:string; plan:EditPlan[]; provider:'hermes-api'|'local-echo'; warning?:string };
export type ProviderConfig = { baseUrl?:string; model?:string; apiKey?:string; references?:Reference[]; capabilityToken?:string; documentRootId?:string; onStudioEvent?:(event:string,data:unknown)=>void };
function parseJson(text: string): unknown { const unfenced = text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''); return JSON.parse(unfenced); }
function structured(content: unknown): {text:string; plan:unknown} { if (typeof content !== 'string') content = JSON.stringify(content); const parsed = parseJson(content as string); if (!parsed || typeof parsed !== 'object') throw new Error('model response must be JSON object'); const x = parsed as Record<string, unknown>; return { text:typeof x.text === 'string' ? x.text : '', plan:x.plan }; }

export async function analyze(snapshot:Snapshot, question:string, mode:'analyze'|'suggest', config:ProviderConfig={}):Promise<ProviderResult> {
  const base = config.baseUrl?.replace(/\/$/,'');
  if (!base) return { provider:'local-echo', text:`本地开发 provider：已接收问题“${question}”。上下文 ${snapshot.contextText.length} 字符；模式：${mode === 'analyze' ? '只分析' : '建议修改'}。`, plan:[], warning:'未配置 Hermes API Server，未调用真实模型。' };
  if (!config.apiKey) throw new Error('Hermes API requires explicit API key; anonymous requests are refused');
  const response = await fetch(`${base}/v1/chat/completions`, { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.apiKey}`}, body:JSON.stringify({model:config.model || 'hermes-agent',messages:[{role:'system',content:'仅返回 JSON：{"text":"...","plan":[{"blockId":"...","expectedOriginal":"...","replacement":"..."}]}。不要输出 Markdown。'},{role:'user',content:`${formatQuestionWithReferences(question, config.references ?? [], snapshot.nearby)}\n\n快照元数据：文档 ${snapshot.title} (${snapshot.documentId})；焦点块 ${snapshot.focusBlockId}`}],stream:false,metadata:{source:'siyuan-ai-collab',document_id:snapshot.documentId,mode}}) });
  if (!response.ok) throw new Error(`Hermes API ${response.status}`);
  const data:any = await response.json(); const content = data.choices?.[0]?.message?.content || data.output_text || '';
  let parsed: {text:string;plan:unknown}; try { parsed = structured(content); } catch (e:any) { return {provider:'hermes-api',text:String(content),plan:[],warning:`结构化响应无效，已丢弃修改计划：${e.message}`}; }
  if (mode === 'analyze') return {provider:'hermes-api',text:parsed.text,plan:[]};
  try { const current = Object.fromEntries(snapshot.nearby.map(x => [x.blockId, x.sourceMarkdown ?? x.expectedOriginal ?? x.text])); const plan = validatePlan(parsed.plan as EditPlan[], current); return {provider:'hermes-api',text:parsed.text,plan}; }
  catch (e:any) { return {provider:'hermes-api',text:parsed.text,plan:[],warning:`修改计划校验失败，已安全丢弃 plan：${e.message}`}; }
}

export async function chat(messages:TransportMessage[], snapshot:Snapshot, config:ProviderConfig={}, signal?:AbortSignal):Promise<ProviderResult> {
  const base=config.baseUrl?.replace(/\/$/,'');
  if (!base) return {provider:'local-echo',text:`演示/未连接 Hermes：已接收 ${messages.filter(x=>x.role==='user').length} 轮对话。`,plan:[],warning:'当前为本地开发回声，未连接真实 Hermes。'};
  if (!config.apiKey) throw new Error('Hermes API requires explicit API key; anonymous requests are refused');
  const response=await fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${config.apiKey}`},body:JSON.stringify({model:config.model||'hermes-agent',messages,stream:false,metadata:{source:'siyuan-ai-collab',document_id:snapshot.documentId}}),signal});
  if(!response.ok) throw new Error(`Hermes API ${response.status}`);
  const data:any=await response.json(); const content=data.choices?.[0]?.message?.content||data.output_text||'';
  try { const parsed=structured(content); return {provider:'hermes-api',text:parsed.text,plan:[]}; } catch { return {provider:'hermes-api',text:String(content),plan:[],warning:'结构化响应无效，已安全丢弃 plan。'}; }
}

export async function chatSession(sessionId:string, question:string, snapshot:Snapshot, config:ProviderConfig & {bridgeUrl?:string; references?:Reference[]}, signal?:AbortSignal):Promise<ProviderResult> {
  if(!config.bridgeUrl) return chat([{role:'user',content:question}],snapshot,config,signal);
  if(!question.trim()) throw new Error('没有可发送的用户消息');
  const client=createBridgeClient({bridgeUrl:config.bridgeUrl,capabilityToken:config.capabilityToken},config.documentRootId||snapshot.documentId);
  const refs=(config.references ?? []).map((r,i)=>`[引用${i+1}] blockId=${r.blockId} documentRootId=${r.documentRootId}\n${r.selectedText}`).join('\n');
  const auxiliary=`文档：${snapshot.title} (${snapshot.documentId})；焦点块：${snapshot.focusBlockId}\n${snapshot.contextText}`;
  const systemMessage=`你是思源 AI Work 助手。不得直接修改用户正文。若建议修改，请返回 JSON {"text":"说明","plan":[{"blockId":"块 ID","expectedOriginal":"原文 Kramdown","replacement":"新 Markdown"}]}；普通讨论可直接回复。\n【本轮冻结引用】\n${refs || '（无）'}\n【本轮明确资料】\n${auxiliary}`;
  const result=await client.chat(sessionId,question,{systemMessage},signal);
  return {provider:'hermes-api',text:String(result.message?.content ?? ''),plan:[]};
}

function frozenSystemMessage(snapshot:Snapshot,references:Reference[]):string {
  const refs=references.map((r,i)=>`[引用${i+1}] blockId=${r.blockId} documentRootId=${r.documentRootId}\n${r.selectedText}`).join('\n');
  return `你是思源 AI Work 助手。不得直接修改用户正文。若建议修改，请返回 JSON {"text":"说明","plan":[{"blockId":"块 ID","expectedOriginal":"原文 Kramdown","replacement":"新 Markdown"}]}；普通讨论可直接回复。\n【本轮冻结引用】\n${refs || '（无）'}\n【本轮明确资料】\n${snapshot.contextText}`;
}

export async function streamChatSession(chatId:string, question:string, snapshot:Snapshot, config:ProviderConfig & {bridgeUrl:string; references?:Reference[]}, onDelta:(delta:string)=>void, signal?:AbortSignal,onRunEvent?:(event:string,raw:unknown)=>void):Promise<ChatRunResult> {
  if(!question.trim()) throw new Error('没有可发送的用户消息');
  const client=createBridgeClient({bridgeUrl:config.bridgeUrl,capabilityToken:config.capabilityToken},config.documentRootId||snapshot.documentId);
  return client.streamChatForChat(chatId,question,{systemMessage:frozenSystemMessage(snapshot,config.references??[])},x=>{if(x.delta) onDelta(x.delta);if(x.event)onRunEvent?.(x.event,x.raw);},signal);
}

export async function streamThreadChat(thread:Pick<ChatThread,'id'|'adapter'|'state'|'storedSessionId'|'hermesSessionId'|'connectionId'|'legacyBridgeUrl'>,question:string,snapshot:Snapshot,config:ProviderConfig & {bridgeUrl:string; references?:Reference[]},onDelta:(delta:string)=>void,signal?:AbortSignal,onRunEvent?:(event:string,raw:unknown)=>void):Promise<ChatRunResult> {
  if(thread.adapter==='unresolved'||(thread.state!=='ready'&&!(thread.state==='pending'&&(thread.adapter==='serve'||thread.adapter==='studio'))))throw new Error('Chat 来源或结果待确认，不能发送');
  const route=resolveThreadRoute(thread);
  if(!route)throw new Error('Chat 来源或结果待确认，不能发送');
  if(route.kind==='legacy'){
    const client=createBridgeClient({bridgeUrl:route.bridgeUrl,capabilityToken:config.capabilityToken},config.documentRootId||snapshot.documentId);
    let received='';
    try {
      const text=await client.streamChat(route.sessionId,question,{systemMessage:frozenSystemMessage(snapshot,config.references??[])},event=>{if(event.delta){received+=event.delta;onDelta(event.delta);}if(event.event)onRunEvent?.(event.event,event.raw);},signal);
      return {state:'complete',text};
    } catch(error) {
      if(error instanceof BridgeError&&error.code==='chat_result_unknown')return {state:'unknown',text:received};
      throw error;
    }
  }
  return streamChatSession(route.chatId,question,snapshot,config,onDelta,signal,onRunEvent);
}
