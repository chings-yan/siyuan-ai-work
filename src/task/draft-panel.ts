import { trapDialogKey } from '../work/dialog-focus';
import { draftCharacterCount, prepareTaskDrafts, serializeTaskDraft, taskDraftIssue, TASK_DRAFT_CONTENT_LIMIT, TASK_DRAFT_TITLE_LIMIT } from './draft';
import type { TaskDraftInput, TaskDraftItem, TaskDraftSet, TaskDraftSource } from './draft';

export type TaskDraftPorts = {
  isCurrent(source: TaskDraftSource): boolean;
  copyText(text: string): Promise<void>;
  /** unknown.reason is a local, public explanation; never pass remote payloads or raw errors here. */
  openNative(source: TaskDraftSource, isCurrent: () => boolean): Promise<{ kind: string; reason?: string } | void>;
  prepareNext(source: TaskDraftSource, isCurrent: () => boolean): boolean | Promise<boolean>;
  associate(source: TaskDraftSource, isCurrent: () => boolean): Promise<void>;
};
type BusyAction = 'copy' | 'open-native' | 'prepare-next' | 'associate' | null;
type NativeResult = 'idle' | 'opening' | 'opened' | 'blocked' | 'unknown';

/** An editable local review surface. Ports deliberately have no task creation or mutation API. */
export class TaskDraftPanel {
  private overlay: HTMLElement | null = null;
  private draft: TaskDraftSet | null = null;
  private selected = 0;
  private disposed = false;
  private sourceChanged = false;
  private busy: BusyAction = null;
  private nativeResult: NativeResult = 'idle';
  private nativeReason = '';
  private nativeHadUnknown = false;
  private notice = '';
  private origin: HTMLElement | null = null;
  private titleField: HTMLTextAreaElement | null = null;
  private descriptionField: HTMLTextAreaElement | null = null;
  private itemSelect: HTMLSelectElement | null = null;
  private count: HTMLElement | null = null;
  private issue: HTMLElement | null = null;
  private status: HTMLElement | null = null;

  constructor(private readonly document: Document, private readonly ports: TaskDraftPorts) {}

  open(input: TaskDraftInput): boolean {
    if (this.disposed || this.busy) return false;
    const next = prepareTaskDrafts(input);
    if (this.draft && this.sameSource(this.draft.source, next.source)) {
      // A source key represents an immutable revision. Never replace edited text under that key.
      if (this.draft.originalBody !== next.originalBody) this.sourceChanged = true;
    } else {
      if (this.overlay) {
        this.notice = '当前草稿仍在核对，请先复制或关闭，再整理另一份来源。';
        this.refresh();
        return false;
      }
      this.draft = next;
      this.selected = 0;
      this.sourceChanged = false;
      this.notice = '';
    }
    if (this.overlay) { this.refresh(); return true; }
    this.origin = this.document.activeElement instanceof this.document.defaultView!.HTMLElement
      ? this.document.activeElement as HTMLElement : null;
    this.mount();
    return true;
  }

  refresh(): void {
    if (!this.overlay || !this.draft) return;
    const item = this.item();
    const issue = taskDraftIssue(item);
    const current = this.isCurrent(this.draft);
    this.count!.textContent = `标题 ${draftCharacterCount(item.title)} / ${TASK_DRAFT_TITLE_LIMIT} 字 · 说明 ${draftCharacterCount(item.description)} / ${TASK_DRAFT_CONTENT_LIMIT} 字`;
    this.issue!.textContent = issue || '';
    this.issue!.hidden = !issue;
    const nativeNotice = this.nativeNotice();
    this.status!.textContent = !current
      ? '文档或来源已变化，草稿和编辑已保留。仍可复制；请返回原来源核对后再创建或关联。'
      : [...new Set([this.notice, nativeNotice].filter(Boolean))].join(' ');
    this.status!.hidden = !this.status!.textContent;
    this.titleField!.disabled = !!this.busy;
    this.descriptionField!.disabled = !!this.busy;
    this.itemSelect!.disabled = !!this.busy;
    const prepare = this.overlay.querySelector<HTMLButtonElement>('[data-task-draft-action="prepare-next"]')!;
    prepare.hidden = !['opened', 'unknown'].includes(this.nativeResult);
    this.overlay.querySelector<HTMLElement>('[data-task-draft-prepare-help]')!.hidden = prepare.hidden;
    this.overlay.querySelector<HTMLElement>('[data-task-draft-native-history]')!.hidden = !this.nativeHadUnknown;
    for (const button of this.overlay.querySelectorAll<HTMLButtonElement>('[data-task-draft-action]')) {
      const action = button.dataset.taskDraftAction;
      button.disabled = !!this.busy || (action === 'copy' && !!issue)
        || (action === 'open-native' && (!!issue || !current || ['opening', 'opened', 'unknown'].includes(this.nativeResult)))
        || (action === 'associate' && !current)
        || (action === 'prepare-next' && (!current || prepare.hidden));
    }
    const native = this.overlay.querySelector<HTMLButtonElement>('[data-task-draft-action="open-native"]')!;
    native.textContent = this.busy === 'open-native' ? '正在打开…' : '打开任务插件创建';
    const copy = this.overlay.querySelector<HTMLButtonElement>('[data-task-draft-action="copy"]')!;
    copy.textContent = this.busy === 'copy' ? '正在复制…' : '复制草稿';
  }

