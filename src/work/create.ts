import { isValidDocumentRootId } from '../core.ts';
import type { NativeTaskReader, TaskView } from '../task/reader.ts';
import { WorkService, WorkGoalError, type WorkRecord } from './service.ts';
import { WorkStore, type PendingOperation } from './store.ts';
import { assertWorkTemplateSnapshot, type WorkTemplateSnapshot } from './templates.ts';

export type Notebook = { id: string; name: string };
export type ExistingDocument = { id: string; title: string; notebookId: string };
export type CreateContext = { documentId: string; title: string; focusBlockId?: string | null };
export type TaskSelection = Pick<TaskView, 'id' | 'title' | 'documentId' | 'projectId'>;
export type CreateInput = { mode: 'blank' | 'current'; title: string; goal: string; notebookId: string; documentId: string | null; taskId: string | null; taskSelection?: TaskSelection; template?: WorkTemplateSnapshot };
export type CreationHost = {
  listNotebooks(): Promise<Notebook[]>;
  getDocumentNotebook(id: string): Promise<string>;
  getDocumentTitle(id: string): Promise<string>;
  searchDocuments(query: string, notebooks: string[]): Promise<ExistingDocument[]>;
  getDocumentIdsByPath(notebook: string, title: string): Promise<string[]>;
  createDocument(notebook: string, title: string, operation: string, template?: WorkTemplateSnapshot): Promise<string>;
  verifyCreatedTemplate?(documentId: string, notebook: string, operation: string, template: WorkTemplateSnapshot): Promise<void>;
  findCreatedDocuments(notebook: string, operation: string): Promise<string[]>;
};
type Intent = { version: 1; input: CreateInput; documentId: string | null; workReady: boolean; repairAttempted?: boolean; templateVerified?: boolean };
export type CreateResult = { kind: 'complete' | 'pending' | 'partial'; operationId: string; work: WorkRecord | null; message: string };
export type GoalResult = { kind: 'complete' | 'pending'; operationId: string; work: WorkRecord | null; message: string };
type GoalIntent = { version: 1; goal: string; attempted: boolean };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const prefix = 'work-create:';
const goalPrefix = 'work-goal:';
const validTaskSelection = (value: unknown): value is TaskSelection => {
  if (!value || typeof value !== 'object') return false;
  const task=value as Record<string,unknown>;
  return typeof task.id==='string' && Boolean(task.id) && typeof task.title==='string'
    && (task.documentId===null || typeof task.documentId==='string')
    && (task.projectId===null || typeof task.projectId==='string');
};
const taskSelection = (value: TaskView): TaskSelection => ({id:value.id,title:value.title,documentId:value.documentId??null,projectId:value.projectId??null});

