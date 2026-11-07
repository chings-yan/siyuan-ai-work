import { sessionChoices, sessionLabel, sessionKey, type SessionChoice } from './sessions.ts';
import { workStatusLabels as statuses, workStatusDescriptions } from './status-ui.ts';
import type { CatalogSnapshot, CatalogWork, WorkCatalog } from './catalog.ts';
import type { ChatLink } from './store.ts';
import type { RoomLink } from './room-store.ts';
import type { WorkRecord, WorkStatus } from './service.ts';
import type { NativeTaskReader, TaskList } from '../task/reader.ts';
import { taskProgressLabel } from '../task/presentation.ts';
import { isValidDocumentRootId } from '../core.ts';

export type WorkPageContext = { documentId: string; title: string; focusBlockId: string | null };
export type WorkPageRoute = { kind: 'home' } | { kind: 'list'; mode?: 'enter' | 'link' } | { kind: 'detail'; workId: string; section?: 'documents' | 'tasks' | 'sessions' };
export type WorkPageActions = {
  startDocument?(context: WorkPageContext, isCurrent: () => boolean): Promise<void>;
  enter(workId: string): Promise<void>; resume(workId: string): Promise<void>;
  openDocument(workId: string, documentId: string): Promise<void>; task(taskId: string): Promise<void>;
  create(context: WorkPageContext | null, mode?: 'blank' | 'current'): Promise<void>;
  editTask?(workId:string,taskId:string,current:()=>boolean):Promise<string>;
  settings?():void;createTask?(workId?:string,context?:WorkPageContext|null,current?:()=>boolean):Promise<void>;linkTask?(workId:string,current?:()=>boolean):Promise<boolean|void>; linkDocument(workId: string, context: WorkPageContext, current?:()=>boolean): Promise<boolean | void>;
  addGoal?(workId: string, currentGoal: string): Promise<void>;
  setStatus?(workId:string,status:WorkStatus,expectedStatus:WorkStatus,current:()=>boolean):Promise<boolean>;
  newChat?(workId: string): Promise<void>; associateChat?(workId: string, current?: () => boolean): Promise<void>;
  openChat?(workId: string, link: ChatLink): Promise<void>; associateRoom?(workId: string, current?: () => boolean): Promise<void>;
  openRoom?(workId: string, link: RoomLink): Promise<void>;
};
const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]!);
const button = (action: string, label: string, attributes = '') => `<button type="button" data-page-action="${action}" ${attributes}>${label}</button>`;
const errorMarkup = (error: string) => `<p class="sac-page-error" role="alert">${esc(error)} ${button('refresh','重试读取')}</p>`;

