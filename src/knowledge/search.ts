import {freezeKnowledgeScope,isKnowledgeId,sourceInKnowledgeScope,type KnowledgeScope} from './scope';
export type KnowledgeApi = (path:string, body:Record<string,unknown>, signal?:AbortSignal)=>Promise<unknown>;
export interface KnowledgeResult { id:string; rootId:string; box:string; path:string; title:string; snippet:string }
export interface KnowledgeBlock extends KnowledgeResult {markdown:string}
export interface KnowledgeSearchOptions {scope:KnowledgeScope; query:string; mode:'keyword'|'semantic'; page?:number; signal?:AbortSignal; timeoutMs?:number}
export interface KnowledgeSearchPage {results:KnowledgeResult[]; hasMore:boolean; issues:string[]; semanticEmpty:boolean; page:number}
function object(value:unknown):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('检索读取返回格式不完整');
 return value as Record<string,unknown>;
}
function count(value:unknown):value is number {return Number.isSafeInteger(value)&&Number(value)>=0;}
class ConflictingKnowledgeIdentity extends Error {}
class KnowledgeReadTimeout extends Error {}
/** Bounds even adapters that cannot abort a native request. No retry or writes. */
export async function boundedKnowledgeRead<T>(read:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal,timeoutMs=8000):Promise<T>{
 if(signal?.aborted)throw Error('检索读取已取消');
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new KnowledgeReadTimeout('检索读取超时');
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 let abort=()=>{};
 try{return await Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)throw Error('检索读取已取消');return read(controller.signal)}),new Promise<never>((_resolve,reject)=>{
  abort=()=>{controller.abort();reject(Error('检索读取已取消'))};signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>{reject(new KnowledgeReadTimeout('检索读取超时，请稍后重新检索'));controller.abort()},timeoutMs);
 })]);}finally{if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export async function searchKnowledge(api:KnowledgeApi, options:KnowledgeSearchOptions):Promise<KnowledgeSearchPage> {
 const scope=freezeKnowledgeScope(options.scope),query=options.query.trim(),page=options.page??1;
 if(!query||query.length>500||!Number.isSafeInteger(page)||page<1||page>100)throw Error('请输入 1–500 字的检索词，并从有效页码读取');
 if(options.mode!=='keyword'&&options.mode!=='semantic')throw Error('检索方式无效');
 const issues:string[]=[],results=new Map<string,KnowledgeResult>();let hasMore=false,successes=0;let firstFailure:unknown;
 const snapshot=():KnowledgeSearchPage=>({results:[...results.values()],hasMore,issues:[...new Set(issues)],semanticEmpty:options.mode==='semantic'&&results.size===0,page});
 try{return await boundedKnowledgeRead(async signal=>{
  if(options.mode==='semantic'){
   let stat:Record<string,unknown>;
   try{stat=object(await api('/api/ai/embeddingStat',{},signal))}catch{throw Error('当前思源暂不支持读取语义检索状态，请使用关键词检索');}
   if(stat.enabled!==true||!count(stat.indexed)||!count(stat.pending)||!count(stat.failed))throw Error('思源语义检索未启用或状态不可核实，请使用关键词检索');
   if(stat.pending>0||stat.failed>0||stat.indexed===0)issues.push('语义索引尚未完整就绪，结果可能不完整');
  }
  // Kernel splits notebook and document lists, so keep each notebook in its own request.
  const groups=new Map<string,string[]>();
  if(scope.kind==='all')groups.set('',[]);else for(const doc of scope.documents){const paths=groups.get(doc.box)??[];paths.push(`${doc.box}${doc.path}`);groups.set(doc.box,paths)}
  for(const [notebook,paths] of groups){
   if(signal.aborted)throw Error('检索读取已取消');
   try{
    const value=await api(options.mode==='keyword'?'/api/search/fullTextSearchBlock':'/api/search/semanticSearchBlock',{query,paths,page,pageSize:32,method:0,groupBy:0,...(options.mode==='keyword'?{notebook}:{})},signal);
    // A provider may ignore abort. Never accept or advance late groups after the shared deadline.
    if(signal.aborted)throw Error('检索读取已取消');
    const raw=object(value);
    const blocks=raw.blocks===null&&options.mode==='semantic'?[]:raw.blocks;
    if(!Array.isArray(blocks)||blocks.length>1000||!count(raw.pageCount)||!count(raw.matchedBlockCount)||!count(raw.matchedRootCount)||raw.pageCount>100000||blocks.length>raw.matchedBlockCount||(blocks.length>0&&raw.pageCount<page))throw Error('检索分页结果不完整，请重新检索');
    const batch=new Map<string,KnowledgeResult>();
    for(const value of blocks){
     const b=object(value);const source={rootId:b.rootID as string,box:b.box as string,path:b.path as string};
     if(!isKnowledgeId(b.id)||!sourceInKnowledgeScope(scope,source)||(paths.length>0&&!paths.includes(`${source.box}${source.path}`))||typeof b.content!=='string'||typeof b.hPath!=='string'||b.content.length>200000||b.hPath.length>20000)throw Error('检索结果来源或正文摘要未核实');
     const item:KnowledgeResult={...source,id:b.id,title:b.hPath,snippet:b.content};const prior=batch.get(item.id)??results.get(item.id);
     if(prior&&JSON.stringify(prior)!==JSON.stringify(item))throw new ConflictingKnowledgeIdentity('检索结果块身份存在冲突');
     batch.set(item.id,Object.freeze(item));
    }
    for(const [id,item] of batch)results.set(id,item);
    hasMore||=raw.pageCount>page&&page<100;
    if(raw.pageCount>page&&page===100)issues.push('已达到本次 100 页读取上限，结果未全部读取；请缩小检索范围');
    successes++;
   }catch(error){if(signal.aborted)throw Error('检索读取已取消');if(error instanceof ConflictingKnowledgeIdentity)throw error;firstFailure??=error;issues.push('部分文档范围读取失败；已保留其他已核实结果');}
  }
  if(!successes)throw firstFailure??Error('检索暂不可用');
  return snapshot();
 },options.signal,options.timeoutMs);}catch(error){
  // User cancellation invalidates the operation; deadline exhaustion may retain verified groups.
  if(options.signal?.aborted)throw Error('检索读取已取消');
  if(error instanceof KnowledgeReadTimeout&&successes>0){issues.push('部分文档范围读取超时或尚未读取；已保留本次已核实结果，请缩小范围后重试');return snapshot();}
  throw error;
 }
}
export async function readKnowledgeBlock(api:KnowledgeApi, scopeInput:KnowledgeScope,result:KnowledgeResult,signal?:AbortSignal,timeoutMs?:number):Promise<KnowledgeBlock> {
 const scope=freezeKnowledgeScope(scopeInput);
 if(!isKnowledgeId(result.id)||!sourceInKnowledgeScope(scope,result))throw Error('引用来源不在已核实检索范围内');
 return boundedKnowledgeRead(async active=>{
  const identity=async()=>{
   const info=object(await api('/api/block/getBlockInfo',{id:result.id},active));
   if((Object.hasOwn(info,'id')&&info.id!==result.id)||info.rootID!==result.rootId||info.box!==result.box||info.path!==result.path||!sourceInKnowledgeScope(scope,{rootId:info.rootID as string,box:info.box as string,path:info.path as string}))throw Error('文档或块来源已变化，请重新检索');
  };
  await identity();if(active.aborted)throw Error('检索读取已取消');
  const body=object(await api('/api/block/getBlockKramdown',{id:result.id},active));
  if(body.id!==result.id||typeof body.kramdown!=='string'||!body.kramdown.trim()||body.kramdown.length>120000)throw Error('引用正文或块身份未完整核实');
  if(active.aborted)throw Error('检索读取已取消');await identity();
  return Object.freeze({...result,markdown:body.kramdown});
 },signal,timeoutMs);
}
