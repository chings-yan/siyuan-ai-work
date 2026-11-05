import { isValidDocumentRootId } from '../core.ts';
import { decideNavigation, resolveCandidates } from './navigation.ts';
import { WorkService } from './service.ts';
import { SiYuanWorkHost } from './siyuan-host.ts';
import { WorkStore } from './store.ts';
import { NativeTaskReader, shouldClearCurrentTask, type TaskView } from '../task/reader.ts';
import { bindDismissibleMenu } from './dismissible-menu.ts';

const esc = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export type ContextChoice = { mode: 'none' | 'selection' | 'document'; documentIds: string[] };
type CreateDraft = { documentId: string; goal: string; taskId: string; suggestions: TaskView[]; taskError: string; loading: boolean; submitting: boolean };
type ChatScopeGuard = { isCurrent: () => boolean; beforeSceneChange: (workId: string | null) => void };

export class WorkController {
  private workId: string | null = null;
  private documentId = '';
  // Browsing during a request must not move the standalone conversation's owner.
  private sceneDocumentId = '';
  private focusBlockId: string | null = null;
  private navigationSequence = 0;
  private disposed = false;
  private resumeAllowed = true;
  private transition = 0;
  private readonly restoringWorks=new Map<number,string>();
  private renderSequence = 0;
  private selectedDocuments = new Set<string>();
  private referenceCount=0;
  private contextMode: ContextChoice['mode'] = 'document';
  private homeOpen = false;
  private currentTaskId: string | null = null;
  private currentTaskTitle: string | null = null;
  private currentTaskIssue = '';
  private recentTasks: { kind: 'found'; value: TaskView[] } | { kind: 'unavailable'; reason: string } | null = null;
  private readonly recentTaskMenuVersions = new Map<HTMLElement, number>();
  private readonly recentTaskSearchTimers = new Map<HTMLElement,ReturnType<typeof setTimeout>>();
  private createDraft: CreateDraft | null = null;
  private resolveMessage = '';
  private choiceWorkIds: string[] = [];
  private saveTimer?: ReturnType<typeof setTimeout>;
  private firstQueuedAt = 0;
  private roots = new Set<HTMLElement>();
  private listeners=new Map<HTMLElement,{contextTarget:HTMLElement;click:(event:MouseEvent)=>void;change:(event:Event)=>void;input:(event:Event)=>void;taskInput:(event:Event)=>void;dismiss:()=>void;layout:()=>void}>();
  constructor(private readonly options: {
    host: SiYuanWorkHost; store: WorkStore; service: WorkService; taskReader: NativeTaskReader;
    currentDocumentId: () => string; currentFocusBlockId: () => string | null; currentChatId: () => string | null;
    currentConnection?: () => string;
    currentChat?: () => { title: string; linked: boolean } | null;
    isBusy: () => boolean; hasPendingWrite: () => boolean;
    canBrowseDocuments?: () => boolean;
    openDocument: (documentId: string, focusBlockId: string | null) => void | Promise<unknown>;
    onCreateTask?: (workId:string|null,documentId:string|null,current:()=>boolean)=>Promise<void>;
    onLinkTask?: (workId:string,current:()=>boolean)=>Promise<void>;
    onOpenPage?: (route: { kind: 'home' | 'list' } | {kind:'detail';workId:string;section?:'tasks'}) => void;
    onContextChanged?: (choice: ContextChoice) => void;
    onBeginCreate?: (documentId: string) => Promise<void>;
    onWorkChanged: (workId: string | null) => Promise<void>;
    onLinkCurrentChat: () => Promise<void>;
    status: (message: string) => void;
  }) {}
  get currentWorkId(): string | null { return this.workId; }
  get isTransitioning(): boolean { return this.transition !== 0 || [...this.restoringWorks.values()].includes(this.workId || ''); }
  get navigationVersion(): number { return this.navigationSequence; }
  get currentDocumentId(): string { return this.documentId; }
  get activeDocumentId(): string { return this.sceneDocumentId || this.documentId; }
  get currentTask(): string | null { return this.currentTaskId; }
  get contextChoice(): ContextChoice { return { mode: this.contextMode, documentIds: [...this.selectedDocuments] }; }
  restoreContext(choice: ContextChoice): void { this.contextMode=choice.mode; this.selectedDocuments=new Set(choice.documentIds); void this.renderAll(); }
  updateReferenceSummary(count:number):void {this.referenceCount=count;for(const root of this.roots){const value=root.querySelector('[data-context-references]');if(value)value.textContent='引用 '+count+' 项';const mode=root.querySelector('[data-context-mode-label]');if(mode&&this.contextMode==='none')mode.textContent=this.selectedDocuments.size||count?'不附当前文档':'仅对话';}}
  clearOnceContext(): void { this.selectedDocuments.clear(); this.options.onContextChanged?.(this.contextChoice); this.renderAll(); }