/** Shared by the event owner and trailing reads; hidden native tabs never start task reads. */
export function isWorkPageVisible(root:HTMLElement):boolean {
  if(!root.isConnected||root.ownerDocument.visibilityState==='hidden')return false;
  for(let element:HTMLElement|null=root;element;element=element.parentElement){
    if(element.hidden||element.classList.contains('fn__none')||element.getAttribute('aria-hidden')==='true')return false;
    const style=element.ownerDocument.defaultView?.getComputedStyle(element);if(style?.display==='none'||style?.visibility==='hidden')return false;
  }
  return true;
}
export class WorkPage {
  private route: WorkPageRoute = {kind:'home'};
  private history: {route: WorkPageRoute; query: string; status: WorkStatus | 'all'}[] = [];
  private query = '';
  private status: WorkStatus | 'all' = 'all';
  private snapshot: CatalogSnapshot | null = null;
  private disposed = false;
  private generation = 0;
  private loading = false;
  private pending = false;
  private notice = '';
  private context: WorkPageContext | null;
  private taskQuery='';
  private taskTitles=new Map<string,string>();
  private taskResult:TaskList|null=null;
  private taskLoading=false;
  private taskGeneration=0;
  private taskSearchVersion=0;
  private taskTimer?:ReturnType<typeof setTimeout>;
  private taskRefresh:Promise<void>|null=null;
  private taskRefreshRequest:{route:WorkPageRoute;generation:number}|null=null;
  private tasksInvalidatedDuringLoad=false;
  constructor(private readonly root: HTMLElement, private readonly options: { catalog: Pick<WorkCatalog,'load'>; context: WorkPageContext | null; actions: WorkPageActions; taskReader?:Pick<NativeTaskReader,'search'>&Partial<Pick<NativeTaskReader,'getTask'|'listRecent'>>;taskDocumentTitle?:(id:string)=>Promise<string> }) {
    this.context = options.context;
    root.addEventListener('click', this.click);
    root.addEventListener('input', this.filter);
    root.addEventListener('change', this.filter);
    this.render();
  }
  setContext(context: WorkPageContext | null): void { this.context = context; this.render(); }
  show(route: WorkPageRoute): void {
    if (this.disposed) return;
    if (JSON.stringify(route) !== JSON.stringify(this.route)) {
      this.taskGeneration++;if(this.taskTimer)clearTimeout(this.taskTimer);this.taskLoading=false;this.taskQuery='';this.taskResult=null;
      this.history.push({route:{...this.route},query:this.query,status:this.status});
      if(route.kind!=='detail'){this.query='';this.status='all';}
    }
    this.route = {...route}; this.notice = ''; this.render();
  }
  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.generation;
    this.loading = true; this.render();
    try {
      const snapshot = await this.options.catalog.load();
      if (this.disposed || generation !== this.generation) return;
      const linkedTasks=snapshot.works.flatMap(row=>(row.tasks.value||[]).flatMap(task=>task.lookup.kind==='found'?[task.lookup.value]:[]));
      await this.readTaskTitles([...(snapshot.recentTasks.kind==='found'?snapshot.recentTasks.value:[]),...linkedTasks]);
      if(this.disposed||generation!==this.generation)return;
      this.snapshot = snapshot;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.snapshot = {works:[],continueWorks:[],recentTasks:{kind:'unavailable',reason:'尚未读取'},error:error instanceof Error ? error.message : String(error)};
    }
    if (this.disposed || generation !== this.generation) return;
    this.loading = false; this.render();
    if(this.tasksInvalidatedDuringLoad&&isWorkPageVisible(this.root)){
      this.tasksInvalidatedDuringLoad=false;
      await this.taskRefresh;
      if(!this.disposed&&generation===this.generation)await this.refreshTasks();
    }
  }
  /** Task invalidation never rebuilds filters, status edits, dialogs or the page shell. */
  refreshTasks(): Promise<void> {
    if(this.disposed||!this.options.taskReader||!isWorkPageVisible(this.root))return Promise.resolve();
    if(this.route.kind==='home'&&this.taskQuery.trim())this.taskSearchVersion++;
    if(this.loading){this.tasksInvalidatedDuringLoad=true;return Promise.resolve();}
    if(!this.snapshot)return Promise.resolve();
    this.tasksInvalidatedDuringLoad=false;
    this.taskRefreshRequest={route:this.route,generation:this.generation};
    if(this.taskRefresh)return this.taskRefresh;
    const read=async()=>{
      while(this.taskRefreshRequest){
        const request=this.taskRefreshRequest;this.taskRefreshRequest=null;
        if(this.disposed||this.route!==request.route||this.generation!==request.generation||!isWorkPageVisible(this.root))continue;
        await this.readTasks(request.route,request.generation);
      }
    };
    this.taskRefresh=read().finally(()=>{
      this.taskRefresh=null;
      const queued=this.taskRefreshRequest;
      if(queued&&!this.disposed&&this.route===queued.route&&this.generation===queued.generation&&isWorkPageVisible(this.root))return this.refreshTasks();
      this.taskRefreshRequest=null;
    });
    return this.taskRefresh;
  }
  private async readTasks(route:WorkPageRoute,generation:number):Promise<void> {
    const snapshot=this.snapshot!,reader=this.options.taskReader!,searchGeneration=this.taskGeneration,query=this.taskQuery;
    const current=()=>!this.disposed&&this.snapshot===snapshot&&this.route===route&&this.generation===generation&&isWorkPageVisible(this.root);
      const rows=await Promise.all(snapshot.works.map(async row=>{
        if(!reader.getTask||!row.tasks.value)return row;
        const tasks=await Promise.all(row.tasks.value.map(async link=>{
          if(link.connectionId!=='siyuan-native-local')return link;
          try{return {...link,lookup:await reader.getTask!(link.taskId)};}
          catch(error){return {...link,lookup:{kind:'unavailable' as const,reason:error instanceof Error?error.message:String(error)}};}
        }));
        return {...row,tasks:{value:tasks}};
      }));
      if(!current())return;
      let recent=snapshot.recentTasks,result=this.taskResult,searchVersion:number|undefined;
      if(route.kind==='home'&&searchGeneration===this.taskGeneration&&query===this.taskQuery){
        try{if(query.trim()){searchVersion=++this.taskSearchVersion;result=await reader.search(query.trim());}else if(reader.listRecent)recent=await reader.listRecent(5);}
        catch(error){const unavailable={kind:'unavailable' as const,reason:error instanceof Error?error.message:String(error)};if(query.trim())result=unavailable;else recent=unavailable;}
      }
      if(!current())return;
      await this.readTaskTitles([...rows.flatMap(row=>(row.tasks.value||[]).flatMap(task=>task.lookup.kind==='found'?[task.lookup.value]:[])),...(recent.kind==='found'?recent.value:[]),...(result?.kind==='found'?result.value:[])]);
      if(!current())return;
      const byId=new Map(rows.map(row=>[row.id,row]));
      this.snapshot={...snapshot,works:rows,continueWorks:snapshot.continueWorks.map(row=>byId.get(row.id)||row),recentTasks:recent};
      if(searchGeneration===this.taskGeneration&&query===this.taskQuery&&(searchVersion===undefined||searchVersion===this.taskSearchVersion)){this.taskResult=result;if(searchVersion!==undefined)this.taskLoading=false;this.renderTaskResults();}
      for(const element of this.root.querySelectorAll<HTMLElement>('[data-task-progress]')){
        const row=byId.get(element.dataset.taskProgress!);if(row)element.textContent=this.progressLabel(row);
      }
      if(route.kind==='detail'&&route.section==='tasks'){
        const row=byId.get(route.workId),container=this.root.querySelector<HTMLElement>('[data-linked-tasks]');
        if(row&&container){
          const active=this.root.ownerDocument.activeElement as HTMLElement|null;
          const focused=active&&container.contains(active)?{action:active.dataset.pageAction,taskId:active.dataset.taskId}:null;
          const page=this.root.querySelector<HTMLElement>('.sac-work-page'),scroll=page?.scrollTop;
          container.innerHTML=this.linkedTasks(row);
          if(focused){
            const replacement=[...container.querySelectorAll<HTMLElement>('[data-page-action]')].find(button=>button.dataset.pageAction===focused.action&&button.dataset.taskId===focused.taskId);
            if(replacement)replacement.focus({preventScroll:true});
            else {container.tabIndex=-1;container.focus({preventScroll:true});}
            if(page&&scroll!==undefined)page.scrollTop=scroll;
          }
        }
      }
  }
  dispose(): void {
    this.disposed = true; this.generation++;
    this.taskGeneration++;if(this.taskTimer)clearTimeout(this.taskTimer);
    this.root.removeEventListener('click',this.click);this.root.removeEventListener('input',this.filter);this.root.removeEventListener('change',this.filter);
  }
  private filter = (event: Event): void => {
    const target = event.target as HTMLInputElement;
    if(target.matches('[data-page-task-search]')){
      if(event.type!=='input')return;
      this.taskQuery=target.value;const generation=++this.taskGeneration;if(this.taskTimer)clearTimeout(this.taskTimer);
      this.taskResult=null;this.taskLoading=Boolean(target.value.trim());this.renderTaskResults();
      if(this.taskLoading)this.taskTimer=setTimeout(()=>void this.searchTasks(target.value.trim(),generation),150);return;
    }
    if (target.matches('[data-work-search]')) this.query = target.value;
    else if (target.matches('[data-work-status]')) this.status = target.value as typeof this.status;
    else return;
    // Keep the focused filter and caret intact while updating only its results.
    const cards = this.root.querySelector('[data-work-results]'); if (cards) cards.innerHTML = this.cards();
  };
  private async searchTasks(query:string,generation:number):Promise<void> {
    if(this.disposed||this.route.kind!=='home'||!this.options.taskReader||generation!==this.taskGeneration||query!==this.taskQuery.trim())return;
    const version=++this.taskSearchVersion;
    let result:TaskList;
    try {result=await this.options.taskReader.search(query);}catch(error){result={kind:'unavailable',reason:error instanceof Error?error.message:String(error)};}
    if(this.disposed||generation!==this.taskGeneration||version!==this.taskSearchVersion||this.route.kind!=='home')return;
    if(result.kind==='found')await this.readTaskTitles(result.value);
    if(this.disposed||generation!==this.taskGeneration||version!==this.taskSearchVersion||this.route.kind!=='home')return;
    this.taskResult=result;this.taskLoading=false;this.renderTaskResults();
  }
  private async readTaskTitles(tasks:{documentId:string|null}[]):Promise<void>{
    if(!this.options.taskDocumentTitle)return;
    await Promise.all([...new Set(tasks.map(task=>task.documentId).filter((id):id is string=>Boolean(id)))].map(async id=>{try{const title=await this.options.taskDocumentTitle!(id);if(title)this.taskTitles.set(id,title);}catch{this.taskTitles.delete(id);}}));
  }
  private taskMarkup():string {
    if(this.taskLoading)return '<p role="status">正在搜索未完成任务…</p>';
    const result=this.taskQuery.trim()?this.taskResult:this.snapshot?.recentTasks;
    if(!result)return '<p>正在读取任务…</p>';
    if(result.kind==='unavailable'&&/未注册|未安装/.test(result.reason))return `<div class="sac-task-unavailable"><strong>可选接入任务</strong><p>安装或启用“任务笔记管理”后，可在这里选择待办。现在也可以先建立 Work。</p>${button('refresh','启用后重试')}</div>`;
    if(result.kind==='unavailable')return this.taskQuery.trim()?`<p class="sac-page-error" role="alert">${esc(result.reason)} ${button('retry-task','重试任务搜索')}</p>`:errorMarkup(result.reason);
    if(!result.value.length)return '<p>暂无匹配的未完成任务。</p>';
    return (this.taskQuery.trim()?'<p>搜索结果（最多 30 条）</p>':'')+result.value.map(task=>`<article class="sac-task-row"><div class="sac-task-title"><span aria-hidden="true">○</span><strong>${esc(task.title)}</strong></div>${task.documentId&&this.taskTitles.get(task.documentId)?`<small>文档：${esc(this.taskTitles.get(task.documentId)!)}</small>`:''}${task.documentId!==null?button('task','打开关联文档',`data-task-id="${esc(task.id)}"`):'<small>没有关联文档</small>'}</article>`).join('')||'<p>暂无匹配的未完成任务。</p>';
  }
  private renderTaskResults():void {
    const results=this.root.querySelector<HTMLElement>('[data-page-task-results]');if(!results)return;
    // Read focus at replacement time: an awaited read may outlive a move to a native dialog.
    const active=this.root.ownerDocument.activeElement as HTMLElement|null;
    const focused=active&&results.contains(active)?{action:active.dataset.pageAction,taskId:active.dataset.taskId}:null;
    const page=this.root.querySelector<HTMLElement>('.sac-work-page');
    const top=results.scrollTop,left=results.scrollLeft,pageTop=page?.scrollTop,pageLeft=page?.scrollLeft;
    results.innerHTML=this.taskMarkup();
    if(focused){
      const replacement=focused.action&&focused.taskId?[...results.querySelectorAll<HTMLElement>('[data-page-action][data-task-id]')].find(button=>button.dataset.pageAction===focused.action&&button.dataset.taskId===focused.taskId):undefined;
      (replacement||results).focus({preventScroll:true});
    }
    results.scrollTop=top;results.scrollLeft=left;
    if(page&&pageTop!==undefined&&pageLeft!==undefined){page.scrollTop=pageTop;page.scrollLeft=pageLeft;}
  }
  private click = (event: Event): void => {
    const target = (event.target as Element).closest<HTMLButtonElement>('button[data-page-action]');
    if (!target || this.disposed || target.disabled) return;
    const action = target.dataset.pageAction, id = target.dataset.workId || '';
    if (action === 'back') {
      const previous=this.history.pop();this.route=previous?.route||{kind:'home'};this.query=previous?.query||'';this.status=previous?.status||'all';
      this.notice='';this.render();return;
    }
    if (action === 'home') { this.show({kind:'home'});return; }
    if (action === 'list' || action === 'link-list') { this.show({kind:'list',mode:action === 'link-list' ? 'link' : 'enter'});return; }
    if (action === 'detail') { this.show({kind:'detail',workId:id});return; }
    if (action === 'section' && this.route.kind === 'detail') { this.route={...this.route,section:target.dataset.section as 'documents'|'tasks'|'sessions'};this.render();return; }
    if (action === 'refresh') { void this.refresh();return; }
    if(action==='retry-task'&&this.route.kind==='home'&&this.taskQuery.trim()){
      const generation=++this.taskGeneration;this.taskLoading=true;this.renderTaskResults();void this.searchTasks(this.taskQuery.trim(),generation);return;
    }
    if(action==='metric'){
      const metric=target.dataset.workMetric;
      if(metric!=='documents'&&metric!=='tasks'&&metric!=='hermes'&&metric!=='ekko')return;
      this.show({kind:'detail',workId:id,section:metric==='documents'?'documents':metric==='tasks'?'tasks':'sessions'});
      const focusTarget=metric==='hermes'||metric==='ekko'?`.sac-session-group[data-session-kind="${metric}"]`:`[aria-label="工作内容分类"] [data-section="${metric}"]`;
      this.root.querySelector<HTMLElement>(focusTarget)?.focus();
      return;
    }
    if (this.pending) return;
    if(action==='edit-task'){
      const route=this.route,taskId=target.dataset.taskId;
      const task=route.kind==='detail'?this.snapshot?.works.find(row=>row.id===route.workId)?.tasks.value?.find(row=>row.taskId===taskId):undefined;
      if(route.kind!=='detail'||!taskId||task?.connectionId!=='siyuan-native-local'||task.lookup.kind!=='found'||!this.options.actions.editTask)return;
      const current=()=>!this.disposed&&this.route===route;
      this.pending=true;target.disabled=true;this.updateNotice('正在打开任务…');
      void (async()=>{
        try{const message=await this.options.actions.editTask!(route.workId,taskId,current);if(current())this.updateNotice(message);}
        catch(error){if(current())this.updateNotice(error instanceof Error?error.message:String(error));}
        finally{this.pending=false;if(target.isConnected)target.disabled=false;}
      })();return;
    }
    void this.perform(async () => {
      const actions = this.options.actions;
      if (action === 'enter') await actions.enter(id);
      else if(action==='start-document'&&this.route.kind==='home'&&this.context&&isValidDocumentRootId(this.context.documentId)){
        const route=this.route,context=this.context,current=()=>!this.disposed&&this.route===route&&this.context===context;
        try{await actions.startDocument?.(context,current);}catch(error){if(current())throw error;}
      }
      else if (action === 'resume') await actions.resume(id);
      else if (action === 'document') await actions.openDocument(id,target.dataset.documentId!);
      else if (action === 'task') {
        const route=this.route;
        const task=route.kind==='detail'?this.snapshot?.works.find(row=>row.id===route.workId)?.tasks.value?.find(row=>row.taskId===target.dataset.taskId):undefined;
        if(task?.lookup.kind==='found'&&!task.lookup.value.documentId)throw Error('这项任务没有关联文档，无法打开');
        await actions.task(target.dataset.taskId!);
      }
      else if (action === 'create'||action==='create-existing') await actions.create(this.context,action==='create-existing'?'current':'blank');
      else if(action==='settings')actions.settings?.();
      else if(action==='create-task'){const route=this.route;await actions.createTask?.(route.kind==='detail'?route.workId:undefined,this.context,()=>!this.disposed&&this.route===route);}
      else if(action==='link-task'){const route=this.route;const completed=await actions.linkTask?.(id,()=>!this.disposed&&this.route===route);if(completed!==false&&!this.disposed&&this.route===route)await this.refresh();}
      else if (action === 'add-goal') await actions.addGoal?.(id,this.snapshot?.works.find(row=>row.id===id)?.record.value?.goal||'');
      else if(action==='set-status'){
        const route=this.route,work=this.snapshot?.works.find(row=>row.id===id)?.record.value;
        const status=(target.dataset.nextStatus||target.closest('[data-work-lifecycle]')?.querySelector<HTMLSelectElement>('[data-work-next-status]')?.value) as WorkStatus;
        if(!work || !Object.hasOwn(statuses,status))throw Error('请刷新后重新选择 Work 状态');
        if(status===work.status)return;
        const current=()=>!this.disposed&&this.route===route;
        if(await actions.setStatus?.(id,status,work.status,current) && current()){
          this.notice=`工作状态已更新为“${statuses[status]}”`;await this.refresh();
        }
      }
      else if (action === 'link' && this.context) {
        const route=this.route,context=this.context,current=()=>!this.disposed&&this.route===route&&this.context===context;
        if(await actions.linkDocument(id,context,current)===false||!current())return;
        this.notice='当前文档已关联，原位置和本轮发送资料保持不变';await this.refresh();
      }
      else if (action === 'new-chat') await actions.newChat?.(id);
      else if (action === 'associate-chat') {const route=this.route;await actions.associateChat?.(id,()=>!this.disposed&&this.route===route);}
      else if (action === 'associate-room') {const route=this.route;await actions.associateRoom?.(id,()=>!this.disposed&&this.route===route);}
      else if(action==='session'){const row=this.snapshot?.works.find(row=>row.id===id);const choice=row&&sessionChoices(id,row.chats.value||[],row.rooms.value||[]).find(item=>sessionKey(item)===target.dataset.sessionKey);if(choice?.kind==='hermes')await actions.openChat?.(id,choice.link);else if(choice?.kind==='ekko')await actions.openRoom?.(id,choice.link);}
      else if (action === 'chat') { const link=this.snapshot?.works.find(row=>row.id===id)?.chats.value?.[Number(target.dataset.index)];if(link)await actions.openChat?.(id,link); }
      else if (action === 'room') { const link=this.snapshot?.works.find(row=>row.id===id)?.rooms.value?.[Number(target.dataset.index)];if(link)await actions.openRoom?.(id,link); }
    });
  };
  private updateNotice(message:string):void {
    this.notice=message;
    let notice=this.root.querySelector<HTMLElement>('[data-page-notice]');
    if(!message){notice?.remove();return;}
    if(!notice){
      notice=this.root.ownerDocument.createElement('p');notice.dataset.pageNotice='';notice.className='sac-page-notice';
      notice.setAttribute('role','status');notice.setAttribute('aria-live','polite');this.root.querySelector('.sac-page-header')?.after(notice);
    }
    notice.textContent=message;
  }
  private async perform(operation: () => Promise<void>): Promise<void> {
    this.pending=true;const previousNotice=this.notice;
    try { await operation(); } catch(error) { this.notice=error instanceof Error?error.message:String(error); }
    finally {
      this.pending=false;
      if(!this.disposed&&this.notice!==previousNotice){
        const active=this.root.ownerDocument.activeElement;
        const kind=active?.matches('.sac-session-group[data-session-kind]')?active.getAttribute('data-session-kind'):null;
        const section=active?.matches('.sac-page-tabs [data-section]')?active.getAttribute('data-section'):null;
        this.render();
        if(kind==='hermes'||kind==='ekko')this.root.querySelector<HTMLElement>(`.sac-session-group[data-session-kind="${kind}"]`)?.focus();
        else if(section==='documents'||section==='tasks')this.root.querySelector<HTMLElement>(`.sac-page-tabs [data-section="${section}"]`)?.focus();
      }
    }
  }
  private card(row: CatalogWork): string {
    const work=row.record.value;
    const errors=[...new Set([row.record.error,row.documents.error,row.tasks.error,row.chats.error,row.rooms.error,row.resume.error].filter((x):x is string=>Boolean(x)))];
    const metrics=([['documents','资料',row.documents],['tasks','任务',row.tasks],['hermes','AI 对话',row.chats],['ekko','协作房间',row.rooms]] as const).map(([key,label,result])=>{
      const count=result.error?'读取失败':result.value!.length;
      return `<button type="button" data-page-action="metric" data-work-metric="${key}" data-work-id="${esc(row.id)}" aria-label="查看“${esc(work?.title||row.id)}”的${label}列表，${count}"><span>${label}</span><strong>${count}</strong><span aria-hidden="true">›</span></button>`;
    }).join('');
    return `<article data-work-card="${esc(row.id)}"><div class="sac-page-row"><span class="sac-work-kind">▤ 工作 · Work</span>${work?`<span class="sac-page-tag" data-status="${work.status}">${statuses[work.status]}</span>`:''}</div><h3>${esc(work?.title||row.id)}</h3>${work?.goal?`<p class="sac-work-goal">${esc(work.goal)}</p>`:work?'':'<p>Work 信息暂不可读取</p>'}<div class="sac-work-metrics" role="group" aria-label="工作内容">${metrics}</div><p class="sac-task-progress" data-task-progress="${esc(row.id)}">${esc(this.progressLabel(row))}</p>${errors.map(errorMarkup).join('')}<div class="sac-page-actions">${this.context&&this.context.documentId!==row.id&&work&&(this.route.kind==='home'||this.route.kind==='list'&&this.route.mode==='link')?button('link','关联当前文档作为资料',`data-work-id="${esc(row.id)}"`):''}${work?button('enter','打开工作文档',`data-work-id="${esc(row.id)}"`):''}${work&&this.route.kind==='home'&&this.snapshot?.continueWorks.some(item=>item.id===row.id)?button('resume','继续上次位置',`data-work-id="${esc(row.id)}"`):''}${button('detail','管理',`data-work-id="${esc(row.id)}"`)}</div></article>`;
  }
  private cards(): string {
    const rows=(this.snapshot?.works||[]).filter(row=>{
      const work=row.record.value;
      // Unreadable records remain visible under filters so a failure cannot masquerade as an empty result.
      if(!work)return true;
      return (this.status==='all'||work.status===this.status)&&`${work.title} ${work.goal} ${work.status} ${statuses[work.status]}`.toLocaleLowerCase().includes(this.query.trim().toLocaleLowerCase());
    });
    return rows.map(row=>this.card(row)).join('')||`<p class="sac-page-empty">${this.snapshot?.error?'列表暂不可读取，请重试':this.query||this.status!=='all'?'没有符合条件的 Work':'还没有 Work，可从当前文档建立'}</p>`;
  }
  private filters(): string {
    return `<div class="sac-page-filters"><input data-work-search aria-label="搜索 Work 名称或目标" placeholder="搜索名称、目标或状态" value="${esc(this.query)}"><select data-work-status aria-label="筛选 Work 状态"><option value="all">全部状态</option>${Object.entries(statuses).map(([value,label])=>`<option value="${value}" ${value===this.status?'selected':''}>${label}</option>`).join('')}</select></div><div class="sac-page-grid" data-work-results>${this.cards()}</div>`;
  }
  private lifecycle(work:WorkRecord):string {
    return `<section class="sac-work-lifecycle" data-work-lifecycle aria-label="工作状态"><div><strong>${statuses[work.status]}</strong><span>${workStatusDescriptions[work.status]}</span></div>${this.options.actions.setStatus?`<div class="sac-page-actions">${work.status==='completed'||work.status==='closed'||work.status==='paused'?button('set-status','恢复工作',`data-work-id="${esc(work.id)}" data-next-status="active"`):''}${work.status!=='completed'?button('set-status','完成 Work',`data-work-id="${esc(work.id)}" data-next-status="completed"`):''}</div><details><summary>更改状态／结束工作</summary><p>达到预期结果后，手动标记“已完成”；不再推进时标记“已关闭”。任务完成或 AI 回复结束不会自动结束 Work，文档、资料与会话会继续保留。</p><div class="sac-page-actions"><label>改为 <select data-work-next-status aria-label="新的工作状态">${Object.entries(statuses).map(([value,label])=>`<option value="${value}" ${value===work.status?'selected':''}>${label}</option>`).join('')}</select></label>${button('set-status','确认更改',`data-work-id="${esc(work.id)}"`)}</div></details>`:''}</section>`;
  }
  private sessionGroup(id:string,kind:SessionChoice['kind'],choices:SessionChoice[],error?:string):string {
    const hermes=kind==='hermes',label=hermes?'AI 对话':'协作房间';
    const actions=hermes?`${this.options.actions.newChat?button('new-chat','新建 Hermes 对话',`data-work-id="${esc(id)}"`):''}${this.options.actions.associateChat?button('associate-chat','关联已有对话',`data-work-id="${esc(id)}"`):''}`:this.options.actions.associateRoom?button('associate-room','关联 EKKO 房间',`data-work-id="${esc(id)}"`):'';
    const rows=choices.filter(choice=>choice.kind===kind).map(choice=>`<article class="sac-session-row"><div><strong>${esc(sessionLabel(choice))}</strong><details class="sac-session-metadata"><summary>查看关联信息</summary><small>${esc(choice.kind==='hermes'?`ID：${choice.link.chatId} · 连接：${choice.link.connectionId} · 绑定文档：${choice.link.documentRootId}`:`房间 ${choice.link.roomId} · 账号 ${choice.link.accountUserId} · 设备 ${choice.link.deviceId}`)}</small></details></div>${button('session',hermes?'打开对话':'进入房间',`data-work-id="${esc(id)}" data-session-key="${esc(sessionKey(choice))}"`)}</article>`).join('');
    return `<section class="sac-session-group" data-session-kind="${kind}" aria-label="${label}" tabindex="-1"><div class="sac-section-heading"><h3>${label} <span>${hermes?'Hermes':'EKKO'}</span></h3><div class="sac-page-actions">${actions}</div></div><p>${hermes?'同一 Work 的多条对话列在下方；点“打开对话”切换。进入此 Work 后，也可用侧栏顶部的会话选择器。':'成员与 Agent 共同讨论，消息发送到房间。'}</p>${error?errorMarkup(error):rows||`<p class="sac-page-empty">尚未关联${label}。</p>`}</section>`;
  }
  private progressLabel(row:CatalogWork):string {return row.tasks.error?'任务统计暂不可读取':`${row.tasks.value!.length?'关联任务 ':''}${taskProgressLabel(row.tasks.value!.map(task=>task.lookup))}`;}
  private linkedTasks(row:CatalogWork):string {
    if(row.tasks.error)return errorMarkup(row.tasks.error);
    return row.tasks.value!.map(task=>`<article><strong>${esc(task.lookup.kind==='found'?task.lookup.value.title:task.taskId)}</strong>${task.lookup.kind==='unavailable'?errorMarkup(task.lookup.reason):task.lookup.kind==='missing'?'<p>任务已不存在；保留原关联供核对。</p>':`<small>${task.lookup.value.completed?'已完成':'未完成'}</small>${typeof task.lookup.value.customProgress==='number'?`<small>任务插件进度：${task.lookup.value.customProgress}%</small>`:''}${task.lookup.value.documentId?`${this.taskTitles.get(task.lookup.value.documentId)?`<small>文档：${esc(this.taskTitles.get(task.lookup.value.documentId)!)}</small>`:''}${!task.lookup.value.completed?button('task','打开关联文档',`data-task-id="${esc(task.taskId)}"`):''}`:'<small>没有关联文档</small>'}${task.connectionId==='siyuan-native-local'&&this.options.actions.editTask?button('edit-task','在任务插件中编辑',`data-work-id="${esc(row.id)}" data-task-id="${esc(task.taskId)}"`):''}`}</article>`).join('')||'<p>未关联任务，可随时跳过。</p>';
  }
  private details(id: string, section='documents'): string {
    const row=this.snapshot?.works.find(item=>item.id===id);if(!row)return this.snapshot?.error?errorMarkup(this.snapshot.error):'<p>Work 尚未载入，请刷新核对。</p>';
    const work=row.record.value;
    const heading=`<span class="sac-work-kind">工作 · Work</span><h2>${esc(work?.title||id)}</h2><p>${esc(work?work.goal:row.record.error||'')}</p><div class="sac-page-actions">${work?button('enter','打开工作文档',`data-work-id="${esc(id)}"`):''}${work&&this.options.actions.addGoal?button('add-goal',work.goal?'查看／核对目标':'添加目标（可选）',`data-work-id="${esc(id)}"`):''}</div>${work?this.lifecycle(work):''}<p class="sac-task-progress" data-task-progress="${esc(id)}">${esc(this.progressLabel(row))}</p><nav class="sac-page-actions sac-page-tabs" aria-label="工作内容分类">${([['documents','文档与资料'],['tasks','关联任务'],['sessions','AI 对话与房间']] as const).map(([key,label])=>button('section',label,`data-section="${key}" ${section===key?'aria-current="page"':''}`)).join('')}</nav>`;
    if(section==='documents')return heading+`<p>点击文档在思源原生编辑器中打开；外部资料保留原位。</p>${row.documents.error?errorMarkup(row.documents.error):row.documents.value!.map(doc=>`<article><strong>${esc(doc.title.value||doc.id)}</strong><small>${doc.kind==='root'?'Work 根文档':doc.kind==='child'?'子文档':'外部资料'}</small>${doc.title.error?errorMarkup(doc.title.error):''}${button('document','打开文档',`data-work-id="${esc(id)}" data-document-id="${esc(doc.id)}"`)}</article>`).join('')}`;
    if(section==='tasks')return heading+`<div class="sac-page-actions">${this.options.actions.linkTask?button('link-task','关联已有任务',`data-work-id="${esc(id)}"`):''}${this.options.actions.createTask?button('create-task','在任务插件中新建'):''}</div><p>任务是可选待办；没有任务也可以推进 Work。</p><div data-linked-tasks>${this.linkedTasks(row)}</div>`;
    const choices=sessionChoices(id,row.chats.value||[],row.rooms.value||[]);
    return heading+`<p>会话归属于这个 Work；明确打开对话或房间时才切换。</p>${this.sessionGroup(id,'hermes',choices,row.chats.error)}${this.sessionGroup(id,'ekko',choices,row.rooms.error)}`;
  }
  private render(): void {
    if(this.disposed)return;
    const data=this.snapshot;
    const taskSection=`<h3>未完成待办</h3><p class="sac-task-source">来自任务笔记管理 · 可按需关联到 Work</p>${this.options.taskReader?`<label>搜索任务<input data-page-task-search placeholder="搜索任务标题或备注" maxlength="100" value="${esc(this.taskQuery)}"></label>`:''}<div data-page-task-results tabindex="-1" role="region" aria-label="未完成任务结果">${this.taskMarkup()}</div>`;
    let body='';
    if(this.route.kind==='detail')body=this.details(this.route.workId,this.route.section);
    else if(this.route.kind==='list')body=`<h2>${this.route.mode==='link'?'选择要关联资料的 Work':'选择已有 Work'}</h2><p>打开工作文档继续读写。等待回复时，原会话保持不变。${this.route.mode==='link'?'关联当前文档需单独点击确认。':'已完成与已关闭的工作可通过状态筛选查看。'}</p>${this.filters()}`;
    else {
      const recent=[...new Map([...(data?.continueWorks||[]),...(data?.works||[])].map(row=>[row.id,row])).values()].slice(0,6);
      const firstUse=Boolean(data&&!data.error&&!data.works.length&&!this.loading);
      const date=new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date());
      const captured=this.context&&isValidDocumentRootId(this.context.documentId)?this.context:null;
      const documentEntry=`<section class="sac-home-document" aria-label="当前文档"><div><span class="sac-home-eyebrow">从文档开始</span>${captured?`<h3>${esc(captured.title||'当前文档')}</h3><p>打开这篇文档和聊天侧栏，按需新建或关联对话。</p>`:'<p>请先打开一篇文档，再回到主页开始。也可以选择或新建 Work。</p>'}</div>${captured&&this.options.actions.startDocument?button('start-document','在这篇文档开始'):''}</section>`;
      body=`<section class="sac-home-welcome"><div><span class="sac-home-eyebrow">你的文档工作台 · ${esc(date)}</span><h2>今天想推进什么？</h2><p>普通文档可直接使用；持续工作可用 Work 整理文档、资料与会话。</p></div><div class="sac-page-actions">${button('create','＋ 新建 Work')}${button('list','选择已有 Work')}</div></section><div class="sac-home-layout"><main class="sac-home-main" aria-label="工作列表">${documentEntry}<div class="sac-section-heading"><h3>${firstUse?'持续工作 · Work 可选':'最近工作 · Work'}</h3>${!firstUse?button('list','查看全部 →'):''}</div>${firstUse?`<section class="sac-first-use" data-first-use><span class="sac-home-symbol" aria-hidden="true">▤</span><h3>把要推进的事，放进一篇文档</h3><p>已有文档可以直接使用，目标和 AI 都可稍后添加。</p><div class="sac-page-actions">${button('create','新建工作文档')}${button('create-existing','使用已有文档')}</div><ol><li><strong>建立 Work</strong><span>文档、资料与会话在一起</span></li><li><strong>可选关联任务</strong><span>已有待办按需加入</span></li><li><strong>按需连接 AI</strong><span>可稍后连接，先整理工作</span></li></ol></section>`:recent.length?`<div class="sac-page-grid sac-home-cards">${recent.map(row=>this.card(row)).join('')}</div>`:'<p class="sac-page-empty">正在准备工作列表；读取失败时请重试。</p>'}${this.context&&recent.length?`<details class="sac-link-context"><summary>关联资料：${esc(this.context.title||'当前文档')}</summary><p>已固定这篇文档；点击目标卡片的“关联当前文档作为资料”后确认。</p><small>文档 ID：${esc(this.context.documentId)}</small>${button('link-list','在列表中关联当前文档')}</details>`:''}</main><aside class="sac-home-aside"><section class="sac-task-panel" aria-label="待办任务"><div class="sac-section-heading"><span class="sac-home-eyebrow">任务 · 待办</span>${this.options.actions.createTask?button('create-task','＋ 新建任务'):''}</div>${taskSection}</section><section class="sac-home-ai"><span aria-hidden="true">✦</span><div><strong>让 AI 加入工作</strong><p>AI 可稍后连接。普通文档和 Work 都可先使用。</p>${this.options.actions.settings?button('settings','连接与设置 →'):''}</div></section></aside></div>`;
    }
    this.root.innerHTML=`<div class="sac-work-page"><div class="sac-page-inner"><header class="sac-page-row sac-page-header"><strong><span class="sac-brand-icon" aria-hidden="true">W</span> AI Work</strong><nav class="sac-page-actions">${this.route.kind!=='home'?button('back','返回'):''}${this.route.kind!=='home'?button('home','主页'):''}${button('refresh','刷新')}${this.options.actions.settings?button('settings','设置'):''}</nav></header>${this.loading?'<p role="status">正在读取 Work…</p>':''}${data?.error?errorMarkup(data.error):''}${this.notice?`<p role="status" aria-live="polite" class="sac-page-notice" data-page-notice>${esc(this.notice)}</p>`:''}${this.route.kind==='list'&&this.route.mode==='link'&&this.context?`<div class="sac-link-context"><strong>待关联资料：${esc(this.context.title||'当前文档')}</strong><details><summary>查看文档 ID</summary>${esc(this.context.documentId)}</details></div>`:''}${body}</div></div>`;
  }
}

