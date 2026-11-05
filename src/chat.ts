import type { Snapshot } from './core.ts';
import type { Reference } from './references.ts';
import type { ChatAdapter, ChatState } from './work/store.ts';

export type ChatMessage = { id:string; role:'user'|'assistant'; content:string; references:Reference[]; snapshot?: Pick<Snapshot,'documentId'|'focusBlockId'|'nearby'>; status?:'complete'|'cancelled'|'error' };
export type ChatThread = { id:string; storedSessionId?:string; adapter:ChatAdapter; state:ChatState; profile:string; installId?:string; legacyBridgeUrl?:string; hermesSessionId?:string; documentRootId:string; connectionId?:string; title:string; messages:ChatMessage[]; createdAt:string; };
export type TransportMessage = { role:'user'|'assistant'; content:string };
let seq=0;
const cloneRefs=(refs:Reference[])=>refs.map(ref=>({...ref}));
export function newThread(documentRootId:string,title='新对话'):ChatThread { const now=new Date().toISOString(); return {id:crypto.randomUUID(),documentRootId,adapter:'unresolved',state:'pending',profile:'default',title,messages:[],createdAt:now}; }
export function appendUserTurn(thread:ChatThread,content:string,references:Reference[],snapshot:Pick<Snapshot,'documentId'|'focusBlockId'|'nearby'>):ChatThread { const message:ChatMessage={id:`message-${Date.now()}-${++seq}`,role:'user',content,references:cloneRefs(references),snapshot:{...snapshot,nearby:snapshot.nearby.map(x=>({...x}))},status:'complete'}; return {...thread,messages:[...thread.messages,message]}; }
export function appendAssistantTurn(thread:ChatThread,content:string,status:'complete'|'cancelled'|'error'='complete'):ChatThread { return {...thread,messages:[...thread.messages,{id:`message-${Date.now()}-${++seq}`,role:'assistant',content,references:[],status}]}; }
export function upsertAssistantTurn(thread:ChatThread,id:string,content:string,status?:ChatMessage['status']):ChatThread {
  const index=thread.messages.findIndex(message=>message.id===id);
  const message:ChatMessage={id,role:'assistant',content,references:[],...(status ? {status} : {})};
  if(index<0)return {...thread,messages:[...thread.messages,message]};
  const messages=[...thread.messages]; messages[index]=message; return {...thread,messages};
}
export function switchThread(threads:ChatThread[],id:string):ChatThread|undefined { return threads.find(thread=>thread.id===id); }
export function buildTransportMessages(thread:ChatThread):TransportMessage[] { return thread.messages.map(message=>({role:message.role,content:message.role==='user'?`${message.content}\n\n${formatFrozenReferences(message.references)}\n\n${formatAuxiliary(message.snapshot?.nearby ?? [])}`:message.content})); }
function formatFrozenReferences(refs:Reference[]):string { return `【用户明确引用】\n${refs.length?refs.map((r,i)=>`[引用${i+1}] blockId=${r.blockId} documentRootId=${r.documentRootId}\n${r.selectedText}`).join('\n'):'（无）'}`; }
function formatAuxiliary(blocks:Snapshot['nearby']):string { return `【辅助背景】\n${blocks.length?blocks.map(b=>`${b.blockId}: ${b.sourceMarkdown??b.text}`).join('\n'):'（无）'}`; }
export async function sendChatTurn(thread:ChatThread,content:string,references:Reference[],transport:(messages:TransportMessage[],signal?:AbortSignal)=>Promise<string>,snapshot:Pick<Snapshot,'documentId'|'focusBlockId'|'nearby'>,signal?:AbortSignal):Promise<{thread:ChatThread;references:Reference[];reply:string}> { if(thread.adapter==='unresolved'||thread.state!=='ready')throw new Error('Chat 来源或结果待确认，不能发送'); const withUser=appendUserTurn(thread,content,references,snapshot); const reply=await transport(buildTransportMessages(withUser),signal); return {thread:appendAssistantTurn(withUser,reply),references:[],reply}; }
export async function chatWithAbort<T>(signal:AbortSignal,transport:(signal:AbortSignal)=>Promise<T>):Promise<T> { signal.throwIfAborted(); return transport(signal); }
