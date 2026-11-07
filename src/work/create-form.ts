import {trapDialogKey} from './dialog-focus.ts';
import { WorkCreator, type CreateContext, type CreateInput, type CreateResult, type ExistingDocument, type Notebook } from './create.ts';
import type { TaskView } from '../task/reader.ts';
import type { PendingOperation } from './store.ts';
import { listWorkTemplates, workTemplateSnapshot } from './templates.ts';
const esc = (v: string) => v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const existingRecovery = (p:PendingOperation):{title:string;goal:string;workReady:boolean;repairAttempted:boolean}|null => {
  try { const v=JSON.parse(p.details);return v?.input?.mode==='current'&&typeof v.workReady==='boolean'&&v.documentId===p.workId?{title:typeof v.input.title==='string'?v.input.title:'',goal:typeof v.input.goal==='string'?v.input.goal:'',workReady:v.workReady,repairAttempted:v.repairAttempted===true}:null; } catch {return null;}
};
const pendingHasTask = (p:PendingOperation):boolean => {try {return Boolean(JSON.parse(p.details)?.input?.taskId);}catch{return false;}};
type Draft = { context: CreateContext | null; input: CreateInput; notebooks: Notebook[]; blankNotebookId: string; contextNotebookId: string; selectedDocument: ExistingDocument | null; query: string; results: ExistingDocument[]; searchGeneration: number; searching: boolean; searchError: string; tasks: TaskView[]; taskQuery:string; taskResults:TaskView[]; selectedTask:TaskView|null; taskSearchGeneration:number; taskSearching:boolean; taskSearchError:string; pending: PendingOperation[]; deferred:Set<string>; taskError: string; locationError: string; error: string; notice:string; loadFailed: boolean; loading: boolean; busy: boolean; result: CreateResult | null };