  close(): boolean {
    if (this.busy) return false;
    this.remove(true);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.remove(false);
    this.draft = null;
  }

  private sameSource(a: TaskDraftSource, b: TaskDraftSource): boolean {
    return a.kind === b.kind && a.key === b.key && a.documentId === b.documentId && a.documentTitle === b.documentTitle;
  }
  private item(): TaskDraftItem { return this.draft!.items[this.selected]; }
  private nativeNotice(): string {
    if (this.nativeResult === 'opened') return '已打开任务插件入口，不表示任务已保存。请手动填写并核对；保存后再准确选择已有任务。';
    if (this.nativeResult === 'unknown') return `${this.nativeReason ? `${this.nativeReason} ` : ''}任务插件打开结果未知，请先到原插件核对；不会自动重试。草稿已保留，可继续复制。`;
    return '';
  }
  private publicNativeReason(value: unknown): string {
    if (typeof value !== 'string' || value.length > 1000) return '';
    const reason = value.trim();
    return draftCharacterCount(reason) <= 500 ? reason : '';
  }
  private isCurrent(draft: TaskDraftSet): boolean {
    if (this.disposed || this.draft !== draft || this.sourceChanged) return false;
    try { return this.ports.isCurrent(draft.source) === true; } catch { return false; }
  }
  private remove(restoreFocus: boolean): void {
    const ownedFocus = this.overlay?.contains(this.document.activeElement) || this.document.activeElement === this.document.body;
    this.overlay?.remove();
    this.overlay = null;
    this.titleField = null; this.descriptionField = null; this.itemSelect = null;
    this.count = null; this.issue = null; this.status = null;
    if (restoreFocus && ownedFocus && this.origin?.isConnected) this.origin.focus();
  }

