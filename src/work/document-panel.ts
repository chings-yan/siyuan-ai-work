import type {TaskList,TaskView} from '../task/reader.ts';
import type {AssociationDocument,AssociationWork,AssociatedTask} from './document-association.ts';
type Section='work'|'tasks';
type Options={
 currentDocument():AssociationDocument|null;
 onViewChanged?:(view:'chat'|'associations'|'knowledge')=>void;
 documentTitle(id:string):Promise<string>;
 loadWorks(documentId:string):Promise<AssociationWork[]>;linkWork(documentId:string,work:AssociationWork,isCurrent:()=>boolean):Promise<void>;
 listTaskLinks(documentId:string):Promise<AssociatedTask[]>;searchTasks(query:string):Promise<TaskList>;
 linkTask(documentId:string,task:TaskView,isCurrent:()=>boolean):Promise<void>;unlinkTask(documentId:string,taskId:string,isCurrent:()=>boolean):Promise<void>;
 editTask(documentId:string,taskId:string,isCurrent:()=>boolean):Promise<string>;openWork(id:string):void;createWork():Promise<void>;confirm(message:string):boolean;
};
const esc=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const relationLabel={root:'Work 根文档',child:'Work 子文档',reference:'已关联资料',none:'未关联'};
const progress=(t:TaskView)=>`${t.completed?'已完成':'未完成'}${typeof t.customProgress==='number'?` · ${t.customProgress}%`:''}${t.kanbanStatus?` · ${t.kanbanStatus}`:''}`;

