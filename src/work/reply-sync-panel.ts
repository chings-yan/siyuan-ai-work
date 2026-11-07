import type { ChatLink } from './store.ts';
import type { ReplySyncController, ReplySyncRow } from './reply-sync.ts';

function statusText(row: ReplySyncRow): string {
  switch (row.status) {
    case 'baseline-unset': return '未设置已读基线（新回复数量未知）';
    case 'unread': return `新回复 ${row.unreadCount} 条`;
    case 'read': return '本次检查未发现新回复';
    case 'history-changed': return '历史已变化，已读基线待核对（数量未知）';
    case 'unsupported': return '当前关系暂不可核验（数量未知）；可从原会话查看历史';
    case 'error': return '本次检查失败（数量未知）';
    default: return '尚未检查（数量未知）';
  }
}

/** Mounted inside the existing reply-activity tray, not a conversation center. */
export class ReplySyncPanel {
  private readonly box: HTMLDetailsElement;
  private readonly body: HTMLElement;
  private readonly list: HTMLElement;
  private readonly feedback: HTMLElement;
  private readonly time: HTMLElement;
  private readonly note: HTMLElement;
  private readonly auto: HTMLInputElement;
  private readonly checkButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private opening = false;
  private message = '';

  constructor(container: HTMLElement, private readonly port: { controller: ReplySyncController; openTarget: (link: ChatLink) => Promise<void> }) {
    this.box = container.ownerDocument.createElement('details');
    this.box.className = 'sac-reply-sync'; this.box.dataset.replySync = '';
    this.box.innerHTML = '<summary>已关联会话</summary><section class="sac-reply-sync-body" data-reply-sync-body aria-label="已关联会话回复检查">'
      + '<p class="sac-reply-sync-help">仅核验已关联会话的可显示历史；不代表生成已结束。首次检查需明确设置已读基线。</p>'
      + '<div class="sac-reply-sync-controls"><button type="button" data-reply-sync-action="check">检查新回复</button><button type="button" data-reply-sync-action="cancel" hidden>停止检查</button>'
      + '<label><input type="checkbox" data-reply-sync-auto>每分钟自动检查（仅本次启用）</label></div>'
      + '<p data-reply-sync-time></p><p data-reply-sync-note></p><div data-reply-sync-list></div><p data-reply-sync-feedback role="status"></p></section>';
    this.body = this.box.querySelector('[data-reply-sync-body]')!;
    this.list = this.box.querySelector('[data-reply-sync-list]')!;
    this.feedback = this.box.querySelector('[data-reply-sync-feedback]')!;
    this.time = this.box.querySelector('[data-reply-sync-time]')!;
    this.note = this.box.querySelector('[data-reply-sync-note]')!;
    this.auto = this.box.querySelector('[data-reply-sync-auto]')!;
    this.checkButton = this.box.querySelector('[data-reply-sync-action="check"]')!;
    this.cancelButton = this.box.querySelector('[data-reply-sync-action="cancel"]')!;
    this.checkButton.onclick = () => { if (this.disposed) return; this.message = ''; void this.port.controller.check(); };
    this.cancelButton.onclick = () => { if (this.disposed) return; this.message = ''; this.port.controller.cancel(); };
    this.auto.onchange = () => { if (this.disposed) return; this.message = ''; this.port.controller.setAutoCheck(this.auto.checked); };
    container.append(this.box);
    this.unsubscribe = this.port.controller.subscribe(() => this.render());
    this.render();
  }