  private mount(): void {
    const doc = this.document;
    const overlay = doc.createElement('div');
    overlay.dataset.taskDraft = '';
    overlay.tabIndex = -1;
    this.overlay = overlay;
    const dialog = doc.createElement('section');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-label', '任务草稿');
    const header = doc.createElement('header');
    const heading = doc.createElement('h2'); heading.textContent = '任务草稿';
    header.append(heading, this.button('close', '关闭'));
    const introduction = doc.createElement('p');
    introduction.textContent = '逐项核对后复制草稿，再到原任务插件手动填写、保存；不会自动填入标题或说明。打开表单不表示任务已保存。';
    const source = doc.createElement('p');
    source.className = 'sac-task-draft-source';
    source.textContent = this.draft!.source.documentId
      ? `来源文档：${this.draft!.source.documentTitle}` : '来源：已选择的正文（未绑定文档）';
    const listLabel = doc.createElement('label'); listLabel.textContent = this.draft!.extracted ? '待核对的草稿' : '草稿';
    const select = doc.createElement('select'); select.dataset.taskDraftItems = '';
    this.draft!.items.forEach((item, index) => {
      const option = doc.createElement('option'); option.value = String(index); option.textContent = `草稿 ${index + 1}`;
      select.append(option);
    });
    select.value = String(this.selected);
    select.addEventListener('change', () => {
      if (this.overlay !== overlay || this.busy) return;
      const index = Number(select.value);
      if (!Number.isSafeInteger(index) || !this.draft!.items[index]) return;
      this.selected = index;
      this.titleField!.value = this.item().title;
      this.descriptionField!.value = this.item().description;
      this.notice = '';
      this.refresh();
    });
    listLabel.append(select); listLabel.hidden = this.draft!.items.length < 2; this.itemSelect = select;
    const titleLabel = doc.createElement('label'); titleLabel.textContent = '任务标题（单行）';
    const title = doc.createElement('textarea'); title.dataset.taskDraftField = 'title'; title.rows = 2; title.value = this.item().title;
    titleLabel.append(title); this.titleField = title;
    const descriptionLabel = doc.createElement('label'); descriptionLabel.textContent = '说明';
    const description = doc.createElement('textarea'); description.dataset.taskDraftField = 'description'; description.rows = 7; description.value = this.item().description;
    descriptionLabel.append(description); this.descriptionField = description;
    for (const field of [title, description]) field.addEventListener('input', () => {
      if (this.overlay !== overlay || this.busy) return;
      this.item().title = title.value; this.item().description = description.value;
      this.notice = ''; this.refresh();
    });
    const count = doc.createElement('p'); count.className = 'sac-task-draft-count'; this.count = count;
    const issue = doc.createElement('p'); issue.setAttribute('role', 'alert'); this.issue = issue;
    const original = doc.createElement('details');
    const summary = doc.createElement('summary'); summary.textContent = '核对完整原文';
    const pre = doc.createElement('pre'); pre.dataset.taskDraftOriginal = ''; pre.textContent = this.draft!.originalBody;
    original.append(summary, pre);
    const status = doc.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); this.status = status;
    const actions = doc.createElement('footer');
    actions.append(this.button('copy', '复制草稿'), this.button('open-native', '打开任务插件创建'), this.button('prepare-next', '已核对原插件，准备下一次创建'), this.button('associate', '保存后关联已有任务'));
    const prepareHelp = doc.createElement('p'); prepareHelp.dataset.taskDraftPrepareHelp = ''; prepareHelp.className = 'sac-task-draft-help';
    prepareHelp.textContent = '仅在原插件核对过此前入口后，才准备下一次创建。这不证明任务已创建或已保存，也不撤销原任务；准备后仍需另行点击打开。';
    const history = doc.createElement('p'); history.dataset.taskDraftNativeHistory = ''; history.className = 'sac-task-draft-help';
    history.textContent = '此前有一次打开结果未知；继续操作不会把那次结果改称已成功或已取消，请保留核对。';
    const help = doc.createElement('p'); help.className = 'sac-task-draft-help'; help.textContent = '任务保存后，请准确选择那条已有任务。普通文档仅关联为补充资料；不会改变任务主文档、进度或 Work 状态。';
    dialog.append(header, introduction, source, listLabel, titleLabel, descriptionLabel, count, issue, original, status, actions, prepareHelp, history, help);
    overlay.append(dialog);
    overlay.addEventListener('keydown', event => {
      if (this.overlay === overlay) trapDialogKey(event, overlay, !!this.busy, () => this.close());
    });
    doc.body.append(overlay);
    this.refresh();
    title.focus();
  }

  private button(action: string, text: string): HTMLButtonElement {
    const button = this.document.createElement('button');
    button.type = 'button'; button.dataset.taskDraftAction = action; button.textContent = text;
    const overlay = this.overlay;
    button.addEventListener('click', () => {
      if (this.disposed || this.overlay !== overlay || this.busy) return;
      if (action === 'close') this.close();
      else void this.act(action as Exclude<BusyAction, null>);
    });
    return button;
  }

  private async act(action: Exclude<BusyAction, null>): Promise<void> {
    const draft = this.draft!;
    if (action !== 'copy' && !this.isCurrent(draft)) { this.refresh(); return; }
    if (action === 'open-native' && ['opening', 'opened', 'unknown'].includes(this.nativeResult)) return;
    if (action === 'prepare-next' && !['opened', 'unknown'].includes(this.nativeResult)) return;
    const item = { ...this.item() };
    if ((action === 'copy' || action === 'open-native') && taskDraftIssue(item)) { this.refresh(); return; }
    this.busy = action;
    if (action === 'open-native') this.nativeResult = 'opening';
    this.refresh();
    let associationOpened = false;
    try {
      if (action === 'copy') {
        await this.ports.copyText(serializeTaskDraft(item, draft.source));
        if (!this.disposed && this.draft === draft) this.notice = '已复制已核对的草稿，请在原任务插件中粘贴并保存。';
      } else if (action === 'open-native') {
        const result = await this.ports.openNative(draft.source, () => this.isCurrent(draft));
        if (this.disposed || this.draft !== draft) return;
        this.nativeResult = result?.kind === 'opened' ? 'opened' : result?.kind === 'blocked' ? 'blocked' : 'unknown';
        // Only unknown responses carry the host's public guard explanation. A blocked adapter
        // response can contain an external editor exception, so it keeps the fixed safe message.
        this.nativeReason = result?.kind === 'unknown' ? this.publicNativeReason(result.reason) : '';
        if (this.nativeResult === 'unknown') this.nativeHadUnknown = true;
        this.notice = this.nativeResult === 'blocked' ? '未打开任务插件入口，请检查插件及当前文档后再明确点击。草稿已保留。' : '';
      } else if (action === 'prepare-next') {
        const prepared = await this.ports.prepareNext(draft.source, () => this.isCurrent(draft));
        if (this.disposed || this.draft !== draft) return;
        if (prepared === true && this.isCurrent(draft)) {
          this.nativeResult = 'idle';
          this.nativeReason = '';
          this.notice = '已按你的核对准备下一次创建，尚未打开新的入口，也未确认任何任务已保存。';
        } else this.notice = '尚未准备下一次创建，请先核对原插件和当前来源；原打开结果保持。';
      } else {
        await this.ports.associate(draft.source, () => this.isCurrent(draft));
        if (this.disposed || this.draft !== draft) return;
        this.notice = '请在关联界面准确选择已保存的任务；打开关联界面不表示关联完成。';
        associationOpened = true;
      }
    } catch {
      if (this.disposed || this.draft !== draft) return;
      if (action === 'open-native') {
        this.nativeResult = 'unknown';
        this.nativeReason = '';
        this.nativeHadUnknown = true;
        this.notice = '';
      } else if (action === 'prepare-next') {
        this.notice = '尚未确认可准备下一次创建，请先核对原插件；原打开结果保持，未自动重试。';
      } else {
        this.notice = action === 'copy' ? '复制未成功，请检查剪贴板后再复制，草稿已保留。'
          : '关联入口未能确认打开，请先核对原关联界面。草稿已保留，未自动重试。';
      }
    } finally {
      if (!this.disposed && this.draft === draft) {
        this.busy = null;
        if (associationOpened) this.remove(false);
        else this.refresh();
      }
    }
  }
}