/** Chat and room nodes stay mounted; only the visible dock page changes. */
export class DocumentAssociationPanel {
 private readonly panel:HTMLElement;
 private readonly input:HTMLInputElement;
 private readonly win:Window;
 private visible=false;private disposed=false;private busy=false;private composing=false;
 private scene=0;private read=0;private section:Section='work';private doc:AssociationDocument|null=null;
 private taskVersion=0;private tasksInvalidated=false;private focusVersion=0;
 private titles=new Map<string,string>();
 private queries:Record<Section,string>={work:'',tasks:''};private timer:ReturnType<typeof setTimeout>|undefined;
 private works:AssociationWork[]=[];private linked:AssociatedTask[]=[];private candidates:TaskView[]=[];
 constructor(private readonly root:HTMLElement,private readonly options:Options){
  this.panel=root.querySelector<HTMLElement>('[data-document-associations]')!;this.win=root.ownerDocument.defaultView!;
  this.panel.innerHTML=`<div class="sac-doc-heading"><div><small>当前文档</small><strong data-doc-current></strong></div><button type="button" data-doc-action="refresh" aria-label="刷新文档关联">刷新</button></div>
   <nav class="sac-doc-sections" aria-label="关联类型"><button type="button" data-doc-section="work" aria-current="page">Work</button><button type="button" data-doc-section="tasks">任务</button></nav>
   <p data-doc-help></p><label class="sac-doc-search"><span data-doc-search-label></span><input data-doc-search maxlength="100" autocomplete="off"></label>
   <p data-doc-notice role="status" aria-live="polite" hidden></p><div data-doc-linked></div><div data-doc-results tabindex="-1" role="region" aria-label="可关联的 Work 或任务"></div>
   <div class="sac-doc-footer"><button type="button" data-doc-action="create-work">＋ 新建 Work</button></div>`;
  this.input=this.panel.querySelector<HTMLInputElement>('[data-doc-search]')!;
  root.addEventListener('click',this.click);this.input.addEventListener('input',this.search);
  this.input.addEventListener('compositionstart',this.compositionStart);this.input.addEventListener('compositionend',this.compositionEnd);
  this.win.addEventListener('focus',this.sourceChanged);this.win.addEventListener('reminderUpdated',this.sourceChanged);
  root.ownerDocument.addEventListener('focusin',this.focusChanged);root.ownerDocument.addEventListener('pointerdown',this.focusChanged,true);
  this.root.dataset.dockView='chat';this.updateHeading();
 }
 dispose():void{
  this.disposed=true;this.scene++;this.read++;clearTimeout(this.timer);this.root.removeEventListener('click',this.click);
  this.input.removeEventListener('input',this.search);this.input.removeEventListener('compositionstart',this.compositionStart);this.input.removeEventListener('compositionend',this.compositionEnd);
  this.win.removeEventListener('focus',this.sourceChanged);this.win.removeEventListener('reminderUpdated',this.sourceChanged);
  this.root.ownerDocument.removeEventListener('focusin',this.focusChanged);this.root.ownerDocument.removeEventListener('pointerdown',this.focusChanged,true);
 }
 show(view:'chat'|'associations'|'knowledge',section?:Section):void{
  if(this.disposed)return;if(section)this.section=section;this.visible=view==='associations';this.scene++;this.read++;clearTimeout(this.timer);
  this.root.dataset.dockView=view;this.panel.hidden=!this.visible;this.options.onViewChanged?.(view);
  this.root.querySelectorAll<HTMLElement>('[data-dock-tab]').forEach(b=>{if(b.dataset.dockTab===view)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  for(const menu of this.root.querySelectorAll<HTMLElement>('[data-work-quick-menu],[data-recent-task-menu],[data-chat-menu]'))menu.hidden=true;
  for(const button of this.root.querySelectorAll<HTMLElement>('[aria-expanded="true"]'))if(button.matches('[data-action="work-picker"],[data-work-action="recent-tasks"],[data-action="chat-actions-menu"]'))button.setAttribute('aria-expanded','false');
  if(this.visible){this.captureDocument();this.notice('');this.updateHeading();void this.refresh();}
 }
 documentChanged():void{
  if(this.disposed)return;this.scene++;this.read++;clearTimeout(this.timer);this.captureDocument();this.clearRows();this.notice('');this.updateHeading();
  if(this.visible)void this.refresh();
 }
 private captureDocument():void{
  const doc=this.options.currentDocument();if(doc?.id!==this.doc?.id)this.queries={work:'',tasks:''};this.doc=doc?{...doc}:null;this.input.value=this.queries[this.section];
 }
 private current(scene:number,documentId:string):boolean{return !this.disposed&&this.root.isConnected&&this.visible&&scene===this.scene&&this.doc?.id===documentId&&this.options.currentDocument()?.id===documentId;}
 private updateHeading():void{
  this.panel.querySelector('[data-doc-current]')!.textContent=this.doc?.title|| (this.doc?'当前打开的文档':'请先打开一篇思源文档');
  this.panel.querySelector('[data-doc-help]')!.textContent=this.section==='work'?'将文档作为 Work 资料关联；不移动文档，也不切换当前对话。':'保留任务主文档，将当前文档关联为补充资料。关联由 AI Work 保存，进度从原任务插件读取。';
  this.panel.querySelector('[data-doc-search-label]')!.textContent=this.section==='work'?'查找 Work':'查找未完成任务';
  this.input.placeholder=this.section==='work'?'搜索 Work 名称或目标':'搜索任务名称';this.input.setAttribute('aria-label',this.section==='work'?'查找 Work':'查找未完成任务');this.input.disabled=!this.doc;
  this.panel.querySelectorAll<HTMLElement>('[data-doc-section]').forEach(b=>{if(b.dataset.docSection===this.section)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');});
  (this.panel.querySelector('[data-doc-action="create-work"]') as HTMLElement).hidden=this.section!=='work';
 }
 private clearRows():void{this.works=[];this.linked=[];this.candidates=[];this.panel.querySelector('[data-doc-linked]')!.replaceChildren();this.panel.querySelector('[data-doc-results]')!.replaceChildren();}
 private notice(message:string,reveal=false):void{const el=this.panel.querySelector<HTMLElement>('[data-doc-notice]')!;el.textContent=message;el.hidden=!message;if(message&&reveal)el.scrollIntoView?.({block:'nearest'});}
 private sourceChanged=(event:Event):void=>{
  if(this.disposed)return;if(event.type==='reminderUpdated'){this.taskVersion++;this.tasksInvalidated=true;}
  if(this.visible&&!this.busy&&!this.composing){clearTimeout(this.timer);this.timer=setTimeout(()=>void this.refresh(),100);}
 };
 private focusChanged=():void=>{this.focusVersion++;};
 private actionKey(button:HTMLElement):string{
  const action=button.dataset.docAction,index=Number(button.dataset.row);
  const id=action==='link-task'?this.candidates[index]?.id:action==='edit-task'||action==='unlink-task'?this.linked[index]?.taskId:action==='open-work'||action==='link-work'?this.works[index]?.id:'';
  return action&&id?JSON.stringify([action,id]):'';
 }
 private captureFocus():{key:string;version:number}|null{
  const active=this.root.ownerDocument.activeElement as HTMLElement|null;if(!active||!this.panel.contains(active))return null;
  const key=this.actionKey(active);return key?{key,version:this.focusVersion}:null;
 }
 private restoreFocus(focus:ReturnType<DocumentAssociationPanel['captureFocus']>):void{
  if(!focus||focus.version!==this.focusVersion||this.root.ownerDocument.activeElement!==this.root.ownerDocument.body)return;
  const replacement=[...this.panel.querySelectorAll<HTMLButtonElement>('[data-doc-action]')].find(b=>!b.disabled&&this.actionKey(b)===focus.key);
  (replacement||this.panel.querySelector<HTMLElement>('[data-doc-results]'))?.focus({preventScroll:true});
 }
 private compositionStart=():void=>{this.composing=true;clearTimeout(this.timer);};
 private compositionEnd=():void=>{this.composing=false;this.search();};
 private search=():void=>{
  this.queries[this.section]=this.input.value;clearTimeout(this.timer);if(this.composing)return;
  // Invalidate the prior search immediately, before the debounce starts a new read.
  if(this.section==='work')this.renderWorks();else{this.read++;this.candidates=[];this.panel.querySelector('[data-doc-results]')!.textContent='正在查找任务…';this.timer=setTimeout(()=>void this.refresh(),150);}
 };
 private async refresh():Promise<void>{
  if(!this.visible||this.disposed)return;
  if(this.options.currentDocument()?.id!==this.doc?.id){this.documentChanged();return;}
  const doc=this.doc;if(!doc){this.clearRows();return;}const scene=this.scene,read=++this.read,section=this.section;
  const current=()=>this.current(scene,doc.id)&&read===this.read;
  const focus=this.captureFocus();this.tasksInvalidated=false;
  this.clearRows();this.panel.querySelector('[data-doc-results]')!.textContent='正在读取…';
  if(section==='work'){
   try{const rows=await this.options.loadWorks(doc.id);if(!current())return;this.works=rows;this.renderWorks();}
   catch(e){if(current())this.panel.querySelector('[data-doc-results]')!.textContent=`Work 读取失败：${errorText(e)}`;}
  }else{
   const [links,tasks]=await Promise.allSettled([this.options.listTaskLinks(doc.id),this.options.searchTasks(this.queries.tasks)]);if(!current())return;
   const rows=[...(links.status==='fulfilled'?links.value.flatMap(r=>r.task.kind==='found'?[r.task.value]:[]):[]),...(tasks.status==='fulfilled'&&tasks.value.kind==='found'?tasks.value.value:[])];
   const titles=await Promise.all([...new Set(rows.flatMap(t=>t.documentId?[t.documentId]:[]))].map(async id=>{try{return [id,(await this.options.documentTitle(id))||'名称暂不可读'] as const;}catch{return [id,'名称暂不可读'] as const;}}));if(!current())return;this.titles=new Map(titles);
   if(links.status==='fulfilled'){this.linked=links.value;this.renderLinked();}else this.panel.querySelector('[data-doc-linked]')!.textContent=`补充资料关联暂不可读，原记录保留：${errorText(links.reason)}`;
   if(tasks.status==='fulfilled'&&tasks.value.kind==='found'){this.candidates=tasks.value.value;this.renderCandidates(links.status==='rejected');}
   else this.panel.querySelector('[data-doc-results]')!.textContent=`未能读取任务列表：${tasks.status==='rejected'?errorText(tasks.reason):tasks.value.kind==='unavailable'?tasks.value.reason:''}。可刷新重试。`;
  }
  this.setButtons();this.restoreFocus(focus);
 }
 private renderWorks():void{
  const query=this.queries.work.trim().toLocaleLowerCase();
  this.panel.querySelector('[data-doc-linked]')!.replaceChildren();
  this.panel.querySelector('[data-doc-results]')!.innerHTML=this.works.map((w,i)=>({w,i})).filter(({w})=>`${w.title} ${w.goal}`.toLocaleLowerCase().includes(query)).map(({w,i})=>`<article class="sac-doc-row"><strong>${esc(w.title)}</strong><small>${esc(w.goal||'未设置目标')}</small><small>${esc(w.error||relationLabel[w.relation])}</small>${w.error?'':`<div class="sac-doc-actions"><button type="button" data-doc-action="open-work" data-row="${i}">打开 Work</button>${w.relation==='none'?`<button type="button" data-doc-action="link-work" data-row="${i}">关联当前文档</button>`:''}</div>`}</article>`).join('')||'<p>没有符合条件的 Work，可新建或调整搜索。</p>';
  this.setButtons();
 }
 private origin(task:TaskView):string{return `主文档：${task.documentId?(this.titles.get(task.documentId)||'名称暂不可读'):'无主文档'} · ${task.projectId?`项目 ID：${task.projectId}`:'无项目'}`;}
 private identity(taskId:string,documentId?:string|null):string{return `<details class="sac-doc-identity"><summary>查看任务标识</summary><small>任务：${esc(taskId)}${documentId?`<br>原文档：${esc(documentId)}`:''}</small></details>`;}
 private renderLinked():void{
  this.panel.querySelector('[data-doc-linked]')!.innerHTML=`<h3>已关联任务 · ${this.linked.length}</h3>${this.linked.map((row,i)=>`<article class="sac-doc-row"><strong>${esc(row.task.kind==='found'?row.task.value.title:'待核对的任务')}</strong><small>${esc(row.task.kind==='found'?progress(row.task.value):row.task.kind==='missing'?'原任务已不存在；补充资料关联保留。':'原任务暂不可读；补充资料关联保留。')}</small>${row.task.kind==='found'?`<small>${esc(this.origin(row.task.value))}</small>`:''}${this.identity(row.taskId,row.task.kind==='found'?row.task.value.documentId:null)}<div class="sac-doc-actions">${row.task.kind==='found'?`<button type="button" data-doc-action="edit-task" data-row="${i}">编辑任务</button>`:''}<button type="button" data-doc-action="unlink-task" data-row="${i}">移除关联</button></div></article>`).join('')||'<p>尚未关联任务。选择下方任务添加补充资料。</p>'}`;
 }
 private renderCandidates(blocked=false):void{
  const linked=new Set(this.linked.map(t=>t.taskId));
  this.panel.querySelector('[data-doc-results]')!.innerHTML=`<h3>${this.queries.tasks.trim()?'搜索结果':'最近未完成任务'}</h3>${this.candidates.map((t,i)=>`<article class="sac-doc-row"><strong>${esc(t.title)}</strong><small>${esc(progress(t))}</small><small>${esc(this.origin(t))}</small>${this.identity(t.id,t.documentId)}${linked.has(t.id)?'<small>已关联 · 原主文档保留</small>':`<button type="button" data-doc-action="link-task" data-row="${i}" ${blocked?'disabled data-source-blocked':''}>关联为补充资料</button>`}</article>`).join('')||'<p>没有符合条件的未完成任务。</p>'}`;
 }
 private setButtons():void{this.panel.querySelectorAll<HTMLButtonElement>('[data-doc-action]').forEach(b=>{b.disabled=this.busy||b.hasAttribute('data-source-blocked')||!this.doc&&b.dataset.docAction!=='create-work';});}
 private click=(event:Event):void=>{
  const target=(event.target as Element).closest<HTMLElement>('[data-dock-tab],[data-doc-section],[data-doc-action]');if(!target||!this.root.contains(target)||this.disposed)return;
  if(target.dataset.dockTab){if(['chat','associations','knowledge'].includes(target.dataset.dockTab))this.show(target.dataset.dockTab as 'chat'|'associations'|'knowledge');return;}
  if(!this.visible)return;
  if(target.dataset.docSection){this.section=target.dataset.docSection==='tasks'?'tasks':'work';this.scene++;this.read++;clearTimeout(this.timer);this.captureDocument();this.notice('');this.updateHeading();void this.refresh();return;}
  if(this.busy||(target as HTMLButtonElement).disabled)return;
  const action=target.dataset.docAction;
  if(action==='refresh'){this.notice('');void this.refresh();return;}
  if(action==='create-work'){void this.options.createWork().catch(e=>{if(!this.disposed)this.notice(errorText(e));});return;}
  const doc=this.doc,scene=this.scene,index=Number(target.dataset.row);if(!doc||!Number.isInteger(index))return;
  const taskVersion=this.taskVersion,sceneCurrent=()=>this.current(scene,doc.id),current=()=>sceneCurrent()&&(action!=='link-task'||taskVersion===this.taskVersion),work=this.works[index],task=this.candidates[index],linked=this.linked[index];
  if(action==='open-work'){if(work&&!work.error)this.options.openWork(work.id);return;}
  let run:(()=>Promise<void|string>)|undefined,success='';
  if(action==='link-work'&&work&&!work.error&&work.relation==='none'){
   if(!this.options.confirm(`将“${doc.title||'当前文档'}”关联到“${work.title}”作为 Work 资料？文档位置和当前对话保持。`))return;
   run=()=>this.options.linkWork(doc.id,{...work},current);success='已关联 Work 资料，当前对话保持不变。';
  }else if(action==='link-task'&&task){
   if(!this.options.confirm(`将“${doc.title||'当前文档'}”关联为任务“${task.title}”的补充资料？\n${this.origin(task)}\n任务 ID：${task.id}\n原主文档、项目和进度保留。`))return;
   run=()=>this.options.linkTask(doc.id,{...task},current);success='已关联为任务补充资料，原主文档保留。';
  }else if(action==='unlink-task'&&linked){
   if(!this.options.confirm(`仅移除当前文档与这条任务的补充资料关联？\n${linked.task.kind==='found'?`${linked.task.value.title}\n${this.origin(linked.task.value)}\n`:''}任务 ID：${linked.taskId}\n任务与文档均保留。`))return;
   run=()=>this.options.unlinkTask(doc.id,linked.taskId,current);success='已移除补充资料关联，任务与文档均保留。';
  }else if(action==='edit-task'&&linked?.task.kind==='found')run=()=>this.options.editTask(doc.id,linked.taskId,current);
  if(!run||!current())return;
  this.busy=true;this.setButtons();this.notice('正在核对…');
  void (async()=>{try{const message=await run();if(current()){await this.refresh();if(current())this.notice(message||success,true);}}
   catch(e){if(current())this.notice(errorText(e),true);}
   finally{this.busy=false;if(!this.disposed){this.setButtons();if(sceneCurrent()&&action==='link-task'&&taskVersion!==this.taskVersion)this.notice('任务已更新，请刷新核对关联结果，再重新确认所选任务。',true);if(this.tasksInvalidated&&this.visible)void this.refresh();}}})();
 };
}
