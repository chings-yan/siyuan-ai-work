import type { App, ICommand, IProtyle, Plugin, Protyle } from 'siyuan';

export type NativeTaskRequest = {
  documentId: string | null;
  workId?: string;
  /** 核对冻结 Work / 页面仍有效；异步核对后适配器还会复查编辑器身份。 */
  isCurrent: () => boolean | Promise<boolean>;
};
export type NativeTaskTarget = Readonly<{ documentId: string | null; workId: string | null }>;
export type NativeTaskState = Readonly<{
  kind: 'idle' | 'opening' | 'opened' | 'unknown' | 'blocked';
  reason: string;
  target: NativeTaskTarget | null;
}>;
export type NativeTaskDependencies = {
  document?: Document;
  /** 生产传公开 getAllEditor；必须保留真正的 wrapper.protyle。 */
  getAllEditor?: () => readonly Protyle[] | Promise<readonly Protyle[]>;
  /** 由页面明确提供导航；适配器仅在 guard 有效时打开冻结目标一次。 */
  openDocument?: (documentId: string) => void | Promise<void>;
  wait?: (milliseconds: number) => Promise<void>;
  editorAttempts?: number;
  commandTimeoutMs?: number;
};
const PLUGIN_NAME = 'siyuan-plugin-task-note-management';
const DOCUMENT_COMMAND = 'shortcutSetDocumentAsTask';
const CALENDAR_COMMAND = 'shortcutOpenCalendarView';
const STALE_REASON = '页面或 Work 已变化，本次入口已停止。请重新核对目标后操作。';
const EDITOR_REASON = '未找到当前窗口中这篇文档的有效编辑器。请先打开目标文档，再重试。';

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
}

/** 只发起原生入口；不写任务、不生成 Task ID，也不把命令返回当作保存成功。 */
export class NativeTaskAdapter {
  private state: NativeTaskState = Object.freeze({ kind: 'idle', reason: '', target: null });
  private readonly attempts: number;
  private readonly timeoutMs: number;
  constructor(private readonly app: App, private readonly dependencies: NativeTaskDependencies = {}) {
    this.attempts = bounded(dependencies.editorAttempts, 10, 20);
    this.timeoutMs = bounded(dependencies.commandTimeoutMs, 8000, 30000);
  }
  getState(): NativeTaskState { return this.state; }
  /** 仅由用户明确返回核对或准备下一次时调用；不会关闭原生表单或证明未创建。 */
  prepareNext(): boolean {
    if (this.state.kind === 'opening') return false;
    this.state = Object.freeze({ kind: 'idle', reason: '', target: null });
    return true;
  }
  private setState(kind: NativeTaskState['kind'], reason: string, target: NativeTaskTarget): NativeTaskState {
    this.state = Object.freeze({ kind, reason, target });
    return this.state;
  }
  private pluginCommand(documentId: string | null): { plugin: Plugin; command: ICommand } {
    const plugin = this.app.plugins?.find(item => item.name === PLUGIN_NAME && item.app === this.app);
    if (!plugin) throw new Error('当前窗口未加载任务笔记管理插件，请启用插件后重试。');
    const key = documentId === null ? CALENDAR_COMMAND : DOCUMENT_COMMAND;
    const command = plugin.commands?.find(item => item.langKey === key &&
      (documentId === null ? typeof item.callback === 'function' : typeof item.editorCallback === 'function'));
    if (!command) throw new Error(documentId === null ? '任务插件的原生日历入口尚未注册，请稍后重试。' : '任务插件的文档任务表单命令尚未注册，请稍后重试。');
    return { plugin, command };
  }
  private validEditor(protyle: IProtyle | undefined, documentId: string): protyle is IProtyle {
    const owner = this.dependencies.document ?? globalThis.document;
    return !!owner && !!protyle && protyle.app === this.app && protyle.block?.rootID === documentId &&
      !!protyle.element && protyle.element.ownerDocument === owner && protyle.element.isConnected;
  }
  private async findEditor(documentId: string): Promise<IProtyle | undefined> {
    const editors = this.dependencies.getAllEditor ? await this.dependencies.getAllEditor() : (await import('siyuan')).getAllEditor();
    return editors.find(editor => this.validEditor(editor?.protyle, documentId))?.protyle;
  }
  private async checkCurrent(isCurrent: NativeTaskRequest['isCurrent']): Promise<void> {
    if (!await isCurrent()) throw new Error(STALE_REASON);
  }
  private async waitForEditor(documentId: string, isCurrent: NativeTaskRequest['isCurrent']): Promise<IProtyle> {
    let editor = await this.findEditor(documentId);
    if (editor) return editor;
    if (!this.dependencies.openDocument) throw new Error(EDITOR_REASON);
    await this.checkCurrent(isCurrent);
    await this.dependencies.openDocument(documentId);
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      await this.checkCurrent(isCurrent);
      editor = await this.findEditor(documentId);
      if (editor) return editor;
      if (attempt < this.attempts - 1) await (this.dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))))(100);
    }
    throw new Error(EDITOR_REASON);
  }
  private async invoke(invoke: () => void, target: NativeTaskTarget): Promise<NativeTaskState> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // 调用前已保留 opening；SDK 的 void 签名不保证运行时命令没有 Promise。
      const result: unknown = invoke();
      await Promise.race([
        Promise.resolve(result),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs); }),
      ]);
      return this.setState('opened', target.documentId === null
        ? '已发起打开原生日历，请在原生页面新建并保存；返回 Work 后搜索、手选并核对任务。此返回不表示任务已创建。'
        : '已发起打开原生任务表单，请核对项目和关联文档并保存；返回 Work 后搜索、手选并核对任务。此返回不表示任务已创建。', target);
    } catch {
      return this.setState('unknown', '原生命令已经发起，但打开或保存结果未知。请先到任务插件核对，再返回搜索和选择任务；不要重复发起。', target);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  async open(request: NativeTaskRequest): Promise<NativeTaskState> {
    if (this.state.kind === 'opening' || this.state.kind === 'opened' || this.state.kind === 'unknown') return this.state;
    const target: NativeTaskTarget = Object.freeze({ documentId: request.documentId, workId: request.workId ?? null });
    const isCurrent = request.isCurrent;
    this.setState('opening', '正在核对原生任务入口和目标文档。', target);
    try {
      if (target.documentId !== null && !/^\d{14}-[a-z0-9]{7}$/.test(target.documentId)) throw new Error('目标文档 ID 无效，请重新选择确定的根文档。');
      await this.checkCurrent(isCurrent);
      const { plugin, command } = this.pluginCommand(target.documentId);
      const editor = target.documentId === null ? undefined : await this.waitForEditor(target.documentId, isCurrent);
      await this.checkCurrent(isCurrent);
      // 最后一次 await 之后同步核对真实编辑器和命令，避免导航或插件重载改变目标。
      const latest = this.pluginCommand(target.documentId);
      if (latest.plugin !== plugin || latest.command !== command) throw new Error('任务插件入口已变化，请重新核对后重试。');
      if (target.documentId !== null && !this.validEditor(editor, target.documentId)) throw new Error(EDITOR_REASON);
      return await this.invoke(() => {
        if (target.documentId === null) return command.callback!();
        return command.editorCallback!(editor!);
      }, target);
    } catch (error) {
      return this.setState('blocked', error instanceof Error ? error.message : '核对任务入口失败，请确认插件和目标文档后重试。', target);
    }
  }
}