/** One shared instance per plugin serializes all creation entry points. Pending is the durable fence. */
export class WorkCreator {
  private busy = false;
  private volatile = new Map<string, { pending: PendingOperation; intent: Intent }>();
  private deferredExisting = new Map<string,string>();
  constructor(private readonly host: CreationHost, private readonly store: WorkStore, private readonly service: WorkService,
    private readonly tasks: Pick<NativeTaskReader, 'listRecent' | 'getTask'> & Partial<Pick<NativeTaskReader,'search'>>) {}
  async prepare(context: CreateContext | null, preferredNotebookId = '') {
    const frozen = context ? { ...context } : null;
    const notebooks = await this.host.listNotebooks();
    let notebookId = '', contextNotebookId = '', locationError = '';
    if (frozen) {
      frozen.title = await this.host.getDocumentTitle(frozen.documentId);
      try { contextNotebookId = await this.host.getDocumentNotebook(frozen.documentId); }
      catch (error) { locationError = message(error); }
      if (contextNotebookId && !notebooks.some(n => n.id === contextNotebookId)) { contextNotebookId = ''; locationError ||= '原文档所在笔记本未打开'; }
    }
    if (preferredNotebookId) {
      if (notebooks.some(n => n.id === preferredNotebookId)) notebookId = preferredNotebookId;
      else locationError ||= '设置的默认保存笔记本未打开，请重新选择';
    } else notebookId = contextNotebookId;
    return { context: frozen, notebooks, notebookId, contextNotebookId, locationError };
  }
  async searchDocuments(query: string, notebooks: string[]): Promise<ExistingDocument[]> { return this.host.searchDocuments(query,notebooks); }
  async recentTasks() { return this.tasks.listRecent(5); }
  async searchTasks(query: string) { return this.tasks.search ? this.tasks.search(query) : {kind:'unavailable' as const,reason:'当前任务接口未提供搜索能力'}; }
  async pending(): Promise<PendingOperation[]> {
    const persisted = (await this.store.listPending()).filter(p => p.kind === 'work' && p.id.startsWith(prefix));
    // Disk is authoritative after another window updates a pending operation.
    return [...new Map([[...this.volatile.values()].map(v => v.pending), persisted].flat().map(p => [p.id, p])).values()];
  }
  async goalPending(workId: string): Promise<PendingOperation | null> {
    if(!isValidDocumentRootId(workId))throw new Error('需要有效的 Work 根文档');
    const pending=(await this.store.listPending()).find(p=>p.id===goalPrefix+workId);
    if(pending&&(pending.kind!=='work'||pending.workId!==workId))throw new Error('目标待核对记录身份冲突或损坏，已停止写入');
    return pending??null;
  }
  async addGoal(workId: string, requestedGoal: string, approved: boolean): Promise<GoalResult> {
    return this.exclusive(async () => {
      if(!approved)throw new Error('请先确认向 Work 添加目标');
      if(!isValidDocumentRootId(workId))throw new Error('需要有效的 Work 根文档');
      const goal=requestedGoal.trim().replace(/\s+/g,' ');
      if(!goal)throw new Error('请填写要添加的工作目标');
      if((await this.pending()).some(p=>p.workId===workId))throw new Error('这篇 Work 有待核对的创建记录，请先核对后再添加目标');
      const id=goalPrefix+workId,previous=await this.goalPending(workId);
      let intent:GoalIntent={version:1,goal,attempted:false};
      if(previous){
        try{intent=JSON.parse(previous.details);}catch{throw new Error('目标待核对记录损坏，已停止写入');}
        if(intent?.version!==1||typeof intent.goal!=='string'||typeof intent.attempted!=='boolean')throw new Error('目标待核对记录格式错误，已停止写入');
        if(intent.goal!==goal)throw new Error('已有另一项待核对目标，请先核对原目标，不会写入新目标');
      }
      let work:WorkRecord|null;
      try{work=await this.service.readWork(workId);}catch(error){
        if(previous?.state==='unknown')return {kind:'pending',operationId:id,work:null,message:`上次目标写入结果仍待核对：${message(error)}。不会再次写入`};
        throw error;
      }
      if(!work)throw new Error('Work 标记不存在，不能添加目标');
      if(work.goal){
        if(work.goal!==goal)throw new Error('Work 已有不同目标；不会覆盖，请先核对文档');
        if(previous)await this.store.clearPending(id);
        return {kind:'complete',operationId:id,work,message:'目标已读回，Work 保持原有身份和关联'};
      }
      if(intent.attempted)return {kind:'pending',operationId:id,work,message:'上次目标写入结果尚未读回。不会再次写入；请稍后核对文档'};
      if(previous)return {kind:'pending',operationId:id,work,message:'已有未完成的目标记录；先核对原文档和记录，不会从另一窗口再次写入'};
      const pending=(attempted:boolean):PendingOperation=>({id,kind:'work',workId,state:attempted?'unknown':'partial',details:JSON.stringify({...intent,attempted}),updatedAt:new Date().toISOString()});
      await this.store.setPending(pending(false));
      let writeMayHaveStarted=false;
      try{
        work=await this.service.repairMissingGoal(workId,goal,true,async()=>{await this.store.setPending(pending(true));writeMayHaveStarted=true;});
        await this.store.clearPending(id);
        return {kind:'complete',operationId:id,work,message:'目标已添加并读回，原 Work 关系已保留'};
      }catch(error){
        if(!writeMayHaveStarted){
          try{await this.store.clearPending(id);}
          catch(clearError){return {kind:'pending',operationId:id,work:null,message:`目标尚未写入，但待核对记录未能清除：${message(clearError)}。请先核对记录`};}
          throw new Error(`尚未写入目标：${message(error)}。可检查后重试`);
        }
        return {kind:'pending',operationId:id,work:null,message:`目标尚未完成核对：${message(error)}。记录已保留；若写入结果不明，核对时不会再次写入`};
      }
    });
  }
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error('Work 创建或核对正在进行，请等待');
    this.busy = true;
    try {
      const locks=typeof navigator==='undefined'?undefined:navigator.locks;
      if(locks)return await locks.request('siyuan-ai-collab:work-mutation',{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock)throw new Error('另一窗口正在创建或核对 Work，请稍后重新读取');
        return run();
      });
      if(typeof window!=='undefined')throw new Error('当前窗口不支持安全并发锁，已停止 Work 写入；请在思源桌面重新打开插件后重试');
      return await run();
    } finally { this.busy = false; }
  }
  private async checkTask(taskId: string, workId: string | null, expected?: TaskSelection): Promise<TaskSelection> {
    const checked = await this.tasks.getTask(taskId);
    if (checked.kind === 'unavailable') throw new Error(`任务失联，状态未知：${checked.reason}；请重新手选或跳过任务`);
    if (checked.kind === 'missing') throw new Error('所选任务已不存在；请重新手选其他任务或跳过');
    if (checked.value.id !== taskId) throw new Error('任务 ID 与所选任务不一致，已停止关联，请重新手选并核对');
    if (checked.value.completed) throw new Error('所选任务已完成；请重新手选其他任务或跳过');
    const actual=taskSelection(checked.value);
    if (expected && (actual.id!==expected.id || actual.title!==expected.title || actual.documentId!==expected.documentId || actual.projectId!==expected.projectId))
      throw new Error('任务标题、项目或关联文档已变化；请重新手选并核对');
    for (const id of await this.store.listWorks()) {
      if (id !== workId && (await this.store.listTasks(id)).some(t => t.taskId === taskId && t.connectionId === 'siyuan-native-local')) throw new Error('所选任务已有其他 Work，不能改变归属；请重新手选其他任务或跳过');
    }
    return actual;
  }
  private decode(pending: PendingOperation): Intent {
    let value: Intent;
    try { value = JSON.parse(pending.details); } catch { throw new Error('创建恢复记录损坏，请人工核对；不会重新创建'); }
    const i = value?.input;
    if (value?.version !== 1 || !i || !['blank','current'].includes(i.mode) || typeof i.title !== 'string' || typeof i.goal !== 'string' ||
      typeof i.notebookId !== 'string' || !(i.taskId === null || typeof i.taskId === 'string') || !(i.documentId === null || isValidDocumentRootId(i.documentId)) ||
      !(value.documentId === null || isValidDocumentRootId(value.documentId)) || typeof value.workReady !== 'boolean' ||
      !(value.repairAttempted === undefined || typeof value.repairAttempted === 'boolean') ||
      !(value.templateVerified === undefined || typeof value.templateVerified === 'boolean') ||
      (value.templateVerified === true && (!i.template || !value.documentId)) ||
      !(i.taskSelection === undefined || (validTaskSelection(i.taskSelection) && i.taskSelection.id === i.taskId)) ||
      (i.mode === 'current' && value.documentId !== i.documentId)) throw new Error('创建恢复记录格式错误，请人工核对');
    if (i.template !== undefined) {
      assertWorkTemplateSnapshot(i.template);
      if (i.mode !== 'blank' || (value.workReady && value.templateVerified !== true)) throw new Error('创建恢复记录中的模板状态无法核验');
    }
    return value;
  }
  private async save(id: string, intent: Intent): Promise<void> {
    const pending: PendingOperation = {id, kind:'work', workId:intent.documentId, state:intent.documentId?'partial':'unknown', details:JSON.stringify(intent), updatedAt:new Date().toISOString()};
    this.volatile.set(id,{pending,intent});
    await this.store.setPending(pending);
    this.volatile.delete(id);
  }
  async submit(input: CreateInput): Promise<CreateResult> {
    // Capture before the first await: callers/editor changes cannot retarget a submitted operation.
    const captured = { ...input, taskSelection:input.taskSelection === undefined ? undefined : {...input.taskSelection}, template:input.template === undefined ? undefined : {...input.template} };
    return this.exclusive(async () => {
      if (captured.template !== undefined) {
        assertWorkTemplateSnapshot(captured.template);
        if (captured.mode !== 'blank') throw new Error('模板仅用于新建工作文档，不会写入现有文档');
        if (!this.host.verifyCreatedTemplate) throw new Error('当前环境不能完整核验模板创建，请选择空白文档或更新插件');
      }
      const blocked=(await this.pending()).some(p=>{
        const deferredId=this.deferredExisting.get(p.id);
        if(!deferredId||p.workId!==deferredId)return true;
        const intent=this.decode(p);
        return intent.input.mode!=='current'||intent.documentId!==deferredId||captured.mode==='current'&&captured.documentId===deferredId;
      });
      if (blocked) throw new Error('存在待核对的 Work 创建，请先核对；暂放的原文档不能重复提交');
      if (captured.mode === 'blank') {
        if (!captured.title.trim() || captured.title !== captured.title.trim() || /[\/\\\u0000-\u001f\u007f]/u.test(captured.title) || ['.','..'].includes(captured.title)) throw new Error('名称不能为空或包含首尾空格、控制字符、斜杠 / 或反斜杠；请使用单篇文档名称');
        if (!(await this.host.listNotebooks()).some(n => n.id === captured.notebookId)) throw new Error('请选择一个已打开的笔记本');
        if ((await this.host.getDocumentIdsByPath(captured.notebookId,captured.title)).length) throw new Error('保存位置已有同名文档，请换名或明确使用已有文档');
      } else {
        if (!isValidDocumentRootId(captured.documentId)) throw new Error('需要有效的原文档 ID');
        captured.notebookId = await this.host.getDocumentNotebook(captured.documentId);
        if (!(await this.host.listNotebooks()).some(n => n.id === captured.notebookId)) throw new Error('原文档所在笔记本未打开，请先打开笔记本');
        // A known invalid existing Work is a preflight failure, not an unknown native write.
        try {
          const existing=await this.service.readWork(captured.documentId);
          if(existing&&!existing.goal&&captured.goal.trim())throw new Error('这篇文档已是无目标 Work；请在 Work 管理页明确添加目标，本次不会改写');
        }
        catch(error) { if(error instanceof WorkGoalError)throw new Error('所选文档已有重复的工作目标标记。请打开文档核对，或选择其他文档；本次未建立 Work');throw error; }
      }
      if (captured.taskSelection !== undefined && (!validTaskSelection(captured.taskSelection) || captured.taskSelection.id!==captured.taskId)) throw new Error('所选任务身份不完整，请重新手选任务');
      if (captured.taskId) captured.taskSelection = await this.checkTask(captured.taskId, captured.mode === 'current' ? captured.documentId : null, captured.taskSelection);
      const id = prefix + crypto.randomUUID();
      const intent: Intent = {version:1,input:captured,documentId:captured.mode==='current'?captured.documentId:null,workReady:false};
      // Failure here proves no native write was submitted. Allow a corrected storage retry.
      try { await this.save(id,intent); } catch(error) { this.volatile.delete(id); throw error; }
      let submissionError = '';
      if (captured.mode === 'blank') {
        try {
          intent.documentId = await this.host.createDocument(captured.notebookId,captured.title,id,captured.template);
          await this.save(id,intent);
        } catch(error) { submissionError = message(error); }
      }
      return this.finish(id,intent,submissionError);
    });
  }
  async resume(id: string, skipTask = false): Promise<CreateResult> {
    return this.exclusive(async () => {
      const p = (await this.pending()).find(p => p.id === id);
      if (!p) throw new Error('未找到待核对的创建操作');
      this.deferredExisting.delete(id);
      const intent = this.decode(p);
      // Persist before continuing any partial operation, including association-only retries.
      try { await this.save(id,intent); } catch(error) { return {kind:intent.workReady?'partial':'pending',operationId:id,work:null,message:`恢复记录保存失败，未继续：${message(error)}`}; }
      return this.finish(id,intent,'',skipTask);
    });
  }
  async continueWithoutGoal(id: string, approved: boolean): Promise<CreateResult> {
    return this.exclusive(async () => {
      if(!approved)throw new Error('请先确认不采用旧创建记录中的目标');
      const p=(await this.pending()).find(p=>p.id===id);
      if(!p)throw new Error('未找到待核对的创建操作');
      const intent=this.decode(p);
      if(intent.input.mode!=='current'||!intent.documentId||p.workId!==intent.documentId||intent.workReady)
        throw new Error('只可对已标记、尚未完成的现有 Work 选择无目标继续');
      if(intent.repairAttempted)throw new Error('上次修复结果仍待核对，不能跳过未知的目标写入');
      const work=await this.service.readWork(intent.documentId);
      if(!work||work.goal)throw new Error('Work 标记或目标已变化，请核对原文档后再继续');
      const omitted:Intent={...intent,input:{...intent.input,goal:''}};
      await this.save(id,omitted);
      this.deferredExisting.delete(id);
      return this.finish(id,omitted);
    });
  }
  async setAsideExistingCreation(id: string, approved: boolean): Promise<void> {
    return this.exclusive(async () => {
      if(!approved)throw new Error('请先确认保留待核对记录并另建其他 Work');
      const pending=(await this.pending()).find(p=>p.id===id);
      if(!pending)throw new Error('未找到待核对的创建操作');
      const intent=this.decode(pending);
      if(intent.input.mode!=='current'||!intent.documentId||pending.workId!==intent.documentId)throw new Error('新文档创建结果仍需核对，不能暂放未知目标的操作');
      // A duplicate role or a saved old goal awaiting the user's choice may be set aside.
      // An offline/malformed read must preserve the fence. Never delete content or formal links.
      let blocked=false;
      try { const work=await this.service.readWork(intent.documentId);blocked=Boolean(work&&!work.goal&&intent.input.goal.trim()&&!intent.workReady); }
      catch(error) { if(error instanceof WorkGoalError&&error.workId===intent.documentId)blocked=true;else throw error; }
      if(!blocked)throw new Error('该操作仍可继续核对；仅可暂放旧目标未决或重复目标的现有文档创建');
      // workReady can be stale after a failed save. Preserve every recovery detail even if
      // native writes already succeeded, and authorize only other document targets this run.
      this.deferredExisting.set(id,intent.documentId);
    });
  }
  async repairExistingCreation(id: string, approved: boolean): Promise<CreateResult> {
    return this.exclusive(async () => {
      if (!approved) throw new Error('请先确认修复这篇 Work');
      const pending = (await this.pending()).find(p => p.id === id);
      if (!pending) throw new Error('未找到待核对的创建操作');
      const intent = this.decode(pending);
      if (intent.input.mode !== 'current' || !intent.documentId || pending.workId !== intent.documentId) throw new Error('旧文档身份无法核对，已停止修复');
      this.deferredExisting.delete(id);
      // Save the existing intent before any native write. The pending record remains the fence.
      try { await this.save(id, intent); }
      catch (error) { return {kind:'pending',operationId:id,work:null,message:`恢复记录保存失败，未修复文档：${message(error)}`}; }
      if (intent.repairAttempted) {
        try {
          const work = await this.service.readWork(intent.documentId);
          const expectedGoal = intent.input.goal.trim().replace(/\s+/g, ' ');
          if (!work || work.goal !== expectedGoal) throw new Error('目标尚未读回，或与旧创建记录不一致');
        } catch (error) {
          return {kind:'pending',operationId:id,work:null,message:`上次修复结果仍待核对：${message(error)}。不会再次写入目标；请稍后核对原文档`};
        }
      } else {
        try {
          await this.service.repairMissingGoal(intent.documentId, intent.input.goal, true, async () => {
            // Persist the write-attempt fence before the native request. A timeout can still commit later.
            const previous = this.volatile.get(id);
            const attempted = {...intent, repairAttempted:true};
            try { await this.save(id, attempted); }
            catch (error) {
              // No native write was submitted. Keep the in-memory retry state aligned.
              if (previous) this.volatile.set(id, previous);
              else this.volatile.delete(id);
              throw error;
            }
            intent.repairAttempted = true;
          });
        } catch (error) {
          return {kind:'pending',operationId:id,work:null,message:`修复结果待核对：${message(error)}。原创建记录已保留；请核对原文档，写入结果不明时不会再次补写`};
        }
      }
      return this.finish(id, intent);
    });
  }
  private async finish(id: string, intent: Intent, submissionError = '', skipTask = false): Promise<CreateResult> {
    let work: WorkRecord | null = null;
    let markerReadFailed = false;
    try {
      if (!(await this.host.listNotebooks()).some(n => n.id === intent.input.notebookId)) throw new Error('创建使用的笔记本未打开，请先打开再核对');
      if (intent.input.mode === 'blank') {
        const matches = await this.host.findCreatedDocuments(intent.input.notebookId,id);
        if (matches.length !== 1 || (intent.documentId && intent.documentId !== matches[0])) throw new Error(matches.length > 1 ? '操作标记对应多个文档，请人工核对' : '尚不能唯一确认新文档，请稍后核对；不会重新创建');
        intent.documentId = matches[0];
        await this.save(id,intent);
      }
      if (!intent.documentId) throw new Error('创建文档尚未确认');
      if (intent.input.template && !intent.templateVerified) {
        if (!this.host.verifyCreatedTemplate) throw new Error('当前环境不能完整核验原模板，保留创建记录');
        await this.host.verifyCreatedTemplate(intent.documentId,intent.input.notebookId,id,intent.input.template);
        // Persist complete readback before Work/Goal mutations. Subsequent recovery
        // must not mistake later intentional edits for a failed template creation.
        intent.templateVerified = true;
        await this.save(id,intent);
      }
      if (intent.repairAttempted) {
        const verified = await this.service.readWork(intent.documentId);
        if (!verified || verified.goal !== intent.input.goal.trim().replace(/\s+/g, ' '))
          throw new Error('上次修复的目标尚未读回，或与旧创建记录不一致');
      }
      if (intent.workReady) {
        work = await this.service.readWork(intent.documentId);
        if (!work) throw new Error('已创建 Work 的标记无法核对，已停止任务关联');
      } else {
        if(intent.input.mode==='current'&&intent.input.goal.trim()){
          const existing=await this.service.readWork(intent.documentId);
          if(existing&&!existing.goal)throw new Error('旧记录仍有上次填写的目标；请明确选择“补写目标”或“无需目标，继续 Work”');
        }
        work = await this.service.createFromDocument({documentId:intent.documentId,goal:intent.input.goal,approved:true});
        intent.workReady = true;
        await this.save(id,intent);
      }
      let retainedTask = false;
      if (intent.input.taskId) {
        // A task save can succeed before pending cleanup fails. Formal relations are authoritative;
        // skipping remaining work must never erase that fact or imply an existing link was undone.
        const workId = work.id,taskId=intent.input.taskId;
        retainedTask = (await this.store.listTasks(workId)).some(link => link.taskId === taskId && link.workId === workId && link.connectionId === 'siyuan-native-local');
        if (!retainedTask && skipTask) {
          intent.input.taskId = null;
          delete intent.input.taskSelection;
          await this.save(id,intent);
        } else if (!retainedTask) {
          const selected=await this.checkTask(taskId,workId,intent.input.taskSelection);
          if (!intent.input.taskSelection) {
            // Older v1 pending records saved only the task ID. Establish and persist a
            // new readback baseline before the formal relation enters its queue.
            intent.input.taskSelection=selected;
            await this.save(id,intent);
          }
          await this.store.linkTask({taskId,workId,connectionId:'siyuan-native-local'}, {
            validate:async()=>{
              let current:WorkRecord|null;
              try {current=await this.service.readWork(workId);}
              catch(error){markerReadFailed=true;throw error;}
              if (!current){markerReadFailed=true;throw new Error('Work 标记已变化；请重新核对 Work 后重新手选任务');}
              await this.checkTask(taskId,workId,selected);
            },
            checkCurrent:()=>{if(intent.documentId!==workId || intent.input.taskId!==taskId)throw new Error('创建目标或任务已变化；请重新核对后手选');},
          });
        }
      }
      await this.store.clearPending(id);
      this.volatile.delete(id);
      return {kind:'complete',operationId:id,work,message:retainedTask?'Work 已建立，原任务关联已保留':intent.input.taskId?'Work 已建立，任务已关联':'Work 已建立，未关联任务'};
    } catch(error) {
      if(markerReadFailed)return {kind:'partial',operationId:id,work:null,message:`Work 标记无法核对，任务未关联：${message(error)}。待核对记录已保留；请核对文档后再处理任务`};
      if (intent.repairAttempted && !work) return {kind:intent.workReady?'partial':'pending',operationId:id,work:null,message:`上次修复结果仍待核对：${message(error)}。不会再次写入目标；请核对原文档`};
      if(error instanceof WorkGoalError&&!intent.workReady&&intent.input.mode==='current')return {kind:'pending',operationId:id,work:null,message:'这次创建选用的旧文档有多个目标角色块。原文档、已有关联和待核对记录已保留；请打开文档核对。'};
      const taskAdvice=work && intent.input.taskId && !skipTask?'。若任务身份已变化，可在待核对区跳过本次任务，再到 Work 管理中重新手选关联':'';
      return {kind:work || intent.workReady?'partial':'pending',operationId:id,work,message:`${work || intent.workReady?'Work 已建立，后续步骤未全部完成':'创建结果待核对'}：${message(error)}${submissionError?`（提交或保存返回：${submissionError}）`:''}${taskAdvice}`};
    }
  }
}