  render(): void {
    if (this.disposed) return;
    const state = this.port.controller.view(), document = this.box.ownerDocument;
    const focus = document.activeElement as HTMLElement | null;
    const focused = focus && this.list.contains(focus) ? {
      key: focus.closest<HTMLElement>('[data-reply-sync-row]')?.dataset.replySyncRow,
      action: focus.dataset.replySyncAction,
    } : null;
    const scroll = this.body.scrollTop;
    this.auto.checked = state.autoCheck; this.checkButton.disabled = state.checking; this.cancelButton.hidden = !state.checking;
    this.time.textContent = state.lastCheckedAt ? `本次检查时间：${new Date(state.lastCheckedAt).toLocaleString()}` : '尚未完成检查';
    this.note.textContent = [state.unresolvedCount ? `${state.unresolvedCount} 个旧关联来源待核对。` : '',
      state.remainingCount ? `${state.remainingCount} 个会话未纳入本次检查；再次检查会继续。` : ''].filter(Boolean).join(' ');
    this.feedback.textContent = this.opening ? '正在核对原会话…' : this.message || state.feedback;
    const children: HTMLElement[] = [];
    if (!state.rows.length) {
      const empty = document.createElement('p'); empty.textContent = state.lastCheckedAt ? '当前没有可检查的已关联会话。' : '尚未检查已关联会话。'; children.push(empty);
    }
    for (const row of state.rows) {
      const article = document.createElement('article'); article.dataset.replySyncRow = row.key;
      const title = document.createElement('strong'); title.textContent = row.link.title || 'Hermes 对话'; article.append(title);
      const status = document.createElement('small'); status.dataset.replySyncStatus = ''; status.textContent = statusText(row); article.append(status);
      const checked = document.createElement('small'); checked.textContent = row.checkedAt ? `核验时间：${new Date(row.checkedAt).toLocaleString()}` : '尚无可核验结果'; article.append(checked);
      if (row.error) { const error = document.createElement('p'); error.className = 'sac-reply-sync-error'; error.textContent = row.error; article.append(error); }
      const actions = document.createElement('div'); actions.className = 'sac-reply-sync-actions';
      const open = document.createElement('button'); open.type = 'button'; open.dataset.replySyncAction = 'open';
      open.textContent = '打开原会话'; open.disabled = this.opening || !row.canOpen;
      open.onclick = () => { if (this.live(row, open)) void this.open(row); }; actions.append(open);
      if (row.canMarkRead) {
        const ack = document.createElement('button'); ack.type = 'button'; ack.dataset.replySyncAction = 'ack'; ack.textContent = '标记当前检查已读';
        ack.onclick = () => { if (!this.live(row, ack)) return; this.message = ''; void this.port.controller.markRead(row.key, row.revision); };
        actions.append(ack);
      }
      article.append(actions); children.push(article);
    }
    this.list.replaceChildren(...children); this.body.scrollTop = scroll;
    if (focused) {
      const article = [...this.list.querySelectorAll<HTMLElement>('[data-reply-sync-row]')].find(item => item.dataset.replySyncRow === focused.key);
      const action = focused.action === 'ack' ? 'ack' : 'open';
      const button = article?.querySelector<HTMLButtonElement>(`[data-reply-sync-action="${action}"]`);
      (button && !button.disabled ? button : this.box.querySelector<HTMLElement>('summary'))?.focus({ preventScroll: true });
    }
  }

  private live(row: ReplySyncRow, button: HTMLButtonElement): boolean {
    return !this.disposed && this.list.contains(button) && !button.disabled
      && this.port.controller.view().rows.some(current => current.key === row.key && current.revision === row.revision && current.canOpen);
  }

  private async open(row: ReplySyncRow): Promise<void> {
    if (this.disposed || this.opening) return;
    this.opening = true; this.message = ''; this.render();
    try {
      await this.port.openTarget(structuredClone(row.link));
      if (!this.disposed) this.message = '已打开原会话；查看完成后可标记当前检查已读。';
    } catch (error) {
      if (!this.disposed) this.message = error instanceof Error ? error.message : '原会话暂不能打开，请核对后重试。';
    } finally { this.opening = false; this.render(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe(); this.box.remove();
  }
}

export const REPLY_SYNC_CSS = `
.sac .sac-reply-sync{min-width:0;margin-top:10px;border-top:1px solid var(--b3-border-color,#ddd);padding-top:6px}
.sac .sac-reply-sync>summary{cursor:pointer;padding:4px 0;font-weight:600}
.sac .sac-reply-sync-body{min-width:0;max-height:min(260px,45vh);overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere;padding:0 3px 4px 0}
.sac .sac-reply-sync p{margin:6px 0}
.sac .sac-reply-sync-help,.sac [data-reply-sync-time],.sac [data-reply-sync-note]{font-size:12px;color:var(--b3-theme-on-surface,#666)}
.sac .sac-reply-sync-controls,.sac .sac-reply-sync-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.sac .sac-reply-sync-controls label{display:flex;gap:5px;align-items:flex-start;flex-basis:100%;min-width:0;white-space:normal}
.sac .sac-reply-sync-controls input{flex:0 0 auto;margin-top:4px}
.sac .sac-reply-sync button{max-width:100%;padding:4px 7px;font-size:12px;white-space:normal}
.sac [data-reply-sync-list] article{padding:8px 0;border-bottom:1px solid var(--b3-border-color,#ddd)}
.sac [data-reply-sync-list] strong,.sac [data-reply-sync-list] small{display:block;overflow-wrap:anywhere}
.sac .sac-reply-sync-actions{margin-top:5px}
.sac [data-reply-sync-note]:empty,.sac [data-reply-sync-feedback]:empty{display:none}
`;
