import type { PendingOperation, StoragePort, WorkStore } from './store.ts';

/** messageId is an actual remote ID when available, never a list position or DOM ID. */
export type AdoptionSource = { conversationKey:string; messageId?:string; role:'assistant'|'user'|'tool'; complete:boolean; content:string; documentId:string };
export type AdoptionTarget = {kind:'append';documentId:string;title:string}|{kind:'note';notebookId:string;title:string};
export type AdoptionMode = 'formatted'|'plain';
export type AdoptionRoot = {rootID:string;box:string;path:string};
export type AdoptionProof = {canonicalDigest:string;topIds:string[];blocks:{id:string;ids:string[];digest:string}[];root:AdoptionRoot|null};
export type AdoptionPlan = {operationId:string;target:AdoptionTarget;preview:string;dom:string;markdown:string;proof:AdoptionProof};
export type AdoptionReceipt = {rootId:string};
export type AdoptionNative = {
 prepare(content:string,target:AdoptionTarget,operationId:string,mode:AdoptionMode):Promise<AdoptionPlan>;
 checkTarget(plan:AdoptionPlan):Promise<void>;
 write(plan:AdoptionPlan):Promise<AdoptionReceipt>;
 verify(plan:Pick<AdoptionPlan,'operationId'|'target'|'proof'>,receipt?:AdoptionReceipt):Promise<AdoptionReceipt>;
};
export type AdoptionPreview = Readonly<{operationId:string;preview:string;target:AdoptionTarget;mode:AdoptionMode}>;
export type AdoptionResult = {state:'complete'|'unknown';operationId:string;rootId?:string;message:string};
type RecordV1 = {schema:1;operationId:string;key:string;state:'unknown'|'complete'|'not-submitted';target:AdoptionTarget;proof:AdoptionProof;pending:PendingOperation;receipt?:AdoptionReceipt};
const PREFIX='answer-adoption-v1:';
// StoragePort names become real plugin-private filenames. Keep ':' only in the logical pending ID.
const SOURCE_NAME='answer-adoption-v1-source-';
const OPERATION_NAME='answer-adoption-v1-operation-';
const ID=/^\d{14}-[a-z0-9]{7}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
const record=(x:unknown):x is Record<string,unknown>=>Boolean(x&&typeof x==='object'&&!Array.isArray(x));
export async function adoptionDigest(value:string):Promise<string>{
 const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return [...new Uint8Array(hash)].map(x=>x.toString(16).padStart(2,'0')).join('');
}
function targetValid(target:AdoptionTarget):boolean{
 return record(target)&&typeof target.title==='string'&&target.title.trim().length>0&&target.title.length<=200
 &&(target.kind==='append'?ID.test(target.documentId):target.kind==='note'&&ID.test(target.notebookId)&&!/[\\/\u0000-\u001f]/.test(target.title)&&!['.','..'].includes(target.title.trim()));
}
function validate(value:unknown):RecordV1{
 if(!record(value)||value.schema!==1||typeof value.operationId!=='string'||!UUID.test(value.operationId)||typeof value.key!=='string'||!HASH.test(value.key)
 ||!['unknown','complete','not-submitted'].includes(String(value.state))||!targetValid(value.target as AdoptionTarget)||!record(value.proof)||!record(value.pending))throw Error('采纳记录格式不兼容，请保留记录并核对');
 const p=value.proof;
 if(!HASH.test(String(p.canonicalDigest))||!Array.isArray(p.topIds)||!p.topIds.length||p.topIds.length>128||p.topIds.some(id=>typeof id!=='string'||!ID.test(id))||new Set(p.topIds).size!==p.topIds.length
 ||!Array.isArray(p.blocks)||!p.blocks.length||p.blocks.length>128||p.blocks.some(b=>!record(b)||!ID.test(String(b.id))||!HASH.test(String(b.digest))||!Array.isArray(b.ids)||!b.ids.length||b.ids.length>128||b.ids[0]!==b.id||b.ids.some(id=>typeof id!=='string'||!ID.test(id))||new Set(b.ids).size!==b.ids.length)
 ||new Set(p.blocks.map(b=>b.id)).size!==p.blocks.length)throw Error('采纳块核验记录损坏，请先核对');
 const validatedBlocks=p.blocks as {id:string;ids:string[];digest:string}[];
 if(p.topIds.some(id=>!validatedBlocks.some(b=>b.id===id)))throw Error('采纳块核验记录损坏，请先核对');
 if(p.root!==null&&(!record(p.root)||!ID.test(String(p.root.rootID))||!ID.test(String(p.root.box))||typeof p.root.path!=='string'||!p.root.path.endsWith(`/${p.root.rootID}.sy`)))throw Error('采纳目标记录损坏');
 const v=value as unknown as RecordV1;
 if((v.state==='complete'&&!v.receipt)||(v.state==='not-submitted'&&v.receipt))throw Error('采纳记录的提交状态与回执不符');
 if(v.pending.id!==`${PREFIX}${v.key}`||v.pending.kind!=='write'||v.pending.workId!==null||v.pending.state!=='unknown'||v.pending.details!==JSON.stringify({schema:1,operationId:v.operationId,key:v.key})||typeof v.pending.updatedAt!=='string'
 ||(v.receipt!==undefined&&(!record(v.receipt)||!ID.test(v.receipt.rootId))))throw Error('采纳未决身份不符');
 return structuredClone(v);
}

