import {freezeKnowledgeScope,type KnowledgeScope} from './scope';
import {boundedKnowledgeRead,searchKnowledge,readKnowledgeBlock,type KnowledgeApi,type KnowledgeBlock,type KnowledgeResult,type KnowledgeSearchPage} from './search';
export type KnowledgeScopeChoice='current'|'work'|'all';
export interface KnowledgePanelPorts {
 currentScene():string;
 getScope(choice:KnowledgeScopeChoice,signal?:AbortSignal):Promise<KnowledgeScope>;
 api:KnowledgeApi;
 addReference(block:KnowledgeBlock,isCurrent:()=>boolean):Promise<void>;
 openDocument(rootId:string,blockId:string,isCurrent:()=>boolean):Promise<void>|void;
}
export class KnowledgePanel {
 private readonly content:HTMLElement;
 private readonly query:HTMLInputElement;
 private readonly scope:HTMLSelectElement;
 private readonly mode:HTMLSelectElement;
 private readonly search:HTMLButtonElement;
 private readonly status:HTMLElement;
 private readonly disclaimer:HTMLElement;
 private readonly results:HTMLElement;
 private readonly preview:HTMLElement;
 private readonly more:HTMLButtonElement;
 private visible=false;
 private disposed=false;
 private generation=0;
 private controller?:AbortController;
 private scene='';
 private snapshot?:{scope:KnowledgeScope;choice:KnowledgeScopeChoice;query:string;mode:'keyword'|'semantic';page:number;rows:KnowledgeResult[];hasMore:boolean;scene:string;issues:string[]};
 constructor(private readonly root:HTMLElement,private readonly ports:KnowledgePanelPorts){
  const doc=root.ownerDocument;
  const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string,attr?:string)=>{const item=doc.createElement(tag);if(text)item.textContent=text;if(attr)item.setAttribute(attr,'');return item};
  this.content=el('section',undefined,'data-knowledge-content');this.content.className='sac-knowledge';
  const heading=el('h3','知识检索');const help=el('p','在思源笔记中查找资料，核对原文后加入本轮引用。');help.className='sac-knowledge-help';
  const form=el('form',undefined,'data-knowledge-form');form.className='sac-knowledge-form';
  const qLabel=el('label','检索词');this.query=el('input',undefined,'data-knowledge-query');this.query.type='search';this.query.maxLength=500;this.query.placeholder='输入关键词或要查找的问题';qLabel.append(this.query);
  const choices=el('div');choices.className='sac-knowledge-choices';
  const scopeLabel=el('label','范围');this.scope=el('select',undefined,'data-knowledge-scope');
  for(const [value,text] of [['current','当前文档'],['work','当前 Work 资料'],['all','全部笔记库']]){const option=el('option',text);option.value=value;this.scope.append(option)}scopeLabel.append(this.scope);
  const modeLabel=el('label','方式');this.mode=el('select',undefined,'data-knowledge-mode');
  for(const [value,text] of [['keyword','关键词'],['semantic','语义检索']]){const option=el('option',text);option.value=value;this.mode.append(option)}modeLabel.append(this.mode);
  this.search=el('button','检索','data-knowledge-search');this.search.type='submit';choices.append(scopeLabel,modeLabel,this.search);form.append(qLabel,choices);
  this.disclaimer=el('p');this.disclaimer.className='sac-knowledge-help';this.disclaimer.hidden=true;
  this.disclaimer.textContent='语义检索使用思源已配置的模型；查询和候选正文可能交由已配置的嵌入或重排服务处理。本插件不会启用模型或创建索引。';
  this.status=el('p','输入检索词开始。','data-knowledge-status');this.status.setAttribute('role','status');this.status.setAttribute('aria-live','polite');
  this.results=el('div',undefined,'data-knowledge-results');this.results.className='sac-knowledge-results';
  this.preview=el('section',undefined,'data-knowledge-preview-area');this.preview.className='sac-knowledge-preview';this.preview.hidden=true;
  this.more=el('button','加载更多','data-knowledge-more');this.more.type='button';this.more.hidden=true;
  this.content.append(heading,help,form,this.disclaimer,this.status,this.results,this.more,this.preview);root.append(this.content);
  form.addEventListener('submit',event=>{event.preventDefault();void this.runSearch(false)});
  this.more.addEventListener('click',()=>void this.runSearch(true));
  this.query.addEventListener('input',()=>this.changed());
  this.scope.addEventListener('change',()=>this.changed());
  this.mode.addEventListener('change',()=>{this.disclaimer.hidden=this.mode.value!=='semantic';this.changed()});
 }
 private changed():void {this.cancel();this.snapshot=undefined;this.results.replaceChildren();this.preview.replaceChildren();this.preview.hidden=true;this.more.hidden=true;this.status.textContent='范围或检索词已变更，请重新检索。';}
 private cancel():void {this.generation++;this.controller?.abort();this.controller=undefined;this.busy(false);}
 private busy(value:boolean):void {this.search.disabled=value;this.more.disabled=value;this.content.setAttribute('aria-busy',String(value));for(const button of this.results.querySelectorAll<HTMLButtonElement>('button'))button.disabled=value;}
 private begin(){this.cancel();const generation=this.generation,scene=this.ports.currentScene();this.controller=new AbortController();const signal=this.controller.signal;this.busy(true);
  const current=()=>!this.disposed&&this.visible&&this.root.isConnected&&this.generation===generation&&this.ports.currentScene()===scene&&!signal.aborted;
  return {current,signal};
 }
 private scopeKey(scope:KnowledgeScope):string {return scope.kind==='all'?'all':JSON.stringify([...scope.documents].sort((a,b)=>a.rootId.localeCompare(b.rootId)).map(doc=>[doc.rootId,doc.box,doc.path]));}
 private async resolve(choice:KnowledgeScopeChoice,signal:AbortSignal):Promise<KnowledgeScope>{
  const scope=freezeKnowledgeScope(await boundedKnowledgeRead(active=>this.ports.getScope(choice,active),signal));
  if(choice==='all'?scope.kind!=='all':scope.kind!=='documents')throw Error('检索范围发生变化');
  return scope;
 }
 private async runSearch(append:boolean):Promise<void>{
  if(this.disposed||!this.visible)return;
  if(this.snapshot&&this.snapshot.scene!==this.ports.currentScene()){this.changed();if(append)return;}
  const previous=this.snapshot;
  if(append&&(!previous||!previous.hasMore))return;
  const choice=this.scope.value as KnowledgeScopeChoice,query=this.query.value.trim(),mode=this.mode.value as 'keyword'|'semantic';
  if(!query){this.status.textContent='请输入检索词。';return;}
  const operation=this.begin();this.status.textContent='正在读取检索结果…';
  try{
   const scope=await this.resolve(choice,operation.signal);if(!operation.current())return;
   if(append&&previous&&this.scopeKey(previous.scope)!==this.scopeKey(scope))throw Error('检索范围发生变化');
   const page=append?previous!.page+1:1;
   const read=await searchKnowledge((path,body,signal)=>this.ports.api(path,body,signal),{scope,query,mode,page,signal:operation.signal});if(!operation.current())return;
   const rows=new Map((append?previous!.rows:[]).map(row=>[row.id,row]));
   for(const row of read.results){const prior=rows.get(row.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(row))throw Error('分页结果发生变化');rows.set(row.id,row)}
   const issues=[...new Set([...(append?previous!.issues:[]),...read.issues])];
   this.snapshot={scope,choice,query,mode,page,rows:[...rows.values()],hasMore:read.hasMore,scene:this.ports.currentScene(),issues};this.renderRows();this.status.textContent=this.summary({...read,issues},this.snapshot.rows.length);
  }catch{
   if(operation.current())this.status.textContent=previous?'本次读取失败，已保留上次结果；引用前仍会重新核对来源。':mode==='semantic'?'暂未取得可用语义结果：能力、索引或模型读取失败，可切换关键词重试。':'检索失败，范围或读取能力暂不可核实，请稍后重试。';
  }finally{if(operation.current())this.busy(false);}
 }
 private summary(page:KnowledgeSearchPage,total:number):string{
  const base=page.semanticEmpty?'暂未获得可用语义结果；这不代表范围内没有相关资料。':total?`已读取 ${total} 条结果。`:'本次关键词检索没有返回结果。';
  return [base,...page.issues].join(' ');
 }
 private renderRows():void {
  this.results.replaceChildren();this.preview.replaceChildren();this.preview.hidden=true;
  const snapshot=this.snapshot;if(!snapshot)return;this.more.hidden=!snapshot.hasMore;
  const doc=this.root.ownerDocument;
  for(const row of snapshot.rows){
   const item=doc.createElement('article');item.className='sac-knowledge-result';item.setAttribute('data-knowledge-result','');
   const title=doc.createElement('strong');title.textContent=row.title||'文档';
   const source=doc.createElement('details'),summary=doc.createElement('summary'),identity=doc.createElement('p');summary.textContent='查看来源';identity.textContent=`文档 ${row.rootId} · 块 ${row.id}`;source.append(summary,identity);
   const snippet=doc.createElement('p');snippet.className='sac-knowledge-snippet';snippet.textContent=row.snippet;
   const actions=doc.createElement('div');actions.className='sac-knowledge-actions';
   for(const [action,label] of [['preview','预览原文'],['add','加入引用'],['open','打开文档']] as const){const button=doc.createElement('button');button.type='button';button.textContent=label;button.setAttribute(`data-knowledge-${action}`,'');button.addEventListener('click',()=>void this.select(row,action));actions.append(button)}
   item.append(title,source,snippet,actions);this.results.append(item);
  }
 }
 private async select(row:KnowledgeResult,action:'preview'|'add'|'open'):Promise<void>{
  const snapshot=this.snapshot;if(!snapshot||this.disposed||!this.visible)return;
  if(snapshot.scene!==this.ports.currentScene()){this.changed();return;}
  const operation=this.begin();this.status.textContent='正在核对文档来源与原文…';
  try{
   const currentScope=await this.resolve(snapshot.choice,operation.signal);
   if(!operation.current())return;if(this.scopeKey(currentScope)!==this.scopeKey(snapshot.scope))throw Error('检索范围发生变化');
   const exact=await readKnowledgeBlock((path,body,signal)=>this.ports.api(path,body,signal),snapshot.scope,row,operation.signal);if(!operation.current())return;
   if(action==='add'){await this.ports.addReference(exact,operation.current);if(operation.current())this.status.textContent='已加入本轮引用。';}
   else if(action==='open'){await this.ports.openDocument(row.rootId,row.id,operation.current);if(operation.current())this.status.textContent='已请求在思源打开文档。';}
   else {const title=this.root.ownerDocument.createElement('h4');title.textContent='原文预览';const body=this.root.ownerDocument.createElement('pre');body.setAttribute('data-knowledge-body','');body.textContent=exact.markdown;this.preview.replaceChildren(title,body);this.preview.hidden=false;this.status.textContent='已重新读取准确块正文；加入引用时会再次核对。';}
  }catch{if(operation.current())this.status.textContent='操作未完成：当前范围、文档来源或引用权限无法核实，请重新检索后再试。';}
  finally{if(operation.current())this.busy(false);}
 }
 show():void {if(this.disposed)return;this.visible=true;this.content.hidden=false;const scene=this.ports.currentScene();if(this.scene&&this.scene!==scene)this.changed();this.scene=scene;}
 hide():void {this.visible=false;this.cancel();this.content.hidden=true;}
 documentChanged():void {if(this.disposed)return;this.changed();this.scene=this.ports.currentScene();}
 dispose():void {if(this.disposed)return;this.disposed=true;this.visible=false;this.cancel();this.content.remove();}
}
export const knowledgePanelCss=`
.sac-knowledge { min-width:0; padding:12px; overflow-wrap:anywhere; color:var(--b3-theme-on-background); }
.sac-knowledge[hidden], .sac-knowledge [hidden] { display:none!important; }
.sac-knowledge h3,.sac-knowledge h4 { margin:0 0 8px; font-size:14px; }
.sac-knowledge p { margin:6px 0; line-height:1.55; }
.sac-knowledge-help,.sac-knowledge details { font-size:12px; color:var(--b3-theme-on-surface); }
.sac-knowledge-form label { display:flex; flex-direction:column; gap:5px; min-width:0; font-size:12px; }
.sac-knowledge input,.sac-knowledge select { box-sizing:border-box; width:100%; min-width:0; max-width:100%; border:1px solid var(--b3-border-color); border-radius:6px; color:inherit; background:var(--b3-theme-background); padding:7px; }
.sac-knowledge-choices { display:flex; flex-wrap:wrap; align-items:end; gap:8px; margin-top:8px; }
.sac-knowledge-choices label { flex:1 1 100px; }
.sac-knowledge button { padding:5px 9px; border:1px solid var(--b3-border-color); border-radius:6px; background:var(--b3-theme-surface); color:inherit; cursor:pointer; font:inherit; }
.sac-knowledge button:disabled { opacity:.55; cursor:default; }
.sac-knowledge :is(button,input,select):focus-visible { outline:2px solid var(--b3-theme-primary); outline-offset:2px; }
.sac-knowledge-results { display:grid; gap:9px; margin:10px 0; }
.sac-knowledge-result { min-width:0; padding:10px; border:1px solid var(--b3-border-color); border-radius:8px; }
.sac-knowledge-result strong { font-size:13px; }
.sac-knowledge-snippet { max-height:7em; overflow:auto; white-space:pre-wrap; font-size:12px; }
.sac-knowledge-actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.sac-knowledge-preview { padding:10px; border:1px solid var(--b3-border-color); border-radius:8px; margin-top:10px; }
.sac-knowledge-preview pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; max-height:260px; overflow:auto; font:inherit; line-height:1.6; }
`;