export const WORK_PAGE_CSS = `
.sac-work-page{height:100%;overflow:auto;background:var(--b3-theme-background);color:var(--b3-theme-on-background);font-family:var(--b3-font-family,inherit);font-size:14px;line-height:1.5;container-type:inline-size}
.sac-work-page *{box-sizing:border-box}
.sac-page-inner{max-width:1240px;margin:auto;padding:16px 24px 32px;overflow-wrap:anywhere}
.sac-page-row{display:flex;justify-content:space-between;align-items:center;gap:12px;min-width:0}
.sac-page-header{padding-bottom:12px;border-bottom:1px solid var(--b3-border-color);flex-wrap:wrap}
.sac-page-header>strong{display:flex;align-items:center;gap:8px;font-size:16px}
.sac-brand-icon{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:6px;background:var(--b3-theme-surface);color:var(--b3-theme-primary);font-size:14px}
.sac-page-inner h2{font-size:22px;line-height:1.4;margin:16px 0 8px}
.sac-page-inner h3{font-size:16px;line-height:1.5;margin:0 0 8px}
.sac-page-inner p{line-height:1.6}
.sac-page-inner small{display:block;color:var(--b3-theme-on-surface);margin:8px 0;font-size:12px}
.sac-page-inner button,.sac-page-inner input,.sac-page-inner select{font:inherit;border:1px solid var(--b3-border-color);border-radius:6px;padding:6px 10px;background:var(--b3-theme-background);color:inherit;min-width:0;max-width:100%}
.sac-page-inner input{width:100%;margin-top:8px}
.sac-page-inner button{cursor:pointer;line-height:1.5;overflow-wrap:anywhere}
.sac-page-inner button:hover{background:var(--b3-list-hover,var(--b3-theme-surface));border-color:var(--b3-theme-primary)}
.sac-page-inner button:focus-visible,.sac-page-inner input:focus-visible,.sac-page-inner select:focus-visible,.sac-page-inner summary:focus-visible,.sac-session-group:focus{outline:2px solid var(--b3-theme-primary);outline-offset:2px}
.sac-page-inner button[data-page-action=create],.sac-page-inner button[data-page-action=start-document],.sac-page-inner button[data-page-action=enter]{background:var(--b3-theme-primary);border-color:var(--b3-theme-primary);color:var(--b3-theme-on-primary)}
.sac-page-actions{display:flex;gap:8px;flex-wrap:wrap}
.sac-page-header button,.sac-section-heading>button,.sac-page-inner button[data-page-action=detail],.sac-home-ai button{border-color:transparent;background:transparent;color:var(--b3-theme-on-surface);font-size:12px}
.sac-page-header button:hover,.sac-section-heading>button:hover,.sac-page-inner button[data-page-action=detail]:hover,.sac-home-ai button:hover{background:var(--b3-list-hover,var(--b3-theme-surface));color:var(--b3-theme-on-background)}
.sac-page-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:12px}
.sac-page-inner article{padding:12px;border:1px solid var(--b3-border-color);border-radius:8px;background:var(--b3-theme-surface);overflow-wrap:anywhere;margin-bottom:12px;min-width:0}
.sac-page-grid article{margin:0}
.sac-page-inner [data-work-card]{display:flex;flex-direction:column;gap:8px}
.sac-page-inner [data-work-card] h3{margin:0;font-size:16px;line-height:1.5}
.sac-page-grid .sac-page-row{align-items:flex-start}
.sac-page-inner .sac-work-kind{font-size:12px;color:var(--b3-theme-on-surface)}
.sac-page-tag{font-size:12px;white-space:nowrap;padding:1px 6px;border-radius:4px;color:var(--b3-theme-primary);background:var(--b3-theme-background)}
.sac-page-tag[data-status=paused],.sac-page-tag[data-status=completed],.sac-page-tag[data-status=closed]{color:var(--b3-theme-on-surface)}
.sac-work-goal{margin:0;color:var(--b3-theme-on-surface)}
.sac-work-metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:12px;margin:0}
.sac-work-metrics button{display:flex;align-items:center;gap:6px;width:100%;padding:6px 0;border:0;border-bottom:1px solid var(--b3-border-color);border-radius:0;background:transparent;text-align:left}
.sac-work-metrics button:hover{background:var(--b3-list-hover,var(--b3-theme-background))}
.sac-work-metrics button span:first-child{flex:1;color:var(--b3-theme-on-surface);font-size:12px}
.sac-work-metrics button strong{font-size:14px;color:var(--b3-theme-primary)}
.sac-work-metrics button span:last-child{color:var(--b3-theme-primary)}
.sac-page-inner [data-work-card] .sac-page-actions{margin-top:auto;align-items:center}
.sac-page-inner [data-work-card] .sac-page-actions button{font-size:12px;padding:6px 8px}
.sac-page-inner [data-work-card] [data-page-action=link]{width:100%;text-align:left;background:transparent;border-color:transparent;color:var(--b3-theme-on-surface);padding:4px 0}
.sac-page-inner [data-work-card] [data-page-action=link]:hover{background:var(--b3-list-hover,var(--b3-theme-background));color:var(--b3-theme-on-background)}
.sac-page-filters{display:flex;gap:8px;margin:16px 0}
.sac-page-filters input{margin:0;flex:1}
.sac-page-error{color:var(--b3-theme-error);padding:4px 0;font-size:12px;overflow-wrap:anywhere;margin:0}
.sac-page-error button{padding:3px 6px;font-size:12px}
.sac-page-notice{padding:8px 12px;border-radius:8px;background:var(--b3-theme-surface)}
.sac-page-empty{padding:16px;text-align:center;color:var(--b3-theme-on-surface)}
.sac-home-welcome{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 0}
.sac-home-welcome h2{margin:4px 0 8px}
.sac-home-welcome p{margin:0;color:var(--b3-theme-on-surface)}
.sac-home-eyebrow{font-size:12px;color:var(--b3-theme-on-surface)}
.sac-home-layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:24px;align-items:start}
.sac-home-main,.sac-home-aside{min-width:0}
.sac-section-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.sac-section-heading h3{margin:0}
.sac-section-heading>button{padding:4px}
.sac-home-document{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:20px;padding:12px;border-radius:8px;background:var(--b3-theme-surface)}
.sac-home-document>div{min-width:0}
.sac-home-document h3{margin:4px 0;font-size:16px}
.sac-home-document p{margin:4px 0 0;color:var(--b3-theme-on-surface)}
.sac-home-document>button{flex-shrink:0}
.sac-task-panel{padding-left:16px;border-left:1px solid var(--b3-border-color)}
.sac-task-panel>h3{margin:8px 0 4px}
.sac-task-source{font-size:12px;color:var(--b3-theme-on-surface);line-height:1.6;margin:0 0 12px}
.sac-task-panel label{display:block;font-size:12px;color:var(--b3-theme-on-surface)}
.sac-task-panel [data-page-task-results]{margin-top:12px;max-height:min(50vh,430px);overflow:auto;padding:0 4px 4px}
.sac-task-panel article{border:0;border-radius:0;border-bottom:1px solid var(--b3-border-color);background:transparent;padding:8px 0;margin:0;display:grid;gap:4px}
.sac-task-title{display:flex;align-items:baseline;gap:8px;min-width:0}
.sac-task-title>span{color:var(--b3-theme-on-surface);font-size:14px;flex-shrink:0}
.sac-task-panel article strong{font-weight:500;line-height:1.5;min-width:0}
.sac-task-panel article small{margin:0;padding-left:22px}
.sac-task-panel article button{justify-self:start;font-size:12px;padding:4px 6px;margin-left:22px;background:transparent;border-color:transparent;color:var(--b3-theme-primary)}
.sac-task-panel [data-page-task-results]>p,.sac-task-unavailable p{font-size:12px;color:var(--b3-theme-on-surface)}
.sac-home-ai{margin-top:16px;padding:12px 0 0 16px;display:flex;gap:8px;border-top:1px solid var(--b3-border-color)}
.sac-home-ai>span{color:var(--b3-theme-on-surface);font-size:16px}
.sac-home-ai>div{min-width:0}
.sac-home-ai p{font-size:12px;color:var(--b3-theme-on-surface);margin:4px 0}
.sac-home-ai button{padding:4px 0}
.sac-first-use{padding:16px;border:1px solid var(--b3-border-color);border-radius:8px;background:var(--b3-theme-surface)}
.sac-home-symbol{display:inline-block;color:var(--b3-theme-on-surface);font-size:20px;margin-bottom:8px}
.sac-first-use h3{font-size:18px;line-height:1.5}
.sac-first-use p{color:var(--b3-theme-on-surface)}
.sac-first-use ol{padding:12px 0 0;list-style:none;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;border-top:1px solid var(--b3-border-color);margin:16px 0 0;counter-reset:step}
.sac-first-use li{counter-increment:step;font-size:12px;line-height:1.6}
.sac-first-use li:before{content:counter(step,decimal-leading-zero);display:block;color:var(--b3-theme-on-surface);margin-bottom:4px}
.sac-first-use li strong,.sac-first-use li span{display:block}
.sac-first-use li span{color:var(--b3-theme-on-surface)}
.sac-link-context{padding:12px 0;color:var(--b3-theme-on-surface);font-size:12px;overflow-wrap:anywhere}
.sac-link-context summary{cursor:pointer}
.sac-work-lifecycle{padding:12px;margin-top:16px;border-radius:8px;background:var(--b3-theme-surface)}
.sac-work-lifecycle>div{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.sac-work-lifecycle span{font-size:12px;color:var(--b3-theme-on-surface)}
.sac-work-lifecycle details{margin-top:8px}
.sac-work-lifecycle summary{font-size:12px;cursor:pointer}
.sac-work-lifecycle p{font-size:12px}
.sac-page-tabs{border-bottom:1px solid var(--b3-border-color);margin:20px 0 16px;padding-bottom:8px}
.sac-page-tabs button{background:transparent;border-color:transparent}
.sac-page-tabs [aria-current=page]{border-bottom-color:var(--b3-theme-primary);color:var(--b3-theme-primary);font-weight:600}
.sac-session-group{margin:20px 0;padding:12px 0;border-top:1px solid var(--b3-border-color)}
.sac-session-group .sac-section-heading{margin:0}
.sac-session-group h3 span{font-size:12px;font-weight:400;margin-left:6px;color:var(--b3-theme-on-surface)}
.sac-session-group>p{font-size:12px;color:var(--b3-theme-on-surface)}
.sac-session-group .sac-session-row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:0;border-radius:0;border-top:1px solid var(--b3-border-color);padding:12px 0 0;margin:12px 0 0;background:transparent}
.sac-session-row>div{min-width:0}
.sac-session-row>button{flex-shrink:0}
.sac-session-metadata{font-size:12px;color:var(--b3-theme-on-surface);margin-top:8px}
.sac-session-metadata summary{cursor:pointer}
.sac-work-page [hidden]{display:none}
@container(max-width:900px){
 .sac-home-layout{grid-template-columns:minmax(0,1fr) 240px;gap:16px}
 .sac-home-welcome{align-items:flex-start;flex-direction:column;gap:12px}
 .sac-page-inner{padding:16px 20px 24px}
 .sac-home-document{align-items:flex-start;flex-direction:column}
 .sac-first-use ol{grid-template-columns:1fr}
}
@container(max-width:660px){
 .sac-page-inner{padding:12px 16px 24px}
 .sac-home-layout{grid-template-columns:minmax(0,1fr);gap:20px}
 .sac-home-welcome{padding:16px 0}
 .sac-home-cards{grid-template-columns:minmax(0,1fr)}
 .sac-task-panel{padding:12px 0 0;border-left:0;border-top:1px solid var(--b3-border-color)}
 .sac-home-ai{padding-left:0}
 .sac-page-filters{flex-wrap:wrap}
 .sac-page-filters input{min-width:100%}
}
@container(max-width:400px){
 .sac-page-inner{padding:12px 12px 24px}
 .sac-session-group .sac-session-row{flex-wrap:wrap}
 .sac-page-header button{padding:4px 6px}
}
`;