  attach(root: HTMLElement): void {
    this.detachRoot(root);
    const header = root.querySelector('.sac-header');
    if (!header) return;
    if(!root.querySelector('.sac-work')) {
    if(root.querySelector('[data-work-title]')) root.querySelector('[data-composer]')!.insertAdjacentHTML('beforebegin','<section class="sac-work sac-work-compact" data-chat-only aria-label="本轮资料"><div data-work-panel></div></section>');
    else header.insertAdjacentHTML('afterend', '<section class="sac-work" aria-label="AI Work"><div data-work-panel></div></section>');
    }
    this.roots.add(root);
    const contextTarget=root.querySelector<HTMLElement>('.sac-work')!;
    const window=root.ownerDocument.defaultView,fit=()=>this.fitRecentTaskMenu(root),ResizeObserverCtor=window?.ResizeObserver;
    const observer=ResizeObserverCtor?new ResizeObserverCtor(fit):null;observer?.observe(root);window?.addEventListener('resize',fit);
    const listeners={contextTarget,click:(event:MouseEvent)=>void this.onClick(root,event),change:(event:Event)=>this.onChange(event),input:(event:Event)=>this.onInput(event),taskInput:(event:Event)=>this.searchTaskMenu(root,event),dismiss:bindDismissibleMenu(root.querySelector('[data-recent-task-anchor]'),root.querySelector('[data-recent-task-menu]'),root.querySelector('[data-work-action="recent-tasks"]'),()=>this.closeRecentTaskMenu(root)),layout:()=>{observer?.disconnect();window?.removeEventListener('resize',fit);}};
    this.listeners.set(root,listeners);
    root.addEventListener('click',listeners.click);
    root.addEventListener('input',listeners.taskInput);
    contextTarget.addEventListener('change',listeners.change);
    contextTarget.addEventListener('input',listeners.input);
    this.renderAll();
  }
  detachRoot(root: HTMLElement): void { this.closeRecentTaskMenu(root);this.roots.delete(root); this.recentTaskMenuVersions.delete(root); const listeners=this.listeners.get(root);if(listeners){listeners.dismiss();listeners.layout();root.removeEventListener('click',listeners.click);root.removeEventListener('input',listeners.taskInput);listeners.contextTarget.removeEventListener('change',listeners.change);listeners.contextTarget.removeEventListener('input',listeners.input);this.listeners.delete(root);} }
  detach(): void { this.disposed=true;this.navigationSequence++;this.renderSequence++;if (this.saveTimer) clearTimeout(this.saveTimer); for(const root of [...this.roots])this.detachRoot(root); }
  async refreshFromEditor(): Promise<void> {
    const id = this.options.currentDocumentId();
    if (!id || id === this.documentId) return;
    await this.refreshDocument(id);
  }
  private async documentCandidates(documentId: string): Promise<string[]> {
    const path = await this.options.host.getDocumentPath(documentId);
    if (!path) throw new Error('文档暂时无法读取，请重试归属核对');
    const parts = path.slice(1, -3).split('/');
    if (!path.startsWith('/') || !path.endsWith(`/${documentId}.sy`) || !parts.every(isValidDocumentRootId)) throw new Error('文档路径无效，无法核对归属');
    const marked: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const id = parts[i];
      if (i < parts.length - 1 && await this.options.host.getDocumentPath(id) !== `/${parts.slice(0, i + 1).join('/')}.sy`) throw new Error('父文档路径不一致，无法核对归属');
      const attrs = await this.options.host.getAttrs(id);
      if ('custom-ai-work-v0' in attrs && attrs['custom-ai-work-v0'] !== '1') throw new Error('Work 标记格式未知，请核对原文档');
      if (await this.options.service.readWork(id)) marked.push(id);
    }
    // Register only after the entire exact tree has been verified.
    for (const id of marked) await this.options.store.registerWork(id);
    const workIds = await this.options.store.listWorks();
    const external: { workId: string; documentId: string }[] = [];
    for (const id of workIds) for (const ref of await this.options.service.listExternalDocuments(id)) external.push({ workId: id, documentId: ref });
    return [...new Set([...resolveCandidates(path, marked, [], documentId), ...external.filter(link => link.documentId === documentId).map(link => link.workId)])];
  }
  /** Explicit New/Associate resolves the opened document, never an unrelated retained Work. */
  async prepareChatScope(documentId: string, guard?: ChatScopeGuard): Promise<string | null> {
    if (!isValidDocumentRootId(documentId)) throw new Error('请先打开一个思源文档');
    if (this.isTransitioning) throw new Error('文档归属正在核对，请稍后重试');
    const sequence = ++this.navigationSequence;
    this.checkNavigation(sequence);
    const check = () => {this.checkNavigation(sequence);if(guard&&!guard.isCurrent())throw new Error('文档、连接或视图已变化，请重新操作');};
    const candidates = await this.documentCandidates(documentId);
    check();
    if (this.options.currentDocumentId() !== documentId) throw new Error('文档已变化，请重新核对归属');
    if (candidates.length > 1 && (!this.workId || !candidates.includes(this.workId))) {
      this.choiceWorkIds = candidates;this.resolveMessage = '文档关联多个 Work，请明确选择';this.options.status(this.resolveMessage);void this.renderAll();
      throw new Error(this.resolveMessage);
    }
    const owner = candidates.includes(this.workId || '') ? this.workId : candidates[0] || null;
    if (owner) {
      if (owner !== this.workId) await this.selectWork(owner, false, sequence, () => guard?.beforeSceneChange(owner));
      check();
      return owner;
    }
    await this.flushResume();check();
    const changed = this.workId !== null || this.activeDocumentId !== documentId;
    if (changed) guard?.beforeSceneChange(null);
    this.workId = null;this.documentId = documentId;this.sceneDocumentId = documentId;this.resumeAllowed = false;
    this.currentTaskId = null;this.currentTaskTitle = null;this.currentTaskIssue = '';this.choiceWorkIds = [];this.resolveMessage = '';
    if (changed) await this.options.onWorkChanged(null);
    check();void this.renderAll();return null;
  }
  async refreshDocument(documentId: string): Promise<void> {
    if (this.disposed || !isValidDocumentRootId(documentId)) return;
    if (this.createDraft && this.createDraft.documentId !== documentId) this.createDraft = null;
    this.choiceWorkIds = [];
    const sequence = ++this.navigationSequence;
    const finishTransition=this.beginTransition(sequence);
    try {
      const candidates = await this.documentCandidates(documentId);
      if (sequence !== this.navigationSequence) return;
      const decision = decideNavigation({ currentWorkId: this.workId, busy: this.options.isBusy(), pendingWrite: this.options.hasPendingWrite() }, candidates);
      await this.flushResume();
      if (sequence !== this.navigationSequence) return;
      this.documentId = documentId;
      this.focusBlockId = this.options.currentFocusBlockId();
      this.resumeAllowed = Boolean(this.workId && candidates.includes(this.workId));
      if (decision.kind === 'switch') await this.selectWork(decision.workId, true, sequence);
      else if (decision.kind === 'choose') { this.choiceWorkIds = decision.workIds; this.resolveMessage = '文档关联多个 Work，请明确选择';this.options.status(this.resolveMessage); }
      else {
        this.choiceWorkIds = [];
        const protectedScene = this.options.isBusy() || this.options.hasPendingWrite();
        this.resolveMessage = protectedScene && (!this.workId || !candidates.includes(this.workId)) ? '当前生成或待处理修改仍属于原会话；新文档仅供浏览，处理完成后请明确进入。' : candidates.length ? '' : (this.workId ? '当前文档仅供浏览，未自动加入 Work' : '文档对话 · Work 可选');
        if (!this.workId && !protectedScene && this.sceneDocumentId !== documentId) {this.sceneDocumentId = documentId;await this.options.onWorkChanged(null);}
        if(this.resolveMessage)this.options.status(this.resolveMessage);
      }
      if (this.workId && candidates.includes(this.workId)) this.queueResume();
      this.renderAll();
    } catch (error) {
      if (sequence !== this.navigationSequence) return;
      this.resolveMessage = `Work 归属暂不可核对：${error instanceof Error ? error.message : String(error)}`;
      this.options.status(this.resolveMessage);
      this.renderAll();
    } finally {finishTransition();}
  }
  private beginTransition(sequence:number):()=>void {
    const ownsTransition=this.transition!==sequence;
    this.transition=sequence;
    return ()=>{if(ownsTransition&&this.transition===sequence)this.transition=0;};
  }
  private checkNavigation(sequence: number): void {
    if(this.disposed || sequence!==this.navigationSequence)throw new Error('导航已变化，请重新进入所选 Work');
    if(this.options.isBusy() || this.options.hasPendingWrite())throw new Error('当前生成或待处理修改期间不能切换 Work');
  }
  private checkDocumentNavigation(sequence: number): void {
    this.checkDocumentSequence(sequence);
    if(this.options.hasPendingWrite() || this.options.isBusy() && !this.options.canBrowseDocuments?.())throw new Error('当前生成或待处理修改期间不能切换 Work');
  }
  private checkDocumentSequence(sequence: number): void {
    if(this.disposed || sequence!==this.navigationSequence)throw new Error('导航已变化，请重新打开所选文档');
  }
  async selectWork(workId: string, priorResumeFlushed = false, sequence = ++this.navigationSequence, beforeSceneChange?: () => void): Promise<void> {
    this.checkNavigation(sequence);
    const finishTransition=this.beginTransition(sequence);
    try {
    if (!(await this.options.service.readWork(workId))) throw new Error('Work 不存在或标记损坏');
    this.checkNavigation(sequence);
    if (this.workId === workId) return;
    const saved = await this.options.store.getResume(workId);
    this.checkNavigation(sequence);
    if (!priorResumeFlushed) await this.flushResume();
    this.checkNavigation(sequence);
    beforeSceneChange?.();
    this.workId = workId;
    this.sceneDocumentId = '';
    this.resumeAllowed = priorResumeFlushed || this.documentId===workId;
    this.choiceWorkIds = [];
    this.currentTaskId = saved?.taskId || null;
    this.currentTaskTitle = null;
    this.currentTaskIssue = '';
    this.selectedDocuments.clear();
    this.resolveMessage = '';
    // A newer document navigation inside this Work must not unlock its pending session restore.
    this.restoringWorks.set(sequence,workId);
    try {await this.options.onWorkChanged(workId);}
    finally {this.restoringWorks.delete(sequence);}
    if(this.disposed || sequence!==this.navigationSequence)return;
    this.queueResume();
    this.renderAll();
    if (this.currentTaskId) void this.loadCurrentTaskTitle(workId, this.currentTaskId);
    } finally {finishTransition();}
  }
  private async loadCurrentTaskTitle(workId: string, taskId: string): Promise<void> {
    let title: string | null = null;
    let issue = '';
    try {
      const checked = await this.options.taskReader.getTask(taskId);
      if (checked.kind === 'found') title = checked.value.title;
      else issue = checked.kind === 'unavailable' ? checked.reason : '任务已不存在，等待核对';
    } catch (error) { issue = error instanceof Error ? error.message : String(error); }
    if (this.workId !== workId || this.currentTaskId !== taskId) return;
    this.currentTaskTitle = title;
    this.currentTaskIssue = issue;
    this.renderAll();
  }
  noteFocus(): void {
    const id = this.options.currentDocumentId();
    if (!id || id !== this.documentId || !this.workId) return;
    const focus = this.options.currentFocusBlockId();
    if (focus !== this.focusBlockId) { this.focusBlockId = focus; this.queueResume(); }
  }
  noteChat(): void { if (this.workId) { this.queueResume(true); this.renderAll(); } }
  private queueResume(immediate = false): void {
    if (this.disposed || !this.resumeAllowed || !this.workId || !this.documentId) return;
    const now = Date.now();
    if (!this.firstQueuedAt) this.firstQueuedAt = now;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    const wait = immediate ? 0 : Math.min(800, Math.max(0, 3000 - (now - this.firstQueuedAt)));
    this.saveTimer = setTimeout(() => { void this.flushResume().catch(error => this.options.status(`保存最近位置失败：${error.message}`)); }, wait);
  }
  async flushResume(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined; this.firstQueuedAt = 0;
    if (!this.resumeAllowed || !this.workId || !this.documentId) return;
    await this.options.store.saveResume({ workId: this.workId, documentId: this.documentId, focusBlockId: this.focusBlockId, chatId: this.options.currentChatId(), taskId: this.currentTaskId, updatedAt: new Date().toISOString() });
  }
  async resumeWork(workId: string): Promise<void> {
    const sequence=++this.navigationSequence;this.checkDocumentNavigation(sequence);
    const finishTransition=this.beginTransition(sequence);
    try {
    const saved = await this.options.store.getResume(workId);
    let documentId = saved?.documentId || workId;
    if (!(await this.options.host.getDocumentPath(documentId))) documentId = workId;
    if (!(await this.options.host.getDocumentPath(documentId))) throw new Error('Work 文档不存在');
    const focus = saved?.focusBlockId && await this.options.host.getDocumentRoot(saved.focusBlockId) === documentId ? saved.focusBlockId : null;
    this.checkDocumentNavigation(sequence);
    await this.openWorkDocument(workId, documentId, focus, sequence);
    } finally {finishTransition();}
  }
  async checkSelectableTask(taskId: string, workId: string): Promise<TaskView> {
    const checked = await this.options.taskReader.getTask(taskId);
    if (checked.kind === 'unavailable') throw new Error(`任务状态未知：${checked.reason}`);
    if (checked.kind === 'missing') throw new Error('所选任务已不存在');
    if (checked.value.id !== taskId) throw new Error('任务接口返回的 ID 不一致，请重新核对');
    if (checked.value.completed) throw new Error('推荐任务已完成；请选择其他任务或不关联任务');
    for (const id of await this.options.store.listWorks()) {
      if (id !== workId && (await this.options.store.listTasks(id)).some(link => link.taskId === taskId && link.connectionId === 'siyuan-native-local')) {
        throw new Error('此任务已有其他 Work，未改动当前文档');
      }
    }
    return { ...checked.value };
  }
  /** Only save the explicitly confirmed relation; selecting a task does not navigate or select a Chat. */
  async linkSelectedTask(workId: string, selected: TaskView, isCurrent: () => boolean): Promise<void> {
    const expected = Object.freeze({ ...selected });
    const checkCurrent = () => {
      if (this.disposed || !isCurrent()) throw new Error('页面或 Work 已变化，请重新核对任务');
      if (this.options.isBusy() || this.options.hasPendingWrite() || this.isTransitioning) throw new Error('生成、导航或待处理修改期间不能关联任务');
    };
    checkCurrent();
    if (!(await this.options.service.readWork(workId))) throw new Error('Work 不存在或标记损坏');
    checkCurrent();
    const readConfirmedTask = async () => {
      const task = await this.checkSelectableTask(expected.id, workId);
      checkCurrent();
      if (task.title !== expected.title || task.documentId !== expected.documentId || task.projectId !== expected.projectId) {
        throw new Error('任务标题、项目或关联文档已变化，请重新选择并核对');
      }
      return task;
    };
    const checked = await readConfirmedTask();
    if (!(await this.options.service.readWork(workId))) throw new Error('Work 不存在或标记损坏');
    checkCurrent();
    await this.options.store.linkTask({ taskId: checked.id, workId, connectionId: 'siyuan-native-local' }, {
      validate: async () => {
        checkCurrent();
        if (!(await this.options.service.readWork(workId))) throw new Error('Work 不存在或标记损坏，请重新核对任务');
        checkCurrent();
        await readConfirmedTask();
      },
      checkCurrent,
    });
  }
  private async createFromDraft(root: HTMLElement): Promise<void> {
    const draft = this.createDraft;
    if (!draft || draft.submitting) return;
    draft.goal = root.querySelector<HTMLTextAreaElement>('[data-work-goal]')?.value ?? draft.goal;
    draft.taskId = root.querySelector<HTMLSelectElement>('[data-work-task]')?.value || '';
    if (this.options.currentDocumentId() !== draft.documentId) throw new Error('当前文档已变化，请重新选择 Work 文档');
    if (draft.taskId && !draft.suggestions.some(task => task.id === draft.taskId)) throw new Error('所选任务不在最近推荐中，请重新选择');
    draft.submitting = true;
    this.renderAll();
    let workCreated = false;
    try {
      if (draft.taskId) await this.checkSelectableTask(draft.taskId, draft.documentId);
      await this.options.service.createFromDocument({ documentId: draft.documentId, goal: draft.goal, approved: true });
      workCreated = true;
      this.createDraft = null;
      if (this.options.currentDocumentId() === draft.documentId) {
        await this.refreshDocument(draft.documentId);
        if (this.workId !== draft.documentId) await this.selectWork(draft.documentId);
      }
      if (draft.taskId) {
        await this.checkSelectableTask(draft.taskId, draft.documentId);
        await this.options.store.linkTask({ taskId: draft.taskId, workId: draft.documentId, connectionId: 'siyuan-native-local' });
        if (this.options.currentDocumentId() === draft.documentId && this.workId === draft.documentId) {
          this.currentTaskId = draft.taskId;
          this.currentTaskTitle = draft.suggestions.find(task => task.id === draft.taskId)?.title || null;
          this.currentTaskIssue = '';
          this.queueResume(true);
        }
      }
      this.options.status(this.options.currentDocumentId() !== draft.documentId ? 'Work 已在原文档建立；当前浏览位置保持不变' : draft.taskId ? 'Work 已建立，推荐任务已关联' : 'Work 已建立，未关联任务；可稍后选择');
      this.renderAll();
    } catch (error) {
      if (!workCreated) {
        draft.submitting = false;
        if (this.createDraft === draft) this.renderAll();
        throw error;
      }
      this.createDraft = null;
      this.renderAll();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(draft.taskId ? `Work 已建立，但任务未关联：${message}` : `Work 已建立，但界面恢复失败：${message}`);
    }
  }
  async beginCreate(documentId = this.options.currentDocumentId()): Promise<void> {
        if (this.options.onBeginCreate) { await this.options.onBeginCreate(documentId); return; }
        if (!documentId) throw new Error('请先打开一篇文档');
        if (this.createDraft) return;
        const draft: CreateDraft = { documentId, goal: '', taskId: '', suggestions: [], taskError: '', loading: true, submitting: false };
        this.createDraft = draft;
        this.renderAll();
        try {
          const tasks = await this.options.taskReader.listRecent(5);
          if (this.createDraft !== draft) return;
          draft.suggestions = tasks.kind === 'found' ? tasks.value.filter(task => !task.completed) : [];
          draft.taskError = tasks.kind === 'unavailable' ? tasks.reason : '';
        } catch (error) {
          if (this.createDraft !== draft) return;
          draft.taskError = error instanceof Error ? error.message : String(error);
        }
        draft.loading = false;
        this.renderAll();
        return;
  }
  async enterTask(taskId: string): Promise<void> {
        const sequence=++this.navigationSequence;this.checkNavigation(sequence);
        const finishTransition=this.beginTransition(sequence);
        try {
        const checked = await this.options.taskReader.getTask(taskId);
        this.checkNavigation(sequence);
        if (checked.kind === 'unavailable') throw new Error(`任务状态未知：${checked.reason}`);
        if (checked.kind === 'missing') throw new Error('任务已不存在；未改动当前 Work 或 Chat');
        if (checked.value.completed) { if (this.currentTaskId === taskId) { this.currentTaskId = null; this.currentTaskTitle = null; this.currentTaskIssue = ''; this.queueResume(true); } throw new Error('任务已完成，当前 Work 保持不变'); }
        if (!checked.value.documentId) throw new Error('任务没有关联文档；请先在任务插件中关联文档，本次未跳转');
        const linkedDocument = await this.options.host.getDocumentPath(checked.value.documentId) ? checked.value.documentId : null;
        this.checkNavigation(sequence);
        if (!linkedDocument) throw new Error('任务关联的文档不存在或暂不可读取；本次未跳转');
        const owners = await Promise.all((await this.options.store.listWorks()).map(async id => ({ id, tasks: await this.options.store.listTasks(id) })));
        this.checkNavigation(sequence);
        const owner = owners.find(x => x.tasks.some(task => task.taskId === taskId && task.connectionId === 'siyuan-native-local'))?.id;
        if (!owner) {
          await this.openTaskDocumentOnly(linkedDocument,sequence);
          this.currentTaskId = null; this.currentTaskTitle = null; this.currentTaskIssue = ''; this.queueResume(true);
          this.options.status('任务未关联 Work；已打开任务文档，未建立任务关系。请在 Work 管理中明确选择任务关联');
          this.renderAll(); return;
        }
        let workIssue = '';
        try { if (!(await this.options.service.readWork(owner))) workIssue = 'Work 标记不存在'; }
        catch (error) { workIssue = error instanceof Error ? error.message : String(error); }
        this.checkNavigation(sequence);
        if (workIssue) {
          await this.openTaskDocumentOnly(linkedDocument,sequence);
          this.options.status(`已打开任务文档；关联的 Work 标记损坏或暂不可读取：${workIssue}。本次未进入 Work，也未更改任务关系`);
          this.renderAll(); return;
        }
        this.checkNavigation(sequence);
        await this.openWorkDocument(owner, linkedDocument, null, sequence);
        this.checkNavigation(sequence);
        this.currentTaskId = taskId; this.currentTaskTitle = checked.value.title; this.currentTaskIssue = ''; this.queueResume(true);
        this.renderAll(); return;
        } finally {finishTransition();}
  }
  private async openTaskDocumentOnly(documentId:string,sequence:number):Promise<void> {
    await this.openDocumentKeepingWork(documentId,null,sequence,()=>this.checkNavigation(sequence));
  }
  async openDocumentFromPage(documentId:string,focusBlockId:string|null,isCurrent:()=>boolean):Promise<void> {
    if(!isValidDocumentRootId(documentId))throw new Error('请先打开一个思源文档');
    if(!isCurrent())throw new Error('页面已变化，请重新打开所选文档');
    const sequence=++this.navigationSequence;
    const check=()=>{this.checkDocumentNavigation(sequence);if(!isCurrent())throw new Error('页面已变化，请重新打开所选文档');};
    check();const finishTransition=this.beginTransition(sequence);
    try {
      if(!(await this.options.host.getDocumentPath(documentId)))throw new Error('文档不存在或暂不可读取');
      check();
      const focus=focusBlockId&&await this.options.host.getDocumentRoot(focusBlockId)===documentId?focusBlockId:null;
      check();
      // Opening Home's captured document only browses; native ownership and explicit chat preparation remain authoritative.
      await this.openDocumentKeepingWork(documentId,focus,sequence,check);
    } finally {finishTransition();}
  }
  private async openDocumentKeepingWork(documentId:string,focus:string|null,sequence:number,check:()=>void,afterOpen=check):Promise<void> {
    await this.flushResume();
    check();
    const previous={documentId:this.documentId,focusBlockId:this.focusBlockId,resumeAllowed:this.resumeAllowed};
    // Freeze the native target before its switch event; this task does not establish Work ownership.
    this.documentId=documentId;this.focusBlockId=focus;this.resumeAllowed=false;
    try {await this.options.openDocument(documentId,focus);}
    catch(error){
      if(!this.disposed&&sequence===this.navigationSequence&&this.options.currentDocumentId()===previous.documentId){
        this.documentId=previous.documentId;this.focusBlockId=previous.focusBlockId;this.resumeAllowed=previous.resumeAllowed;
      }
      throw error;
    }
    afterOpen();
  }
  async enterWork(workId: string): Promise<void> { await this.openWorkDocument(workId, workId); }
  async openWorkDocument(workId: string, documentId: string, focus: string | null = null, sequence = ++this.navigationSequence): Promise<void> {
    this.checkDocumentNavigation(sequence);const browseOnly=this.options.isBusy();const finishTransition=this.beginTransition(sequence);
    try {
    if (!(await this.options.service.readWork(workId))) throw new Error('Work 不存在或标记损坏');
    if (!(await this.options.host.getDocumentPath(documentId))) throw new Error('文档不存在或暂不可读取');
    this.checkDocumentNavigation(sequence);
    // Native editor readiness precedes lazy chat creation in onWorkChanged.
    await this.openDocumentKeepingWork(documentId,focus,sequence,()=>this.checkDocumentNavigation(sequence),()=>this.checkDocumentSequence(sequence));
    if(browseOnly || this.options.isBusy() || this.options.hasPendingWrite()){
      this.choiceWorkIds=[];
      this.resolveMessage='已打开工作文档；回复或待处理修改仍属于原 Work。处理完成后可再次进入此 Work，切换工作上下文。';
      this.options.status(this.resolveMessage);this.renderAll();return;
    }
    await this.selectWork(workId, true, sequence);
    this.checkNavigation(sequence);this.resumeAllowed=true;
    this.queueResume();
    } finally {finishTransition();}
  }
  private closeRecentTaskMenu(root:HTMLElement):void {
    const timer=this.recentTaskSearchTimers.get(root);if(timer)clearTimeout(timer);this.recentTaskSearchTimers.delete(root);
    root.querySelector<HTMLElement>('[data-recent-task-menu]')?.setAttribute('hidden','');
    root.querySelector('[data-work-action="recent-tasks"]')?.setAttribute('aria-expanded','false');
    this.recentTaskMenuVersions.set(root,(this.recentTaskMenuVersions.get(root)||0)+1);
  }
  private fitRecentTaskMenu(root:HTMLElement):void {
    const menu=root.querySelector<HTMLElement>('[data-recent-task-menu]');if(!menu||menu.hidden)return;
    const bottom=Math.min(root.getBoundingClientRect().bottom,root.ownerDocument.defaultView?.innerHeight||Infinity);
    const space=Math.max(0,bottom-menu.getBoundingClientRect().top-8);
    menu.style.setProperty('--sac-task-menu-space',`${space}px`);menu.dataset.short=String(space<360);
  }
  private async toggleRecentTaskMenu(root: HTMLElement): Promise<void> {
    const menu=root.querySelector<HTMLElement>('[data-recent-task-menu]');
    const button=root.querySelector<HTMLButtonElement>('[data-work-action="recent-tasks"]');
    if(!menu||!button)return;
    const version=(this.recentTaskMenuVersions.get(root)||0)+1;
    this.recentTaskMenuVersions.set(root,version);
    menu.hidden=!menu.hidden;
    button.setAttribute('aria-expanded',String(!menu.hidden));
    if(menu.hidden)return;
    menu.innerHTML=`<header class="sac-task-menu-header"><div><strong>任务</strong><small>来自任务笔记管理</small></div><button type="button" data-work-action="close-tasks" aria-label="关闭任务菜单">×</button></header><label>查找未完成任务<input data-recent-task-search placeholder="搜索任务标题或备注" maxlength="100"></label><div data-recent-task-results><small role="status">正在读取最近任务…</small></div><footer class="sac-task-menu-footer">${this.workId&&this.options.onOpenPage?'<button type="button" data-work-action="manage-tasks">管理此 Work 的任务</button>':''}${this.options.onCreateTask||this.workId&&this.options.onLinkTask?`<details class="sac-task-menu-actions"><summary>${this.workId&&this.options.onLinkTask?'新建或关联任务':'新建任务'}</summary><div>${this.options.onCreateTask?'<button type="button" data-work-action="create-task">在任务插件中新建</button>':''}${this.workId&&this.options.onLinkTask?'<button type="button" data-work-action="link-task">关联已有任务</button>':''}</div></details>`:''}</footer>`;
    this.fitRecentTaskMenu(root);
    menu.querySelector<HTMLInputElement>('[data-recent-task-search]')?.focus();
    await this.loadTaskMenu(root,'',version);
  }
  private searchTaskMenu(root:HTMLElement,event:Event):void {
    const input=event.target as HTMLInputElement;if(!input.matches('[data-recent-task-search]'))return;
    const menu=root.querySelector<HTMLElement>('[data-recent-task-menu]');if(!menu||menu.hidden)return;
    const timer=this.recentTaskSearchTimers.get(root);if(timer)clearTimeout(timer);
    const version=(this.recentTaskMenuVersions.get(root)||0)+1;this.recentTaskMenuVersions.set(root,version);
    const query=input.value.trim(),results=menu.querySelector<HTMLElement>('[data-recent-task-results]');if(results)results.innerHTML='<small role="status">正在读取任务…</small>';
    this.recentTaskSearchTimers.set(root,setTimeout(()=>void this.loadTaskMenu(root,query,version),150));
  }
  private async loadTaskMenu(root:HTMLElement,query:string,version:number):Promise<void> {
    const menu=root.querySelector<HTMLElement>('[data-recent-task-menu]');if(!menu||menu.hidden||this.disposed||!this.roots.has(root)||this.recentTaskMenuVersions.get(root)!==version)return;
    let result:Awaited<ReturnType<NativeTaskReader['listRecent']>>;
    try { result=query?await this.options.taskReader.search(query):await this.options.taskReader.listRecent(5); }
    catch(error) { result={kind:'unavailable',reason:error instanceof Error?error.message:String(error)}; }
    if(this.disposed||!this.roots.has(root)||menu.hidden||this.recentTaskMenuVersions.get(root)!==version)return;
    if(!query)this.recentTasks=result;
    const titles=new Map<string,string>();
    if(result.kind==='found')await Promise.all(result.value.filter(task=>task.documentId).map(async task=>{const id=task.documentId!;try{titles.set(id,await this.options.host.getDocumentTitle(id));}catch{titles.set(id,'文档名称暂不可读取');}}));
    if(this.disposed||!this.roots.has(root)||menu.hidden||this.recentTaskMenuVersions.get(root)!==version)return;
    const results=menu.querySelector<HTMLElement>('[data-recent-task-results]');if(results)results.innerHTML=`<small class="sac-task-menu-result-label">${query?'搜索结果（最多 30 条）':'最近未完成任务 · 最多 5 条'}</small>${result.kind==='found'?result.value.map(task=>`<article class="sac-task-menu-row" data-task-id="${esc(task.id)}"><strong>${esc(task.title)}</strong><small>${task.documentId?`文档：${esc(titles.get(task.documentId)||'名称暂未读到')}`:'没有关联文档'}</small>${task.documentId?`<button type="button" data-work-action="task" data-task-id="${esc(task.id)}">打开关联文档</button>`:''}</article>`).join('')||'<small>暂无匹配的未完成任务</small>':`<small role="status">任务暂不可读取：${esc(result.reason)}</small>`}`;
  }
  private async onClick(root: HTMLElement, event: MouseEvent): Promise<void> {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-work-action]');
    if (!button) return;
    try {
      const action = button.dataset.workAction;
      if (action === 'choose-owner') {
        const workId = button.dataset.workId || '';
        if (!this.choiceWorkIds.includes(workId)) throw new Error('文档归属候选已变化，请重新核对');
        const documentId = this.options.currentDocumentId(),sequence = ++this.navigationSequence;
        this.checkNavigation(sequence);
        const candidates = await this.documentCandidates(documentId);
        this.checkNavigation(sequence);
        if (documentId !== this.options.currentDocumentId() || !candidates.includes(workId)) throw new Error('文档归属候选已变化，请重新核对');
        await this.flushResume();this.checkNavigation(sequence);
        this.documentId = documentId;this.focusBlockId = this.options.currentFocusBlockId();
        await this.selectWork(workId, true, sequence);return;
      }
      if (action === 'recent-tasks') { await this.toggleRecentTaskMenu(root); return; }
      if(action==='close-tasks'){this.closeRecentTaskMenu(root);root.querySelector<HTMLButtonElement>('[data-work-action="recent-tasks"]')?.focus();return;}
      if(action==='create-task'||action==='link-task'){
        const workId=this.workId,documentId=this.options.currentDocumentId()||null,navigation=this.navigationSequence;
        const current=()=>!this.disposed&&this.roots.has(root)&&navigation===this.navigationSequence&&workId===this.workId;
        this.closeRecentTaskMenu(root);
        if(action==='create-task')await this.options.onCreateTask?.(workId,documentId,current);
        else if(workId)await this.options.onLinkTask?.(workId,current);
        return;
      }
      if(action==='manage-tasks'&&this.workId){this.closeRecentTaskMenu(root);this.options.onOpenPage?.({kind:'detail',workId:this.workId,section:'tasks'});return;}

      if(action==='manage' && this.options.onOpenPage){this.options.onOpenPage(this.workId?{kind:'detail',workId:this.workId}:{kind:'list'});return;}
      if ((action === 'home' || action === 'list' || action === 'select') && this.options.onOpenPage) { this.options.onOpenPage({kind:action === 'home' ? 'home' : 'list'}); return; }
      if (action === 'home') {
        this.homeOpen = !this.homeOpen;
        if (this.homeOpen) {
          this.recentTasks = await this.options.taskReader.listRecent(5);
          if (this.currentTaskId) {
            const checked = await this.options.taskReader.getTask(this.currentTaskId);
            if (shouldClearCurrentTask(this.currentTaskId, this.currentTaskId, checked)) { this.currentTaskId = null; this.currentTaskTitle = null; this.currentTaskIssue = ''; this.queueResume(true); }
            else if (checked.kind === 'found') { this.currentTaskTitle = checked.value.title; this.currentTaskIssue = ''; }
            else if (checked.kind === 'unavailable') this.currentTaskIssue = checked.reason;
          }
        }
        this.renderAll(); return;
      }
      if (action === 'create') { await this.beginCreate(); return; }
      if (action === 'cancel-create') {
        if (this.createDraft?.submitting) return;
        this.createDraft = null; this.renderAll(); return;
      }
      if (action === 'confirm-create') { await this.createFromDraft(root); return; }
      if (action === 'resume') { await this.resumeWork(button.dataset.workId || this.workId || ''); return; }
      if (action === 'select') { await this.enterWork(button.dataset.workId || ''); return; }
      if (action === 'link') {
        if (!this.workId || !this.documentId || this.workId === this.documentId) return;
        if (!window.confirm('将当前文档作为外部资料正式关联到当前 Work？')) return;
        await this.options.service.linkExternalDocument(this.workId, this.documentId, true);
        await this.refreshDocument(this.documentId); return;
      }
      if (action === 'link-chat') { await this.options.onLinkCurrentChat(); this.renderAll(); return; }
      if (action === 'task') { this.closeRecentTaskMenu(root); await this.enterTask(button.dataset.taskId || ''); return; }
      if (action === 'pin') {
        const chatId = this.options.currentChatId();
        if (!chatId) throw new Error('请先选择并连接 Chat');
        const workId=this.workId,connection=this.options.currentConnection?.(),documents=[...this.selectedDocuments];
        const pins = await this.options.store.getPins(chatId);
        if(this.disposed||!this.roots.has(root)||this.workId!==workId||this.options.currentChatId()!==chatId||this.options.currentConnection?.()!==connection)throw new Error('Work、Chat 或连接已变化，请重新固定资料');
        const next = [...pins, ...documents.filter(id => !pins.some(x => x.documentId === id)).map(documentId => ({ documentId, blockId: null, kind: 'document' as const }))];
        await this.options.store.setPins(chatId, next);
        if(this.disposed||!this.roots.has(root)||this.workId!==workId||this.options.currentChatId()!==chatId||this.options.currentConnection?.()!==connection)return;
        this.options.status('资料已固定到当前 Chat；固定待用不代表每轮自动发送。');
        this.renderAll(); return;
      }
      if (action === 'unpin') {
        const chatId = this.options.currentChatId(); if (!chatId) return;
        const workId=this.workId,connection=this.options.currentConnection?.(),documentId=button.dataset.documentId;
        if (!window.confirm('停止后续主动取用该资料？旧 Chat 历史仍可能保留已发送内容。')) return;
        const pins=await this.options.store.getPins(chatId);
        if(this.disposed||!this.roots.has(root)||this.workId!==workId||this.options.currentChatId()!==chatId||this.options.currentConnection?.()!==connection)throw new Error('Work、Chat 或连接已变化，请重新移除资料');
        await this.options.store.setPins(chatId, pins.filter(x => x.documentId !== documentId));
        this.renderAll(); return;
      }
    } catch (error) { this.options.status(error instanceof Error ? error.message : String(error)); }
  }
  private onChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.matches('[data-work-task]')) { if (this.createDraft) this.createDraft.taskId = target.value; return; }
    if (target.matches('[data-context-mode]')) this.contextMode = target.value as ContextChoice['mode'];
    if (target.matches('[data-work-doc]')) { if (target.checked) this.selectedDocuments.add(target.value); else this.selectedDocuments.delete(target.value); }
    this.options.onContextChanged?.(this.contextChoice);
    this.renderAll();
  }
  private onInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    if (target.matches('[data-work-goal]') && this.createDraft) this.createDraft.goal = target.value;
  }
  private async renderAll(): Promise<void> {
    const sequence = ++this.renderSequence;
    const work = this.workId ? await this.options.service.readWork(this.workId).catch(() => null) : null;
    let workIds: string[] = [];
    try { workIds = await this.options.store.listWorks(); }
    catch (error) { this.resolveMessage = error instanceof Error ? error.message : String(error); }
    const docs = work ? [...new Set([work.id, ...(await this.options.host.listDescendantDocuments(work.id).catch(() => [])), ...(await this.options.service.listExternalDocuments(work.id).catch(() => []))])] : [];
    const titles = await Promise.all(docs.map(async id => [id, await this.options.host.getDocumentTitle(id).catch(() => id)] as const));
    const pins = this.options.currentChatId() ? await this.options.store.getPins(this.options.currentChatId()!).catch(() => []) : [];
    const resumables = this.homeOpen ? await Promise.all(workIds.map(async id => ({ id, title: await this.options.host.getDocumentTitle(id).catch(() => id), resume: await this.options.store.getResume(id) }))) : [];
    const choices = await Promise.all(this.choiceWorkIds.map(async id => ({ id, title: await this.options.host.getDocumentTitle(id).catch(() => id) })));
    const draft = this.createDraft;
    const draftTitle = draft ? await this.options.host.getDocumentTitle(draft.documentId).catch(() => draft.documentId) : '';
    const chat = this.options.currentChat?.() || null;
    if (sequence !== this.renderSequence) return;
    for (const root of this.roots) {
      const panel = root.querySelector<HTMLElement>('[data-work-panel]'); if (!panel) continue;
      const workTitle=root.querySelector<HTMLElement>('[data-work-title]');
      if(workTitle){
        workTitle.textContent=work?.title||'文档对话';workTitle.title=work?.title||'文档对话 · Work 可选';
        const open=panel.querySelector<HTMLDetailsElement>('[data-context-details]')?.open||false;
        const mode=this.contextMode==='document'?'当前文档全文':this.contextMode==='selection'?'当前选区':this.selectedDocuments.size||this.referenceCount?'不附当前文档':'仅对话';
        const documentTitle=this.documentId?await this.options.host.getDocumentTitle(this.documentId).catch(()=>this.documentId):'未选择文档';
        if(sequence!==this.renderSequence)return;
        panel.innerHTML=`<details data-context-details ${open?'open':''}><summary>本轮资料：<span data-context-mode-label>${esc(mode)}</span>${this.contextMode==='none'?'':` · ${esc(documentTitle)}`} · 明确勾选 ${this.selectedDocuments.size} 篇 · <span data-context-references>引用 ${this.referenceCount} 项</span></summary>
          ${this.resolveMessage?`<small role="status">${esc(this.resolveMessage)}</small>`:''}
          ${choices.length?`<div class="sac-work-actions">${choices.map(choice=>`<button type="button" data-work-action="choose-owner" data-work-id="${esc(choice.id)}">${esc(choice.title)}</button>`).join('')}</div>`:''}
          <div class="sac-work-context">${(['document','selection','none'] as const).map(value=>`<label><input type="radio" data-context-mode name="work-context-${esc(root.id||'dock')}" value="${value}" ${this.contextMode===value?'checked':''}>${value==='document'?'当前文档全文':value==='selection'?'当前选区':'仅对话'}</label>`).join('')}</div>
          <small>本轮发送：${esc(this.contextMode==='none'?'不附当前文档':mode)}${this.contextMode==='none'?'':' · '+esc(documentTitle)}${this.selectedDocuments.size?'；文档：'+esc([...this.selectedDocuments].map(id=>titles.find(t=>t[0]===id)?.[1]||id).join('、')):''}。引用另列于下方引用篮。发送前会重读；本次最多 120000 字符，模型预算未知。</small>
          ${titles.map(([id,title])=>`<label><input type="checkbox" data-work-doc value="${esc(id)}" ${this.selectedDocuments.has(id)?'checked':''}>${esc(title)}</label>`).join('')}
          ${docs.length?'<button type="button" data-work-action="pin">固定所选到 Chat</button>':''}
          <details><summary>Chat 固定待选资料 (${pins.length}) · 不会自动发送</summary>${pins.map(x=>`<div>${esc(titles.find(t=>t[0]===x.documentId)?.[1]||x.documentId)} <button type="button" data-work-action="unpin" data-document-id="${esc(x.documentId)}">移除</button></div>`).join('')}<small>移除不会清除已发送的历史内容。</small></details></details>`;
        continue;
      }
      panel.innerHTML = `<div class="sac-work-bar"><button type="button" data-work-action="home">Home</button>${this.options.onOpenPage ? '<button type="button" data-work-action="list">选择 Work</button>' : ''}<strong>当前工作</strong>${work ? `<button type="button" data-work-action="resume">继续上次工作</button>` : ''}</div>
        <div class="sac-work-current" aria-label="当前 Work、任务与对话">
           <div class="sac-work-current-row" data-work-current><span class="sac-work-kind">Work</span><div><strong>${esc(work?.title || '未选择 Work')}</strong><small>以思源文档保存资料与可选目标</small></div></div>
          <div class="sac-work-current-row" data-task-current><span class="sac-work-kind">任务 · 可选</span><div><strong title="${esc(this.currentTaskId || '')}">${esc(this.currentTaskId ? this.currentTaskTitle || '已关联任务（名称待核对）' : '未关联任务')}</strong><small>${esc(this.currentTaskId ? this.currentTaskIssue ? `任务状态暂不可核对：${this.currentTaskIssue}` : '任务是待办；不决定 Work 是否可用' : '可从最近未完成任务选择，也可以一直跳过')}</small></div></div>
          <div class="sac-work-current-row" data-chat-current><span class="sac-work-kind">对话</span><div><strong>${esc(chat ? chat.linked ? chat.title : '尚未关联正式对话' : '未选择对话')}</strong><small>${esc(chat?.linked ? '对话记录关联此 Work；在上方切换' : '在上方新建或关联已有对话')}</small></div></div>
        </div>
        <small>${esc(this.resolveMessage || (work ? `目标：${work.goal || '未填写'} · ${work.status}` : '打开文档可建立 Work'))}</small>
        ${choices.length ? `<div class="sac-work-actions">${choices.map(x => `<button type="button" data-work-action="select" data-work-id="${esc(x.id)}">${esc(x.title)}</button>`).join('')}</div>` : ''}
        <div class="sac-work-actions">${draft ? '' : '<button type="button" data-work-action="create">将当前文档设为 Work</button>'}${work && this.documentId !== work.id ? '<button type="button" data-work-action="link">关联当前文档</button>' : ''}${work ? '<button type="button" data-work-action="link-chat">将当前对话关联到 Work</button>' : ''}</div>
         ${draft ? `<div class="sac-work-create"><strong>建立 Work</strong><small>当前文档：${esc(draftTitle)}。目标和任务都可选。</small><label>目标（可选）<textarea data-work-goal ${draft.submitting ? 'disabled' : ''}>${esc(draft.goal)}</textarea></label><label>任务可选（最近推荐）<select data-work-task ${draft.submitting ? 'disabled' : ''}><option value="">不关联任务，稍后再选</option>${draft.suggestions.map(task => `<option value="${esc(task.id)}" ${draft.taskId === task.id ? 'selected' : ''}>${esc(task.title)}</option>`).join('')}</select></label><small>${draft.loading ? '正在读取最近未完成任务…' : draft.taskError ? `最近任务暂不能可靠推荐：${esc(draft.taskError)}；仍可不关联任务建立 Work` : draft.suggestions.length ? '只推荐最近未完成任务；已完成任务仍在原任务列表；不会创建或修改任务' : '暂无未完成任务；可不关联任务建立 Work'}</small><div class="sac-work-actions"><button type="button" data-work-action="confirm-create" ${draft.submitting ? 'disabled' : ''}>建立 Work</button><button type="button" data-work-action="cancel-create" ${draft.submitting ? 'disabled' : ''}>取消</button></div></div>` : ''}
        <div class="sac-work-context"><span>本次上下文（模型预算未知）</span><label><input type="radio" data-context-mode name="work-context-${esc(root.id || 'dock')}" value="document" ${this.contextMode === 'document' ? 'checked' : ''}>当前文档全文</label><label><input type="radio" data-context-mode name="work-context-${esc(root.id || 'dock')}" value="selection" ${this.contextMode === 'selection' ? 'checked' : ''}>当前选区</label><label><input type="radio" data-context-mode name="work-context-${esc(root.id || 'dock')}" value="none" ${this.contextMode === 'none' ? 'checked' : ''}>仅对话</label></div>
        ${docs.length ? `<details><summary>Work 资料（逐篇勾选本次发送）</summary>${titles.map(([id, title]) => `<label><input type="checkbox" data-work-doc value="${esc(id)}" ${this.selectedDocuments.has(id) ? 'checked' : ''}>${esc(title)}</label>`).join('')}<button type="button" data-work-action="pin">固定所选到 Chat</button></details>` : ''}
        ${pins.length ? `<details><summary>Chat 固定待用资料 (${pins.length})</summary>${pins.map(x => `<div>${esc(titles.find(t => t[0] === x.documentId)?.[1] || x.documentId)} <button type="button" data-work-action="unpin" data-document-id="${esc(x.documentId)}">移除</button></div>`).join('')}</details>` : ''}
        ${this.homeOpen ? `<div class="sac-work-home"><strong>工作列表</strong><small>Work 记录文档目标；“继续”才会跳到上次位置。</small>${resumables.sort((a,b) => (b.resume?.updatedAt || '').localeCompare(a.resume?.updatedAt || '')).map(x => `<div>${esc(x.title)} <button type="button" data-work-action="select" data-work-id="${esc(x.id)}">查看</button>${x.resume ? `<button type="button" data-work-action="resume" data-work-id="${esc(x.id)}">继续</button>` : ''}</div>`).join('') || '<small>暂无 Work</small>'}<strong>最近未完成任务（可选）</strong><small>任务来自任务笔记管理；进入任务可能切换关联的 Work 或文档。</small>${this.recentTasks?.kind === 'found' ? this.recentTasks.value.map(task => `<div>${esc(task.title)} <button type="button" data-work-action="task" data-task-id="${esc(task.id)}">进入任务</button></div>`).join('') || '<small>暂无未完成任务</small>' : `<small>${esc(this.recentTasks?.reason || '任务接口未连接')}</small>`}<small>任务为只读接入；请在原任务插件中创建或修改。</small></div>` : ''}`;
    }
  }
}