/** Shared form for Home and the current-document side action. Nothing automatically navigates after a write. */
export class WorkCreateForm {
  private element?: HTMLElement;
  private returnFocus?:HTMLElement;
  private optionalGoal=false;
  private optionalTask=false;
  private draft?: Draft;
  private taskSearchTimer?:ReturnType<typeof setTimeout>;
  constructor(private readonly creator: WorkCreator, private readonly enter: (id: string) => Promise<void>, private readonly defaultNotebookId: () => string | Promise<string> = () => '', private readonly openDocument?:(id:string)=>Promise<void>) {}
  async open(context: CreateContext | null, initialMode: CreateInput['mode'] = 'blank'): Promise<void> {
    if (this.element) { this.element.querySelector<HTMLElement>('button')?.focus(); return; }
    const frozen = context ? { ...context } : null;
    const draft: Draft = {context:frozen,input:{mode:initialMode,documentId:null,title:'',goal:'',notebookId:'',taskId:null},notebooks:[],blankNotebookId:'',contextNotebookId:'',selectedDocument:null,query:'',results:[],searchGeneration:0,searching:false,searchError:'',tasks:[],taskQuery:'',taskResults:[],selectedTask:null,taskSearchGeneration:0,taskSearching:false,taskSearchError:'',pending:[],deferred:new Set(),taskError:'正在读取最近未完成任务，可跳过',locationError:'',error:'',notice:'',loadFailed:false,loading:true,busy:false,result:null};
    this.returnFocus=document.activeElement as HTMLElement;this.optionalGoal=false;this.optionalTask=false;
    this.draft=draft;
    this.element=document.createElement('div');this.element.className='sac-create-overlay';
    this.element.addEventListener('input',event=>this.input(event));this.element.addEventListener('change',event=>this.input(event));
    this.element.addEventListener('keydown',event=>{if(this.element)trapDialogKey(event,this.element,Boolean(this.draft?.busy||this.draft?.loading),()=>this.dispose());});
    this.element.addEventListener('click',event=>{void this.click(event);});document.body.appendChild(this.element);this.render();
    // Task availability never holds the main form hostage.
    void this.creator.recentTasks().then(tasks=>{if(this.draft!==draft)return;draft.tasks=tasks.kind==='found'?tasks.value.filter(t=>!t.completed):[];draft.taskError=tasks.kind==='unavailable'?tasks.reason:'';this.renderTaskSelect();this.renderTaskAvailability();}).catch(error=>{if(this.draft===draft){draft.taskError=errorText(error);this.renderTaskSelect();this.renderTaskAvailability();}});
    const [prepared,pending]=await Promise.allSettled([Promise.resolve().then(()=>this.defaultNotebookId()).then(id=>this.creator.prepare(frozen,id)),this.creator.pending()]);
    if(this.draft!==draft)return;
    if(pending.status==='fulfilled')draft.pending=pending.value;else draft.error=`未决操作读取失败：${errorText(pending.reason)}`;
    if(prepared.status==='fulfilled'){
      const data=prepared.value;draft.context=data.context;draft.notebooks=data.notebooks;draft.blankNotebookId=data.notebookId;draft.input.notebookId=data.notebookId;draft.contextNotebookId=data.contextNotebookId??data.notebookId;draft.locationError=data.locationError;
      if(initialMode==='current')this.chooseCaptured(draft);
    }else draft.error += ` 保存位置读取失败：${errorText(prepared.reason)}`;
    draft.loadFailed=Boolean(draft.error);draft.loading=false;this.render();
  }
  dispose(): void { if(this.taskSearchTimer)clearTimeout(this.taskSearchTimer);this.element?.remove();this.element=undefined;this.draft=undefined;this.returnFocus?.isConnected&&this.returnFocus.focus();this.returnFocus=undefined; }
  private input(event: Event): void {
    const draft=this.draft,target=event.target as HTMLInputElement;if(!draft||draft.busy||draft.result)return;
    if(target.name==='mode') {
      draft.input.mode=target.value==='current'?'current':'blank';
      delete draft.input.template;
      if(draft.input.mode==='current')this.chooseCaptured(draft);
      else {draft.input.documentId=null;draft.input.title='';draft.input.notebookId=draft.blankNotebookId;}
      this.render();
    }
    else if(target.name==='template'&&draft.input.mode==='blank'){
      draft.input.template=workTemplateSnapshot(target.value);this.render();
      this.element?.querySelector<HTMLSelectElement>('[name="template"]')?.focus();
    }
    else if(target.name==='title'&&draft.input.mode==='blank')draft.input.title=target.value;
    else if(target.name==='goal'){draft.input.goal=target.value;const summary=this.element?.querySelector('[data-create-goal-summary]');if(summary)summary.textContent=target.value.slice(0,50)||'稍后再加';}
    else if(target.name==='notebook'){draft.input.notebookId=target.value;draft.blankNotebookId=target.value;}
    else if(target.name==='task'){const selected=this.taskOptions(draft).find(t=>t.id===target.value);draft.selectedTask=selected?{...selected}:null;draft.input.taskId=draft.selectedTask?.id||null;this.updateTaskSummary();}
    else if(target.name==='taskSearch'&&event.type==='input'){
      draft.taskQuery=target.value;draft.taskResults=[];draft.taskSearchError='';draft.taskSearching=Boolean(target.value.trim());
      const generation=++draft.taskSearchGeneration;if(this.taskSearchTimer)clearTimeout(this.taskSearchTimer);this.renderTaskResults();this.renderTaskSelect();
      if(draft.taskSearching)this.taskSearchTimer=setTimeout(()=>void this.searchTasks(draft,generation),150);
    }
    else if(target.name==='documentSearch'&&event.type==='input'){
      draft.query=target.value;void this.searchDocuments(draft);
    }
  }
  private chooseCaptured(draft:Draft):void {
    const context=draft.context;
    draft.selectedDocument=context?{id:context.documentId,title:context.title,notebookId:draft.contextNotebookId}:null;
    draft.input.documentId=draft.selectedDocument?.id||null;
    draft.input.notebookId=draft.selectedDocument?.notebookId||'';
    draft.input.title=draft.selectedDocument?.title||'';
  }
  private async searchDocuments(draft:Draft):Promise<void> {
    const generation=++draft.searchGeneration,query=draft.query.trim();
    draft.results=[];draft.searchError='';draft.searching=Boolean(query);this.renderResults();
    if(!query)return;
    try {
      const rows=await this.creator.searchDocuments(query,draft.notebooks.map(n=>n.id));
      if(this.draft!==draft||generation!==draft.searchGeneration)return;
      draft.results=rows;
    }catch(error){if(this.draft!==draft||generation!==draft.searchGeneration)return;draft.searchError=errorText(error);}
    if(this.draft!==draft||generation!==draft.searchGeneration)return;
    draft.searching=false;this.renderResults();
  }
  private resultsMarkup(d:Draft):string {
    if(d.searching)return '<p>正在搜索文档…</p>';
    if(d.searchError)return `<p role="alert">搜索失败：${esc(d.searchError)}</p>`;
    if(!d.query.trim())return '<p>输入文档标题关键字查找其他文档。</p>';
    if(!d.results.length)return '<p>没有找到匹配的文档。</p>';
    return d.results.map(row=>`<button type="button" data-create-action="choose-document" data-document-id="${esc(row.id)}">${esc(row.title)} · ${esc(d.notebooks.find(n=>n.id===row.notebookId)?.name||row.notebookId)}<br><small>${esc(row.id)}</small></button>`).join('');
  }
  private renderResults():void {const target=this.element?.querySelector<HTMLElement>('[data-create-results]'),draft=this.draft;if(target&&draft)target.innerHTML=this.resultsMarkup(draft);}
  private taskOptions(d:Draft):TaskView[] {return [...new Map([...d.tasks,...d.taskResults,...(d.selectedTask?[d.selectedTask]:[])].map(t=>[t.id,t])).values()];}
  private taskOptionsMarkup(d:Draft):string {return '<option value="">不关联任务，稍后再选</option>'+this.taskOptions(d).map(t=>`<option value="${esc(t.id)}" ${t.id===d.input.taskId?'selected':''}>${esc(t.title)}</option>`).join('');}
  private updateTaskSummary():void{const summary=this.element?.querySelector('[data-create-task-summary]');if(summary)summary.textContent=this.draft?.selectedTask?.title||'暂不关联';}
  private renderTaskAvailability():void{const target=this.element?.querySelector('[data-create-task-availability]');if(target&&this.draft)target.textContent=this.draft.taskError?'最近任务暂不可用：'+this.draft.taskError+'。仍可搜索或不关联任务。':'';}
  private renderTaskSelect():void {const select=this.element?.querySelector<HTMLSelectElement>('[name="task"]');if(select&&this.draft)select.innerHTML=this.taskOptionsMarkup(this.draft);this.updateTaskSummary();}
  private taskResultsMarkup(d:Draft):string {
    if(d.taskSearching)return '<p role="status">正在搜索未完成任务…</p>';
    if(d.taskSearchError)return `<p role="alert">任务搜索失败：${esc(d.taskSearchError)}。仍可跳过任务。</p>`;
    if(!d.taskQuery.trim())return '';
    return d.taskResults.map(task=>`<button type="button" data-create-action="choose-task" data-task-id="${esc(task.id)}" ${d.busy?'disabled':''}>选择：${esc(task.title)}</button>`).join('')||'<p>没有匹配的未完成任务。</p>';
  }
  private renderTaskResults():void {const target=this.element?.querySelector<HTMLElement>('[data-create-task-results]');if(target&&this.draft)target.innerHTML=this.taskResultsMarkup(this.draft);}
  private async searchTasks(d:Draft,generation:number):Promise<void> {
    try {const result=await this.creator.searchTasks(d.taskQuery.trim());if(this.draft!==d||generation!==d.taskSearchGeneration)return;
      d.taskResults=result.kind==='found'?result.value.filter(t=>!t.completed):[];d.taskSearchError=result.kind==='unavailable'?result.reason:'';
    }catch(error){if(this.draft!==d||generation!==d.taskSearchGeneration)return;d.taskSearchError=errorText(error);}
    if(this.draft!==d||generation!==d.taskSearchGeneration)return;d.taskSearching=false;this.renderTaskResults();this.renderTaskSelect();
  }
  private async click(event: Event): Promise<void> {
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-create-action]'),draft=this.draft;
    if(!button||!draft||draft.busy)return;
    const action=button.dataset.createAction;
    if(action==='close'){if(!draft.loading)this.dispose();return;}
    if(action==='reload'){const captured=draft.context,mode=draft.input.mode;this.dispose();await this.open(captured,mode);return;}
    if(action==='captured'){this.chooseCaptured(draft);this.render();return;}
    if(action==='choose-task'){const task=draft.taskResults.find(t=>t.id===button.dataset.taskId);if(task){draft.selectedTask={...task};draft.input.taskId=task.id;this.renderTaskSelect();}return;}
    if(action==='choose-document'){
      const selected=draft.results.find(row=>row.id===button.dataset.documentId);
      if(!selected)return;
      draft.selectedDocument=selected;draft.input.documentId=selected.id;draft.input.notebookId=selected.notebookId;draft.input.title=selected.title;this.render();return;
    }
    if(action==='set-aside'&&!window.confirm('保留这条待核对记录，并另建其他 Work？原文档、已有关联和创建记录均保留，原文档仍需核对。'))return;
    if(action==='repair'){
      const pending=draft.pending.find(p=>p.id===button.dataset.operation),existing=pending&&existingRecovery(pending);
      if(!pending?.workId||!existing?.goal.trim()){draft.error='旧创建记录没有可核对的目标，请人工核对文档';this.render();return;}
      const prompt=existing.repairAttempted
        ? `核对这篇 Work：${existing.title||pending.workId}\n\n上次修复写入的结果尚未确认。本次不会再次补写目标；若读回一致，将继续原创建的剩余关联。\n\n旧记录目标：${existing.goal}\n\n确认核对？`
        : `修复这篇 Work：${existing.title||pending.workId}\n\n将旧记录中的目标写到该文档最上方，保留原有内容和关系。\n\n目标：${existing.goal}\n\n确认写入并继续原创建？`;
      if(!window.confirm(prompt))return;
    }
    if(action==='without-goal'){
      const pending=draft.pending.find(p=>p.id===button.dataset.operation),existing=pending&&existingRecovery(pending);
      if(!existing?.goal.trim()||existing.repairAttempted){draft.error='上次目标写入仍需核对，不能直接跳过';this.render();return;}
      if(!window.confirm(`继续使用这篇 Work：${existing.title||pending?.workId}\n\n不补写、不采用旧创建记录中的目标：“${existing.goal}”。文档原有内容和关系保留，之后可在 Work 管理页单独添加目标。\n\n确认无目标继续？`))return;
    }
    draft.busy=true;draft.error='';this.render();
    try {
      if(action==='open-pending'){const p=draft.pending.find(p=>p.id===button.dataset.operation);if(p?.workId&&this.openDocument)await this.openDocument(p.workId);return;}
      if(action==='set-aside'){const id=button.dataset.operation||'';await this.creator.setAsideExistingCreation(id,true);if(this.draft!==draft)return;draft.pending=await this.creator.pending();draft.deferred.add(id);draft.result=null;draft.notice='上一条创建记录仍保留待核对。可以选择其他文档或新建工作文档；原文档不能重复提交。';return;}
      if(action==='enter'&&draft.result?.work){await this.enter(draft.result.work.id);if(this.draft===draft)this.dispose();return;}
      const result=action==='submit'?await this.creator.submit({...draft.input,taskSelection:draft.selectedTask?{id:draft.selectedTask.id,title:draft.selectedTask.title,documentId:draft.selectedTask.documentId??null,projectId:draft.selectedTask.projectId??null}:undefined}):action==='repair'?await this.creator.repairExistingCreation(button.dataset.operation||'',true):action==='without-goal'?await this.creator.continueWithoutGoal(button.dataset.operation||'',true):await this.creator.resume(button.dataset.operation||'',action==='skip');
      if(this.draft!==draft)return;
      draft.result=result;
      // Do not hide a success/partial result if re-reading local recovery metadata fails.
      try{draft.pending=await this.creator.pending();}catch(error){draft.error=`未决记录读取失败：${errorText(error)}`;}
    }catch(error){if(this.draft===draft)draft.error=errorText(error);}
    finally{if(this.draft===draft){draft.busy=false;this.render();}}
  }
  private render(): void {
    const d=this.draft,e=this.element;if(!d||!e)return;
    this.optionalGoal=e.querySelector<HTMLDetailsElement>('[data-create-optional="goal"]')?.open??this.optionalGoal;this.optionalTask=e.querySelector<HTMLDetailsElement>('[data-create-optional="task"]')?.open??this.optionalTask;
    const disabled=d.busy||d.loading?'disabled':'';
    const templateFields=d.input.mode==='blank'?`<label>文档模板<select name="template">${listWorkTemplates().map(t=>`<option value="${t.id}" ${(d.input.template?.id||'blank')===t.id?'selected':''}>${esc(t.title)}</option>`).join('')}</select></label>${d.input.template?`<details class="sac-create-template" open><summary>模板完整预览</summary><p>以下正文将在新文档中一次创建；工作目标与任务仍可留空。</p><pre data-create-template-preview>${esc(d.input.template.markdown)}</pre></details>`:'<p>空白文档不添加模板正文；目标与任务仍可稍后选择。</p>'}`:'';
    const options=d.notebooks.map(n=>`<option value="${esc(n.id)}" ${n.id===d.input.notebookId?'selected':''}>${esc(n.name)} · ${d.input.mode==='blank'?'根目录':'原文档位置'}</option>`).join('');
    const pending=d.pending.map(p=>{
      const existing=existingRecovery(p),canRepair=Boolean(existing?.goal.trim()),showRepair=canRepair&&!existing?.workReady,needsGoalChoice=showRepair&&!existing?.repairAttempted;
      const repairText=existing?.workReady
        ? '上次记录显示 Work 已建立；请继续核对剩余关联。目标不会再次补写。'
        : existing?.repairAttempted
        ? '上次修复结果尚未确认。再次点击只核对原文档，不会重新写入目标。'
        : '修复时会在原文档最上方补入目标，再读回核对；原有内容和关联保留。';
      return `<article><p>${existing?'上次选用的现有文档':'上次未完成的文档创建'}：${esc(existing?.title||p.workId||'结果尚未确认')}。这是上次操作的目标。${d.deferred.has(p.id)?'记录仍保留待核对，本轮已明确选择另建其他 Work。':''}</p><details><summary>核对信息</summary>${esc(p.id)}${p.workId?` · 文档 ${esc(p.workId)}`:''}</details>${canRepair?`<p class="sac-create-repair-goal">上次填写的目标：${esc(existing!.goal)}</p><p>${repairText}</p>`:''}${p.workId&&this.openDocument?`<button data-create-action="open-pending" data-operation="${esc(p.id)}" ${disabled}>打开问题文档</button> `:''}${showRepair?`<button data-create-action="repair" data-operation="${esc(p.id)}" ${disabled}>${existing!.repairAttempted?'核对修复结果':'修复这篇 Work（补写旧目标）'}</button> `:''}${needsGoalChoice?`<button data-create-action="without-goal" data-operation="${esc(p.id)}" ${disabled}>无需目标，继续 Work</button> `:''}${!showRepair?`<button data-create-action="resume" data-operation="${esc(p.id)}" ${disabled}>${existing?.workReady?'继续核对剩余关联':'核对并继续'}</button> `:''}${!showRepair&&pendingHasTask(p)?`<button data-create-action="skip" data-operation="${esc(p.id)}" ${disabled}>核对并跳过任务</button>`:''}${existing?` <button data-create-action="set-aside" data-operation="${esc(p.id)}" ${disabled}>保留记录，另建 Work</button><p>另建时仍会保留原文档、已有关联和创建记录；重启后须继续核对。</p>`:''}</article>`;
    }).join('');
    const existing=d.input.mode==='current'?`${d.context?`<button type="button" data-create-action="captured">选择打开主页前的文档：${esc(d.context.title)}</button>`:''}<label>搜索其他现有文档<input name="documentSearch" value="${esc(d.query)}" placeholder="输入文档标题关键字" maxlength="100"></label><div class="sac-create-results" data-create-results>${this.resultsMarkup(d)}</div><div class="sac-create-selected">${d.selectedDocument?`已选主文档：${esc(d.selectedDocument.title)}`:'请选择一篇现有文档作为 Work 主文档。'}<br>填写目标时才在正文最上方加入目标；留空则只绑定 Work，原有内容保留。${d.selectedDocument?`<details><summary>查看文档 ID</summary>${esc(d.selectedDocument.id)}</details>`:''}</div>`:'';
    const taskFields=`<label>最近未完成任务 · 可选<select name="task">${this.taskOptionsMarkup(d)}</select></label><label>搜索其他未完成任务<input name="taskSearch" value="${esc(d.taskQuery)}" placeholder="搜索任务标题或备注" maxlength="100"></label><div class="sac-create-results" data-create-task-results>${this.taskResultsMarkup(d)}</div><p data-create-task-availability>${d.taskError?`最近任务暂不可用：${esc(d.taskError)}。仍可搜索或不关联任务。`:''}</p>`;
    const fields=!d.result&&d.pending.every(p=>d.deferred.has(p.id))?`<fieldset ${disabled}><label>Work 主文档<select name="mode"><option value="blank" ${d.input.mode==='blank'?'selected':''}>新建工作文档</option><option value="current" ${d.input.mode==='current'?'selected':''}>使用现有文档</option></select></label>${existing}${templateFields}<label>名称<input name="title" value="${esc(d.input.title)}" ${d.input.mode==='current'?'readonly':''}></label><label>${d.input.mode==='blank'?'保存位置':'现有文档所在笔记本'}<select name="notebook" ${d.input.mode==='current'?'disabled':''}><option value="">请选择已打开的笔记本</option>${options}</select></label>${d.deferred.size?'<p>请新建工作文档或明确选择其他文档；原问题文档仍需核对。</p>':''}${d.input.mode==='blank'?'<p>将在所选笔记本根目录创建工作文档；默认位置可在设置中修改，本次也可改选。</p>':''}${d.input.mode==='blank'&&d.locationError?`<p>${esc(d.locationError)}</p>`:''}<details class="sac-create-optional" data-create-optional="goal" ${this.optionalGoal?'open':''}><summary>工作目标（可选）<span data-create-goal-summary>${d.input.goal?esc(d.input.goal.slice(0,50)):'稍后再加'}</span></summary><label>希望达成什么<textarea name="goal" rows="3" placeholder="简短描述想达成的结果">${esc(d.input.goal)}</textarea></label></details><details class="sac-create-optional" data-create-optional="task" ${this.optionalTask?'open':''}><summary>关联任务 · 可选<span data-create-task-summary>${d.selectedTask?esc(d.selectedTask.title):'暂不关联'}</span></summary>${taskFields}</details><button data-create-action="submit" ${d.loading||d.loadFailed||(d.input.mode==='current'&&!d.input.documentId)?'disabled':''}>确认建立 Work</button></fieldset>`:'';
    const hadFocus=e.contains(e.ownerDocument.activeElement);
    e.innerHTML=`<section class="sac-create-form" role="dialog" aria-modal="true" aria-label="创建 Work"><header><h2>创建 Work</h2><button data-create-action="close" ${d.busy||d.loading?'disabled':''}>关闭</button></header>${d.loading?'<p>正在读取保存位置与未决操作…</p>':''}${d.notice?`<p role="status">${esc(d.notice)}</p>`:''}${d.error?`<p role="alert">${esc(d.error)}</p>`:''}${d.result?`<p role="status">${esc(d.result.message)}</p>${d.result.work?`<button data-create-action="enter" ${disabled}>进入已建立的 Work</button>`:''}`:''}${pending?`<section class="sac-create-recovery"><h3>上次操作 · 待核对</h3><p>先确认已建立的文档和剩余步骤，避免重复创建。</p>${pending}</section>`:''}${fields}${d.error&&!d.busy?'<button data-create-action="reload">重新读取表单</button>':''}</section>`;
    if(hadFocus||!e.contains(e.ownerDocument.activeElement))e.querySelector<HTMLElement>('button:not([disabled]),select:not([disabled])')?.focus();
  }
}