/** One shared instance per plugin. Persisted fences remain authoritative across reloads. */
export class AnswerAdoptionController {
 private busy=false;
 private previews=new WeakMap<AdoptionPreview,{plan:AdoptionPlan;source:AdoptionSource;key:string;result?:AdoptionResult}>();
 constructor(private readonly options:{storage:StoragePort;pendingStore:Pick<WorkStore,'setPending'|'clearPending'|'listPending'>;native:AdoptionNative;isCurrent:(source:AdoptionSource)=>boolean}){}
 get isBusy():boolean{return this.busy;}
 private current(source:AdoptionSource):void{if(!this.options.isCurrent(source))throw Error('回答来源或当前视图已变化，请重新预览');}
 private async prior(key:string):Promise<RecordV1|null>{
  const pointer=await this.options.storage.loadData(`${SOURCE_NAME}${key}`);
  if(pointer===undefined||pointer===null||pointer==='')return null;
  if(typeof pointer!=='string'||!UUID.test(pointer))throw Error('采纳去重记录损坏，请先核对');
  const found=validate(await this.options.storage.loadData(`${OPERATION_NAME}${pointer}`));
  if(found.key!==key||found.operationId!==pointer)throw Error('采纳去重身份不符');return found.state==='not-submitted'?null:found;
 }
 private async existing(key:string):Promise<void>{
  const prior=await this.prior(key);
  if(prior)throw Error(prior.state==='complete'?'该版本回答已采纳到此目标':'这次采纳结果待核对，请勿重复写入');
  if((await this.options.pendingStore.listPending()).some(x=>x.id===`${PREFIX}${key}`))throw Error('这次采纳仍待核对，请勿重复写入');
 }
 async prepare(source:AdoptionSource,target:AdoptionTarget,mode:AdoptionMode='formatted'):Promise<AdoptionPreview>{
  if(source.role!=='assistant'||source.complete!==true||typeof source.content!=='string'||!source.content.trim()||source.content.length>100000||!source.conversationKey||source.conversationKey.length>4096||!ID.test(source.documentId)
   ||(source.messageId!==undefined&&(!source.messageId||source.messageId.length>1024))||!targetValid(target)||!['formatted','plain'].includes(mode))throw Error('仅能采纳来源明确、已完成的普通回答，请检查目标');
  if(target.kind==='append'&&target.documentId!==source.documentId)throw Error('追加目标必须是回答的原文档');
  const frozen=structuredClone(source),frozenTarget=structuredClone(target);this.current(frozen);
  // This is a conservative same-conversation/content/target guard, not a message identity.
  // Keep the original no-ID serialization stable: history can add or omit a genuine remote ID.
  // The real ID remains in frozen source-current verification, never in this deduplication key.
  const targetIdentity=frozenTarget.kind==='append'?{kind:'append',documentId:frozenTarget.documentId}:{kind:'note',notebookId:frozenTarget.notebookId,title:frozenTarget.title.trim()};
  const key=await adoptionDigest(JSON.stringify({conversation:source.conversationKey,messageId:null,content:source.content,target:targetIdentity}));
  await this.existing(key);this.current(frozen);
  const operationId=crypto.randomUUID();const plan=await this.options.native.prepare(frozen.content,frozenTarget,operationId,mode);this.current(frozen);
  if(plan.operationId!==operationId||JSON.stringify(plan.target)!==JSON.stringify(frozenTarget))throw Error('采纳预览身份不符');
  const preview=Object.freeze({operationId,preview:plan.preview,target:Object.freeze(structuredClone(frozenTarget)),mode});
  this.previews.set(preview,{plan:structuredClone(plan),source:frozen,key});return preview;
 }
 private async save(value:RecordV1):Promise<void>{validate(value);await this.options.storage.saveData(`${OPERATION_NAME}${value.operationId}`,structuredClone(value));}
 private async finish(value:RecordV1,receipt:AdoptionReceipt):Promise<AdoptionResult>{
  const complete={...value,state:'complete' as const,receipt};await this.save(complete);
  if(!await this.options.pendingStore.clearPending(value.pending.id,value.pending))return this.unknown(value.operationId,'正文已读回，但未决记录已变化；请核对，勿重复采纳');
  return {state:'complete',operationId:value.operationId,rootId:receipt.rootId,message:'已采纳，全部新增内容已读回核验'};
 }
 private unknown(operationId:string,message='采纳结果待核对；不会自动重复写入'):AdoptionResult{return {state:'unknown',operationId,message};}
 private async cancelBeforeSubmit(value:RecordV1):Promise<AdoptionResult>{
  value.state='not-submitted';await this.save(value);
  const cleared=await this.options.pendingStore.clearPending(value.pending.id,value.pending);
  return this.unknown(value.operationId,cleared?'来源已变化，本次未写入；请关闭并重新预览':'本次未写入，但未决记录已变化，请先核对');
 }
 async commit(preview:AdoptionPreview):Promise<AdoptionResult>{
  if(this.busy)throw Error('另一项采纳正在处理，请稍候');
  const item=this.previews.get(preview);if(!item)throw Error('预览已失效，请重新打开');if(item.result)return item.result;
  this.busy=true;
  try{
   this.current(item.source);await this.existing(item.key);await this.options.native.checkTarget(item.plan);this.current(item.source);
   const pending:PendingOperation={id:`${PREFIX}${item.key}`,kind:'write',workId:null,state:'unknown',details:JSON.stringify({schema:1,operationId:preview.operationId,key:item.key}),updatedAt:new Date().toISOString()};
   const value:RecordV1={schema:1,operationId:preview.operationId,key:item.key,state:'not-submitted',target:structuredClone(item.plan.target),proof:structuredClone(item.plan.proof),pending};
   // Persist the readback plan first; a fence can never point at an absent plan after a normal failure.
   // Both stores must succeed before the only native mutation.
   await this.save(value);await this.options.pendingStore.setPending(pending,{ifAbsent:true});
   await this.options.storage.saveData(`${SOURCE_NAME}${item.key}`,preview.operationId);
   try{
    if(!this.options.isCurrent(item.source)){
     // This branch precedes the native call. It is known unsent, not an inference from absent readback.
     item.result=await this.cancelBeforeSubmit(value);return item.result;
    }
    // Only this durable transition permits the native call. Earlier persistence failures are known unsent.
    value.state='unknown';await this.save(value);
    if(!this.options.isCurrent(item.source)){item.result=await this.cancelBeforeSubmit(value);return item.result;}
    const receipt=await this.options.native.write(item.plan);value.receipt=receipt;await this.save(value);
    const verified=await this.options.native.verify(value,receipt);item.result=await this.finish(value,verified);
   }catch{item.result=this.unknown(preview.operationId);}
   return item.result;
  }finally{this.busy=false;}
 }
 async review(operationId:string):Promise<AdoptionResult>{
  if(this.busy)throw Error('另一项采纳正在处理，请稍候');if(!UUID.test(operationId))throw Error('采纳记录无效');this.busy=true;
  try{
   const value=validate(await this.options.storage.loadData(`${OPERATION_NAME}${operationId}`));
   if(value.operationId!==operationId)throw Error('采纳记录身份不符');
   const pending=(await this.options.pendingStore.listPending()).find(x=>x.id===value.pending.id);
   if(!pending)return value.state==='complete'?{state:'complete',operationId,rootId:value.receipt?.rootId,message:'已核验采纳结果'}:this.unknown(operationId);
   if(JSON.stringify(pending)!==JSON.stringify(value.pending))return this.unknown(operationId,'未决记录已变化，请保留并核对');
   if(value.state==='not-submitted'){
    const cleared=await this.options.pendingStore.clearPending(value.pending.id,value.pending);
    return this.unknown(operationId,cleared?'本次未写入；请关闭并重新预览':'本次未写入，但未决记录已变化，请先核对');
   }
   try{return await this.finish(value,await this.options.native.verify(value,value.receipt));}catch{return this.unknown(operationId);}
  }finally{this.busy=false;}
 }
 async pending():Promise<{operationId:string;target:AdoptionTarget}[]>{
  const result:{operationId:string;target:AdoptionTarget}[]=[];
  for(const pending of await this.options.pendingStore.listPending()){
   if(!pending.id.startsWith(PREFIX))continue;
   let meta:unknown;try{meta=JSON.parse(pending.details);}catch{continue;}
   if(!record(meta)||typeof meta.operationId!=='string'||!UUID.test(meta.operationId))continue;
   const value=validate(await this.options.storage.loadData(`${OPERATION_NAME}${meta.operationId}`));
   if(value.pending.id===pending.id)result.push({operationId:value.operationId,target:value.target});
  }return result;
 }
}