export const WORK_CSS = `.sac-work{padding:8px 10px;border-bottom:1px solid var(--b3-border-color);max-height:38vh;overflow:auto;font-size:12px}.sac-work-bar,.sac-work-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}.sac-work-bar strong{flex:1;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sac-work-current{display:grid;gap:5px;margin-top:7px}.sac-work-current-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:6px;align-items:start;padding:5px 6px;border:1px solid var(--b3-border-color);border-radius:6px;background:var(--b3-theme-surface)}.sac-work-kind{color:var(--b3-theme-primary);font-weight:600}.sac-work-current-row strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sac-work-current-row small{margin:2px 0 0!important}.sac-work button{border:1px solid var(--b3-border-color);border-radius:5px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);padding:3px 6px;cursor:pointer}.sac-work small{display:block;color:var(--b3-theme-on-surface);margin:5px 0}.sac-work-context,.sac-work details,.sac-work-home,.sac-work-create{margin-top:7px}.sac-work-context label,.sac-work details label{display:inline-flex;align-items:center;margin-right:8px;gap:3px}.sac-work details label,.sac-work-create label{display:flex}.sac-work-create{padding:7px;border:1px solid var(--b3-border-color);border-radius:6px}.sac-work-create label{flex-direction:column;gap:4px;margin-top:6px}.sac-work-create textarea,.sac-work-create select{width:100%;box-sizing:border-box;border:1px solid var(--b3-border-color);border-radius:5px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);padding:5px;font:inherit}.sac-work-create textarea{min-height:56px;resize:vertical}.sac-work input{accent-color:var(--b3-theme-primary)}.sac-work-home>div{padding:3px 0}`;
