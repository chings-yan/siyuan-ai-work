import { adoptionDigest, type AdoptionMode, type AdoptionNative, type AdoptionPlan, type AdoptionProof, type AdoptionReceipt, type AdoptionRoot, type AdoptionTarget } from './answer-adoption.ts';
import type { SiYuanApi } from './siyuan-host.ts';

const ID=/^\d{14}-[a-z0-9]{7}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MARKER='custom-ai-work-answer-op';
const BLOCKS=new Set(['NodeParagraph','NodeHeading','NodeList','NodeListItem','NodeBlockquote','NodeCodeBlock','NodeTable','NodeThematicBreak']);
const TAGS=new Set(['DIV','SPAN','BR','STRONG','EM','S','DEL','CODE','U','SUB','SUP','KBD','TABLE','COLGROUP','COL','THEAD','TBODY','TR','TH','TD','SVG','USE']);
const INLINE=new Set(['strong','em','s','code','u','sub','sup','kbd','a','text','mark','tag']);
const ATTRS=new Set(['data-node-id','data-node-index','data-type','data-subtype','data-marker','data-href','data-title','class','contenteditable','spellcheck','draggable','data-position','style','xlink:href','colspan','rowspan','align','colgroup','updated',MARKER]);
const obj=(x:unknown):x is Record<string,unknown>=>Boolean(x&&typeof x==='object'&&!Array.isArray(x));
type Engine={Md2BlockDOM:(s:string)=>string;BlockDOM2Md:(s:string)=>string;BlockDOM2StdMd:(s:string)=>string;[name:string]:unknown};
type Parsed={fragment:DocumentFragment;top:HTMLElement[];blocks:HTMLElement[];canonical:string};