export const TASK_DRAFT_CSS = `
[data-task-draft]{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--b3-mask-background,rgba(0,0,0,.35))}
[data-task-draft] section{box-sizing:border-box;min-width:0;width:min(620px,100%);max-height:calc(100dvh - 32px);overflow:auto;padding:20px;border:1px solid var(--b3-border-color);border-radius:12px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);box-shadow:var(--b3-dialog-shadow);font-size:14px;line-height:1.6}
[data-task-draft] header{display:flex;align-items:center;justify-content:space-between;gap:12px}[data-task-draft] h2{font-size:18px;margin:0}[data-task-draft] p{margin:10px 0;overflow-wrap:anywhere}
[data-task-draft] label{display:flex;min-width:0;flex-direction:column;gap:5px;margin:12px 0}[data-task-draft] textarea,[data-task-draft] select{box-sizing:border-box;width:100%;min-width:0;padding:8px;border:1px solid var(--b3-border-color);border-radius:6px;color:inherit;background:var(--b3-theme-surface);font:inherit}[data-task-draft] textarea{resize:vertical;max-height:260px;overflow:auto}
[data-task-draft] button{min-width:0;border:1px solid var(--b3-border-color);border-radius:6px;padding:6px 10px;background:var(--b3-theme-surface);color:inherit;font:inherit;white-space:normal;cursor:pointer}[data-task-draft] button:disabled{opacity:.5;cursor:default}[data-task-draft] button:focus-visible,[data-task-draft] summary:focus-visible{outline:2px solid var(--b3-theme-primary);outline-offset:2px}
[data-task-draft] footer{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}[data-task-draft] [data-task-draft-action=copy]{background:var(--b3-theme-primary);color:var(--b3-theme-on-primary)}[data-task-draft] summary{cursor:pointer}[data-task-draft] pre{margin:8px 0;max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}[data-task-draft] [role=alert]{color:var(--b3-theme-error)}
[data-task-draft] .sac-task-draft-source,[data-task-draft] .sac-task-draft-count,[data-task-draft] .sac-task-draft-help{font-size:12px;color:var(--b3-theme-on-surface)}[data-task-draft] [hidden]{display:none}
@media(max-width:480px),(max-height:480px){[data-task-draft]{padding:8px}[data-task-draft] section{padding:14px;max-height:calc(100dvh - 16px)}[data-task-draft] footer{flex-direction:column}}
`;
