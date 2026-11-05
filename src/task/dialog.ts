import type { NativeTaskAdapter } from './native.ts';
import type { NativeTaskReader, TaskList, TaskView } from './reader.ts';
import type { WorkController } from '../work/controller.ts';
import { trapDialogKey } from '../work/dialog-focus.ts';

const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
export type TaskDialogTarget={documentId:string|null;title:string;workId?:string;workTitle?:string;isCurrent:()=>boolean;onLinked?:()=>Promise<void>};
type Draft={target:Readonly<TaskDialogTarget>;mode:'create'|'link';workId:string;workTitle:string;works:{id:string;title:string}[];query:string;result:TaskList|null;selected:TaskView|null;selectedDocument:string;busy:boolean;loading:boolean;done:boolean;notice:string;error:string;generation:number;titles:Map<string,string>};

/** The native form has no save result; only an explicitly selected, rechecked task can become a formal relation. */
export class TaskDialog {
 private overlay?:HTMLElement;
 private draft?:Draft;
 private origin?:HTMLElement;
 private searchTimer?:ReturnType<typeof setTimeout>;
 private nativeTarget?:Readonly<TaskDialogTarget>;
 constructor(private readonly document:Document,private readonly options:{
  native:NativeTaskAdapter;reader:Pick<NativeTaskReader,'listRecent'|'search'>;
  controller:Pick<WorkController,'checkSelectableTask'|'linkSelectedTask'>;
  documentTitle:(id:string)=>Promise<string>;readWork:(id:string)=>Promise<{title:string}|null>;
  listWorks:()=>Promise<{id:string;title:string}[]>;
 }){}
 async open(target:TaskDialogTarget,mode:'create'|'link'='create'):Promise<void>{
  if(this.overlay){this.overlay.querySelector<HTMLElement>('button')?.focus();return;}
  const frozen=Object.freeze({...target});
  const draft:Draft={target:frozen,mode,workId:frozen.workId||'',workTitle:frozen.workTitle||'',works:[],query:'',result:null,selected:null,selectedDocument:'',busy:false,loading:true,done:false,notice:'',error:'',generation:0,titles:new Map()};
  this.origin=this.document.activeElement as HTMLElement;this.draft=draft;
  const overlay=this.document.createElement('div');overlay.className='sac-create-overlay';overlay.dataset.taskDialog='';overlay.tabIndex=-1;this.overlay=overlay;
  overlay.addEventListener('click',event=>void this.click(event));
  overlay.addEventListener('keydown',event=>trapDialogKey(event,overlay,Boolean(this.draft?.busy),()=>this.close()));
  overlay.addEventListener('input',event=>{
   const input=event.target as HTMLInputElement;if(!input.matches('[data-task-dialog-query]')||draft.busy)return;
   draft.query=input.value;draft.selected=null;draft.done=false;draft.error='';draft.generation++;this.renderConfirmation();
   if(this.searchTimer)clearTimeout(this.searchTimer);
   draft.loading=true;this.renderResults();const generation=draft.generation;
   this.searchTimer=setTimeout(()=>void this.loadTasks(draft,generation),150);
  });
  overlay.addEventListener('change',event=>{
   const select=event.target as HTMLSelectElement;if(!select.matches('[data-task-dialog-work]')||draft.busy)return;
   draft.workId=select.value;draft.workTitle=draft.works.find(work=>work.id===select.value)?.title||'';draft.selected=null;draft.done=false;draft.error='';this.render();
  });
  this.document.body.append(overlay);this.render();overlay.querySelector<HTMLElement>('button')?.focus();
  try {
   if(draft.workId){const work=await this.options.readWork(draft.workId);if(!work)throw Error('Work 不存在或标记损坏');draft.workTitle=work.title;}
   else draft.works=await this.options.listWorks();
  } catch(error){draft.error=errorText(error);}
  if(this.draft!==draft)return;
  this.render();await this.loadTasks(draft,++draft.generation);
 }
 private current(draft:Draft):boolean{return this.draft===draft&&!!this.overlay?.isConnected&&draft.target.isCurrent();}
 private requireCurrent(draft:Draft):void{if(!this.current(draft))throw Error('页面或 Work 已变化，请关闭后重新核对任务');}
 private async validTarget(draft:Draft):Promise<boolean>{
  if(!this.current(draft))return false;
  if(draft.target.workId&&!await this.options.readWork(draft.target.workId))return false;
  return this.current(draft);
 }
 close():void{if(this.draft?.busy)return;this.dispose();if(this.origin?.isConnected)this.origin.focus();}
 dispose():void{if(this.searchTimer)clearTimeout(this.searchTimer);this.searchTimer=undefined;this.overlay?.remove();this.overlay=undefined;this.draft=undefined;}
 private async loadTasks(draft:Draft,generation:number):Promise<void>{
  if(this.draft!==draft)return;
  draft.loading=true;this.renderResults();
  let result:TaskList;
  try{result=draft.query.trim()?await this.options.reader.search(draft.query.trim()):await this.options.reader.listRecent(5);}
  catch(error){result={kind:'unavailable',reason:errorText(error)};}
  if(this.draft!==draft||draft.generation!==generation)return;
  if(result.kind==='found')await Promise.all([...new Set(result.value.map(task=>task.documentId).filter((id):id is string=>Boolean(id)))].map(async id=>{try{draft.titles.set(id,await this.options.documentTitle(id));}catch{draft.titles.set(id,'文档名称暂不可读取');}}));
  if(this.draft!==draft||draft.generation!==generation)return;
  draft.result=result;draft.loading=false;this.renderResults();
 }
 private async click(event:Event):Promise<void>{
  const button=(event.target as Element).closest<HTMLButtonElement>('button'),draft=this.draft;
  if(!button||!draft||button.disabled||draft.busy)return;
  const action=button.dataset.taskDialogAction;
  if(action==='close'){this.close();return;}
  if(action==='refresh'){draft.selected=null;draft.done=false;draft.error='';this.renderConfirmation();await this.loadTasks(draft,++draft.generation);return;}
  if(action==='prepare-next'){
   const state=this.options.native.getState();
   if(!['opened','unknown'].includes(state.kind))return;
   if(!this.document.defaultView?.confirm('请先在任务插件核对并返回搜索已有任务。准备下一次不会证明上次未创建，也不会关闭原生表单。确认已核对，并准备另一次原生创建？'))return;
   this.options.native.prepareNext();this.nativeTarget=undefined;this.render();return;
  }
  draft.busy=true;draft.error='';this.render();
  try {
   this.requireCurrent(draft);
   if(action==='open-native'){
    const state=this.options.native.getState();
    if(['opening','opened','unknown'].includes(state.kind))return;
    this.nativeTarget=draft.target;
    await this.options.native.open({documentId:draft.target.documentId,workId:draft.target.workId,isCurrent:()=>this.validTarget(draft)});
   }else if(button.dataset.taskDialogSelect){
    if(!draft.workId)throw Error('请先明确选择要关联的 Work');
    const workId=draft.workId;
    if(!await this.options.readWork(workId))throw Error('Work 不存在或标记损坏');
    this.requireCurrent(draft);
    const selected=await this.options.controller.checkSelectableTask(button.dataset.taskDialogSelect,workId);
    this.requireCurrent(draft);
    const title=selected.documentId?await this.options.documentTitle(selected.documentId).catch(()=> '文档名称暂不可读取'):'';
    this.requireCurrent(draft);
    draft.selected=Object.freeze({...selected});draft.selectedDocument=title;draft.done=false;
   }else if(action==='confirm-link'&&draft.selected&&!draft.done){
    const selected=draft.selected;
    await this.options.controller.linkSelectedTask(draft.workId,selected,()=>this.current(draft));
    draft.done=true;draft.selected=null;draft.notice='任务已关联到所选 Work；当前文档和对话保持。';
    try{if(this.current(draft))await draft.target.onLinked?.();}catch(error){draft.notice+=` 列表刷新失败，请手动刷新：${errorText(error)}`;}
   }
  }catch(error){if(this.draft===draft){draft.error=errorText(error);draft.selected=null;}}
  finally{if(this.draft===draft){draft.busy=false;this.render();}}
 }
 private resultsMarkup(draft:Draft):string{
  if(draft.loading)return '<p role="status">正在读取任务…</p>';
  if(draft.result?.kind==='unavailable')return `<p role="alert">任务暂不可读取：${esc(draft.result.reason)}。请启用任务工具或恢复连接后刷新。</p>`;
  const tasks=draft.result?.kind==='found'?draft.result.value:[];
  return `<small>${draft.query.trim()?'搜索结果（最多 30 条）':'最近未完成任务'}</small>${tasks.map(task=>`<article><strong>${esc(task.title)}</strong><small>${task.documentId?`文档：${esc(draft.titles.get(task.documentId)||task.documentId)}`:'没有关联文档'}</small><button type="button" data-task-dialog-select="${esc(task.id)}" ${draft.busy||draft.done?'disabled':''}>选择并核对</button></article>`).join('')||'<p>暂无匹配的未完成任务；可刷新或搜索，程序不会自动重新创建。</p>'}`;
 }
 private confirmationMarkup(draft:Draft):string{
  const task=draft.selected;if(!task)return '';
  return `<section class="sac-create-optional" data-task-dialog-confirmation><h3>确认关联到 ${esc(draft.workTitle||draft.workId)}</h3><p>任务：${esc(task.title)}</p><p>${task.documentId?`任务实际文档：${esc(draft.selectedDocument)}${task.documentId!==draft.workId?'（与 Work 主文档不同，以任务实际文档为准）':''}`:'没有关联文档；可以关联任务，但无法打开文档。'}</p><p>项目：${task.projectId?`项目 ID ${esc(task.projectId)}`:'没有项目'}</p><details><summary>查看任务与文档 ID</summary><p>任务 ${esc(task.id)} · 文档 ${esc(task.documentId||'无')} · Work ${esc(draft.workId)}</p></details><p>只保存任务与 Work 的正式关系；确认时重新核对任务，当前会话保持。</p><button type="button" data-task-dialog-action="confirm-link" ${draft.busy?'disabled':''}>确认关联任务</button></section>`;
 }
 private renderResults():void{const node=this.overlay?.querySelector('[data-task-dialog-results]');if(node&&this.draft)node.innerHTML=this.resultsMarkup(this.draft);}
 private renderConfirmation():void{const node=this.overlay?.querySelector('[data-task-dialog-confirmation-slot]');if(node&&this.draft)node.innerHTML=this.confirmationMarkup(this.draft);}
 private render():void{
  const draft=this.draft,overlay=this.overlay;if(!draft||!overlay)return;
  const focused=this.document.activeElement,ownsFocus=!!focused&&overlay.contains(focused);
  const state=this.options.native.getState(),locked=['opening','opened','unknown'].includes(state.kind);
  const disabled=draft.busy?'disabled':'';
  const previous=locked&&this.nativeTarget?`<p>已发起的目标：${esc(this.nativeTarget.title||'没有目标文档')} ${this.nativeTarget.workTitle?`· ${esc(this.nativeTarget.workTitle)}`:''}</p>`:'';
  overlay.innerHTML=`<section class="sac-create-form" role="dialog" aria-modal="true" aria-label="任务创建与关联"><header><h2>${draft.mode==='create'?'原生任务与关联':'关联已有任务'}</h2><button type="button" data-task-dialog-action="close" ${disabled}>关闭</button></header><p>已固定目标：${draft.target.documentId?esc(draft.target.title||'目标文档'):'没有目标文档，将打开原生日历'}</p>${draft.target.documentId?`<details><summary>查看目标文档 ID</summary>${esc(draft.target.documentId)}</details>`:''}${draft.target.workId?`<p>关联 Work：${esc(draft.workTitle||draft.workId)}</p>`:`<label>关联到 Work（可选）<select data-task-dialog-work ${disabled}><option value="">先选择 Work，再手选任务</option>${draft.works.map(work=>`<option value="${esc(work.id)}" ${work.id===draft.workId?'selected':''}>${esc(work.title)}</option>`).join('')}</select></label>`}${draft.error?`<p role="alert">${esc(draft.error)}</p>`:''}${draft.notice?`<p role="status">${esc(draft.notice)}</p>`:''}${draft.mode==='create'||locked?`<section class="sac-create-optional"><p>项目、名称和最终关联文档在原生表单中填写。保存后返回这里刷新或搜索，明确手选任务再关联。</p>${previous}${state.reason?`<p role="status">${esc(state.reason)}</p>`:''}<button type="button" data-task-dialog-action="open-native" ${draft.busy||locked?'disabled':''}>${draft.target.documentId?'打开原生任务表单':'打开原生日历'}</button>${['opened','unknown'].includes(state.kind)?`<button type="button" data-task-dialog-action="prepare-next" ${disabled}>已返回核对，准备下一次</button>`:''}</section>`:''}<label>搜索未完成任务<input data-task-dialog-query maxlength="100" placeholder="搜索任务标题或备注" value="${esc(draft.query)}" ${disabled}></label><button type="button" data-task-dialog-action="refresh" ${disabled}>${draft.query.trim()?'刷新搜索':'刷新最近任务'}</button><div data-task-dialog-results>${this.resultsMarkup(draft)}</div><div data-task-dialog-confirmation-slot>${this.confirmationMarkup(draft)}</div></section>`;
  if(ownsFocus&&!overlay.contains(this.document.activeElement))overlay.focus();
 }
}