/** Strict subset: normal text/marks, headings, lists, quote, code and tables. Other formats stay copyable. */
export class AnswerAdoptionCodec {
 private engine:Engine;
 private nextId:()=>string;
 constructor(private readonly document:Document,lute:unknown){
  if(!obj(lute)&&typeof lute!=='function')throw Error('宿主 Lute 能力不可用，请复制回答');
  const host=lute as {New?:()=>unknown;NewNodeID?:()=>string};
  if(typeof host.New!=='function'||typeof host.NewNodeID!=='function')throw Error('宿主 Lute 能力不可用，请复制回答');
  const engine=host.New();
  if(!obj(engine))throw Error('宿主 Lute 能力不可用');
  for(const name of ['Md2BlockDOM','BlockDOM2Md','BlockDOM2StdMd','SetKramdownIAL','SetSuperBlock','SetBlockRef','SetSanitize','SetHTMLTag2TextMark','SetTextMark','SetProtyleWYSIWYG'])if(typeof engine[name]!=='function')throw Error('宿主 Lute 缺少安全转换能力，请复制回答');
  this.engine=engine as Engine;this.nextId=()=>host.NewNodeID!();
  this.configure(false);
 }
 private configure(ial:boolean):void{
  for(const [name,value] of Object.entries({SetProtyleWYSIWYG:ial,SetKramdownIAL:ial,SetSuperBlock:false,SetBlockRef:false,SetSanitize:true,SetHTMLTag2TextMark:ial,SetTextMark:true}))(this.engine[name] as (value:boolean)=>void)(value);
 }
 private parse(dom:string,marker?:string):Parsed{
  if(typeof dom!=='string'||!dom||dom.length>1000000)throw Error('采纳内容无法完整转换，请复制回答');
  // Template contents are inert and never attached to the page.
  const template=this.document.createElement('template');template.innerHTML=dom;
  if([...template.content.childNodes].some(n=>n.nodeType!==1&&Boolean(n.textContent?.trim())))throw Error('采纳块结构不支持');
  const top=[...template.content.children] as HTMLElement[];
  const blocks=[...template.content.querySelectorAll<HTMLElement>('[data-node-id]')];
  if(!top.length||!blocks.length||blocks.length>128||top.some(x=>!x.hasAttribute('data-node-id'))||new Set(blocks.map(x=>x.getAttribute('data-node-id'))).size!==blocks.length)throw Error('采纳块集合不完整或重复');
  for(const el of template.content.querySelectorAll<HTMLElement>('*')){
   if(!TAGS.has(el.tagName.toUpperCase()))throw Error('包含暂不支持自动采纳的内容，请复制或选择纯文本');
   const type=el.getAttribute('data-type');
   if(el.hasAttribute('data-node-id')){
    if(!ID.test(el.getAttribute('data-node-id')!)||!BLOCKS.has(type??'')||el.tagName!=='DIV')throw Error('包含暂不支持的块格式，请复制或选择纯文本');
    if((type==='NodeList'||type==='NodeListItem')&&el.getAttribute('data-subtype')==='t')throw Error('待办勾选格式不能保真采纳，请选择纯文本或复制');
    if(marker!==undefined&&el.getAttribute(MARKER)!==marker)throw Error('新增块归属标记不符');
   }else if(type&&!type.split(' ').every(x=>INLINE.has(x)))throw Error('包含暂不支持的内联格式，请复制或选择纯文本');
   for(const attr of [...el.attributes]){
    if(!ATTRS.has(attr.name))throw Error('包含未知的块属性，请复制或选择纯文本');
    if(attr.name===MARKER&&marker===undefined)throw Error('回答不得指定采纳标记');
    if(attr.name==='style'&&!/^(?:\s*(?:flex\s*:\s*1|text-align\s*:\s*(?:left|center|right))\s*;?\s*)*$/.test(attr.value))throw Error('包含不支持的样式');
    if(attr.name==='xlink:href'&&!/^#icon[A-Za-z0-9_-]+$/.test(attr.value))throw Error('不允许外部图形资源');
    if(attr.name==='colgroup'&&!/^[0-9.%|]*$/.test(attr.value))throw Error('表格列格式不支持');
    if(attr.name==='updated'&&!/^\d{14}$/.test(attr.value))throw Error('块时间属性格式不符');
    if(attr.name==='data-href'&&!/^(?:https?:\/\/|mailto:|siyuan:\/\/blocks\/\d{14}-[a-z0-9]{7}(?:[/?#]|$))/i.test(attr.value))throw Error('包含不支持的链接');
   }
  }
  const canonical=this.engine.BlockDOM2StdMd(dom);
  if(typeof canonical!=='string'||!canonical.trim()||canonical.length>200000)throw Error('内容规范化失败，请复制回答');
  return {fragment:template.content,top,blocks,canonical};
 }
 async inspect(dom:string,operationId:string):Promise<{proof:Omit<AdoptionProof,'root'>;canonical:string}>{
  const parsed=this.parse(dom,operationId);
  const blocks=await Promise.all(parsed.blocks.map(async block=>({id:block.getAttribute('data-node-id')!,ids:[block,...block.querySelectorAll<HTMLElement>('[data-node-id]')].map(x=>x.getAttribute('data-node-id')!),digest:await adoptionDigest(this.engine.BlockDOM2StdMd(block.outerHTML))})));
  return {proof:{canonicalDigest:await adoptionDigest(parsed.canonical),topIds:parsed.top.map(x=>x.getAttribute('data-node-id')!),blocks},canonical:parsed.canonical};
 }
 async prepare(content:string,operationId:string,mode:AdoptionMode,_needsMarkdown:boolean):Promise<{dom:string;markdown:string;preview:string;proof:Omit<AdoptionProof,'root'>}>{
  if(!UUID.test(operationId)||!content.trim()||content.length>100000)throw Error('回答或采纳身份无效');this.configure(false);
  let initial:string;
  if(mode==='plain'){
   const block=this.document.createElement('div');block.setAttribute('data-type','NodeCodeBlock');block.setAttribute('data-node-id',this.nextId());block.className='code-block';
   const action=this.document.createElement('div');action.className='protyle-action';const lang=this.document.createElement('span');lang.className='protyle-action__language';lang.textContent='text';action.append(lang);
   const inner=this.document.createElement('div');inner.className='hljs';const text=this.document.createElement('div');text.setAttribute('contenteditable','true');text.textContent=content+(content.endsWith('\n')?'':'\n');inner.append(text);block.append(action,inner);initial=block.outerHTML;
  }else if(mode==='formatted')initial=this.engine.Md2BlockDOM(content);else throw Error('采纳格式无效');
  const parsed=this.parse(initial);const before=parsed.canonical;const ids=new Set<string>();
  for(const block of parsed.blocks){const id=this.nextId();if(!ID.test(id)||ids.has(id))throw Error('宿主未生成唯一的新块身份');ids.add(id);block.setAttribute('data-node-id',id);block.removeAttribute('data-node-index');block.setAttribute(MARKER,operationId);}
  const holder=this.document.createElement('div');holder.append(parsed.fragment);const dom=holder.innerHTML;const inspected=await this.inspect(dom,operationId);
  if(inspected.canonical!==before)throw Error('准备内容有损，已停止写入');
  // Apply the same roundtrip even for DOM append. Literal model IAL can never become identity metadata.
  const markdown=this.engine.BlockDOM2Md(dom);this.configure(true);
  try{
   const round=await this.inspect(this.engine.Md2BlockDOM(markdown),operationId);
   if(JSON.stringify(round.proof)!==JSON.stringify(inspected.proof))throw Error('内容无法无损往返，请复制或选择纯文本');
  }finally{this.configure(false);}
  return {dom,markdown,preview:inspected.canonical,proof:inspected.proof};
 }
}

export class SiYuanAnswerAdoptionNative implements AdoptionNative {
 private codec:AnswerAdoptionCodec|null=null;
 constructor(private readonly options:{api:SiYuanApi;document:Document;lute:unknown;timeoutMs?:number}){}
 private getCodec():AnswerAdoptionCodec{return this.codec??=new AnswerAdoptionCodec(this.options.document,this.options.lute);}
 private async call(path:string,body:Record<string,unknown>):Promise<unknown>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([this.options.api(path,body),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('思源接口超时，请核对采纳结果')),this.options.timeoutMs??12000);})]);}finally{if(timer)clearTimeout(timer);}
 }
 private async info(id:string):Promise<AdoptionRoot>{
  if(!ID.test(id))throw Error('目标块身份无效');const value=await this.call('/api/block/getBlockInfo',{id});
  if(!obj(value)||!ID.test(String(value.rootID))||!ID.test(String(value.box))||typeof value.path!=='string'||!value.path.endsWith(`/${value.rootID}.sy`)||!value.path.slice(1,-3).split('/').every(x=>ID.test(x)))throw Error('原生块归属读取不完整');
  return {rootID:String(value.rootID),box:String(value.box),path:value.path};
 }
 private async dom(id:string):Promise<string>{const value=await this.call('/api/block/getBlockDOM',{id});if(!obj(value)||value.id!==id||typeof value.dom!=='string')throw Error('原生正文读回身份不符');return value.dom;}
 private async children(id:string):Promise<string[]>{
  const value=await this.call('/api/block/getChildBlocks',{id});
  if(!Array.isArray(value)||value.length>10000||value.some(x=>!obj(x)||!ID.test(String(x.id)))||new Set(value.map(x=>x.id)).size!==value.length)throw Error('原生子块列表不完整');return value.map(x=>String(x.id));
 }
 private async notebook(id:string):Promise<void>{
  const value=await this.call('/api/notebook/lsNotebooks',{});
  if(!obj(value)||!Array.isArray(value.notebooks)||value.notebooks.filter(x=>obj(x)&&x.id===id&&x.closed===false).length!==1)throw Error('目标笔记本不可用');
 }
 async prepare(content:string,target:AdoptionTarget,operationId:string,mode:AdoptionMode):Promise<AdoptionPlan>{
  const prepared=await this.getCodec().prepare(content,operationId,mode,target.kind==='note');let root:AdoptionRoot|null=null;
  if(target.kind==='append'){root=await this.info(target.documentId);if(root.rootID!==target.documentId)throw Error('只能追加到精确原文档');}
  else{if(!ID.test(target.notebookId)||!target.title.trim()||target.title.length>200||/[\\/\u0000-\u001f]/.test(target.title)||['.','..'].includes(target.title.trim()))throw Error('新笔记标题无效');await this.notebook(target.notebookId);}
  return {operationId,target:structuredClone(target),...prepared,proof:{...prepared.proof,root}};
 }
 async checkTarget(plan:AdoptionPlan):Promise<void>{
  if(plan.target.kind==='note'){await this.notebook(plan.target.notebookId);return;}
  const actual=await this.info(plan.target.documentId);if(JSON.stringify(actual)!==JSON.stringify(plan.proof.root))throw Error('原文档归属已变化，请重新预览');
  // Independent tree read; SQL indexing latency is never used as permission to retry.
  const original=await this.dom(plan.target.documentId);const template=this.options.document.createElement('template');template.innerHTML=original;
  const existing=new Set([...template.content.querySelectorAll('[data-node-id]')].map(x=>x.getAttribute('data-node-id')));
  if(plan.proof.blocks.some(x=>existing.has(x.id)||x.id===actual.rootID))throw Error('新块身份与现有文档冲突');
 }
 async write(plan:AdoptionPlan):Promise<AdoptionReceipt>{
  if(plan.target.kind==='note'){
   const value=await this.call('/api/filetree/createDocWithMd',{notebook:plan.target.notebookId,path:`/${plan.target.title.trim()}`,markdown:plan.markdown});
   if(typeof value!=='string'||!ID.test(value)||plan.proof.blocks.some(x=>x.id===value))throw Error('新笔记回执不完整，请核对');return {rootId:value};
  }
  const value=await this.call('/api/block/appendBlock',{dataType:'dom',data:plan.dom,parentID:plan.target.documentId});
  if(!Array.isArray(value)||value.length!==1||!obj(value[0])||!Array.isArray(value[0].doOperations)||value[0].doOperations.length!==1)throw Error('追加事务回执不完整');
  const op=value[0].doOperations[0];
  if(!obj(op)||op.action!=='insert'||op.id!==plan.proof.topIds[0]||op.parentID!==plan.target.documentId||typeof op.data!=='string')throw Error('追加事务回执身份不符');
  const received=await this.getCodec().inspect(op.data,plan.operationId);
  if(JSON.stringify(received.proof)!==JSON.stringify({canonicalDigest:plan.proof.canonicalDigest,topIds:plan.proof.topIds,blocks:plan.proof.blocks}))throw Error('追加事务没有完整返回本次新增块');
  return {rootId:plan.target.documentId};
 }
 async verify(plan:Pick<AdoptionPlan,'operationId'|'target'|'proof'>,receipt?:AdoptionReceipt):Promise<AdoptionReceipt>{
  // Exact prepared IDs allow read-only recovery even if a create/append response was lost.
  const first=await this.info(plan.proof.topIds[0]);const rootId=receipt?.rootId??(plan.target.kind==='append'?plan.target.documentId:first.rootID);
  if(!ID.test(rootId)||first.rootID!==rootId||(plan.target.kind==='append'&&rootId!==plan.target.documentId)||(plan.target.kind==='note'&&first.box!==plan.target.notebookId))throw Error('采纳读回目标不符');
  const root=await this.info(rootId);
  if(root.rootID!==rootId||JSON.stringify(root)!==JSON.stringify(first)||(plan.proof.root&&JSON.stringify(root)!==JSON.stringify(plan.proof.root)))throw Error('采纳读回归属不符');
  if(plan.target.kind==='note'){
   const attrs=await this.call('/api/attr/getBlockAttrs',{id:rootId});
   if(!obj(attrs)||attrs.title!==plan.target.title.trim()||attrs['custom-ai-work-v0']!==undefined)throw Error('新笔记目标标题或独立身份不符');
  }
  const childIds=await this.children(rootId),start=childIds.indexOf(plan.proof.topIds[0]);
  if(start<0||JSON.stringify(childIds.slice(start,start+plan.proof.topIds.length))!==JSON.stringify(plan.proof.topIds)||(plan.target.kind==='note'&&childIds.length!==plan.proof.topIds.length))throw Error('新增块未完整连续出现');
  const topDom=new Map<string,string>();
  for(const expected of plan.proof.blocks){
   if(JSON.stringify(await this.info(expected.id))!==JSON.stringify(root))throw Error('部分新增块归属不符');
   const dom=await this.dom(expected.id);const actual=await this.getCodec().inspect(dom,plan.operationId);
   if(actual.proof.topIds.length!==1||actual.proof.topIds[0]!==expected.id||actual.proof.canonicalDigest!==expected.digest||JSON.stringify(actual.proof.blocks.map(x=>x.id))!==JSON.stringify(expected.ids))throw Error('新增块完整正文读回不符');
   if(plan.proof.topIds.includes(expected.id))topDom.set(expected.id,dom);
  }
  const whole=await this.getCodec().inspect(plan.proof.topIds.map(id=>topDom.get(id)!).join(''),plan.operationId);
  if(JSON.stringify(whole.proof)!==JSON.stringify({canonicalDigest:plan.proof.canonicalDigest,topIds:plan.proof.topIds,blocks:plan.proof.blocks}))throw Error('整组采纳正文读回不符');
  return {rootId};
 }
}