export const WORK_CREATE_CSS=`.sac-create-overlay{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:16px}.sac-create-form{box-sizing:border-box;width:640px;max-width:100%;max-height:90vh;overflow:auto;padding:24px;border-radius:12px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);box-shadow:var(--b3-dialog-shadow);font-size:14px}.sac-create-form header{display:flex;justify-content:space-between;align-items:center}.sac-create-form h2{margin:0 0 12px}.sac-create-form fieldset{border:0;padding:0;margin:0}.sac-create-form label{display:flex;flex-direction:column;gap:6px;margin:14px 0}.sac-create-form input,.sac-create-form textarea,.sac-create-form select,.sac-create-form button{font:inherit;padding:8px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-surface);color:inherit;min-width:0}.sac-create-form p{line-height:1.6;overflow-wrap:anywhere}.sac-create-form [role=alert]{color:var(--b3-theme-error)}.sac-create-form button{cursor:pointer}.sac-create-form [data-create-action=submit]{background:var(--b3-theme-primary);color:var(--b3-theme-on-primary)}.sac-create-form button:disabled{opacity:.5;cursor:default}.sac-create-optional{margin:14px 0;border:1px solid var(--b3-border-color);border-radius:9px;padding:12px}.sac-create-optional summary{cursor:pointer;font-weight:600;line-height:1.6}.sac-create-optional summary span{display:block;font-size:12px;font-weight:400;color:var(--b3-theme-on-surface);overflow-wrap:anywhere;margin-top:4px}.sac-create-recovery{padding:16px;background:var(--b3-theme-surface);border:1px solid var(--b3-border-color);border-radius:12px;margin:16px 0}.sac-create-recovery article{padding:12px 0;border-top:1px solid var(--b3-border-color)}.sac-create-recovery h3{margin:0}.sac-create-form [data-create-action=submit]{width:100%;margin-top:10px}.sac-create-form button:focus-visible,.sac-create-form summary:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:2px}.sac-create-template{margin:14px 0;padding:12px;border:1px solid var(--b3-border-color);border-radius:9px}.sac-create-template summary{cursor:pointer;font-weight:600}.sac-create-template pre{font:inherit;line-height:1.7;white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;margin:8px 0}.sac-create-form [hidden]{display:none}@media(max-width:480px){.sac-create-form{padding:18px}.sac-create-overlay{padding:10px}}`;
