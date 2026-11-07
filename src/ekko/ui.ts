import { MessageRenderer, markdownMarkup, escapeMessage } from '../message-renderer.ts';
import { bindComposerResize, mentionQueryAtCursor, mentionKeyAction, clampMentionIndex, type MentionMatch } from '../ui.ts';
import { assertRoomSendCurrent, prepareRoomSend, type RoomReply, type SelectedRoomAgent, type SelectedRoomSource } from './context.ts';
import { BridgeError } from '../bridge.ts';
import type { EkkoAgent, EkkoBridgeClient, EkkoConnection, EkkoMessage, EkkoRoom } from './bridge.ts';
import type { LoadedContext } from '../work/context.ts';
import { sameRoomScope, roomScopeFields, roomScopeKey, validRoomScope, type RoomScope, type RoomLink, type RoomLinkStore } from '../work/room-store.ts';
import type { PendingRoomSendStore } from './pending.ts';
import { roomMessageView, type RoomMessageView } from './presentation.ts';
import { isOwnRoomMessage, projectRoomContent, roomQuoteExcerpt } from './message-content.ts';

export type RoomSourceOption = { label: string; source: SelectedRoomSource };
export type RoomAnswerSource = { link: RoomLink; documentId: string; messageId: string; senderId: string; content: string };
export type EkkoRoomUIOptions = {
  drafts?: Map<string, RoomDraft>;
  isCurrent?: () => boolean;
  getSceneIdentity?: () => string;
  /** Stable host connection identity, independent of document navigation. Memory only. */
  getBridgeIdentity?: () => string;
  onChanged?: () => void;
  onOpenLink?: (link: RoomLink) => Promise<void>;
  onAnswerAction?: (action: 'adopt' | 'task-draft', source: RoomAnswerSource, isCurrent: () => boolean) => Promise<void>;
  openConnectionSettings?: () => void;
  client: () => Pick<EkkoBridgeClient, 'connection' | 'pair' | 'rooms' | 'room' | 'events' | 'send' | 'sendStatus'>;
  store: Pick<RoomLinkStore, 'listForWork' | 'linkRoom' | 'unlinkRoom' | 'assertLinked'> & Partial<Pick<RoomLinkStore, 'listForDocument'>>;
  pendingStore: Pick<PendingRoomSendStore, 'get' | 'remember' | 'clear'>;
  getWorkId: () => string | null;
  getDocumentRootId: () => string;
  availableSources: (workId: string | null) => Promise<RoomSourceOption[]>;
  loadSource: (source: SelectedRoomSource) => Promise<LoadedContext>;
};

type SentReceipt = Readonly<{ clientMessageId: string; messageId?: string; roomId: string; senderId: string; content: string; timestamp: string }>;
type RenderedRoomMessage = RoomMessageView & { acknowledged?: true };
const validMessageId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
const receiptMatches = (item: EkkoMessage, receipt: SentReceipt) => !item.isStreaming &&
  (item.id === receipt.clientMessageId || item.id === receipt.messageId) && item.roomId === receipt.roomId &&
  item.senderId === receipt.senderId && item.content === receipt.content;

type HistoryGap = { before?: string; newestAnchor: string | null; cursors: Set<string> };
type HistoryProgress = { historyAnchor?: string | null; olderHasMore: boolean; gap?: HistoryGap };
type RoomPage = Awaited<ReturnType<EkkoBridgeClient['room']>>;
type LoadedRoom = { result: RoomPage; sources: RoomSourceOption[]; pending: Awaited<ReturnType<EkkoRoomUIOptions['pendingStore']['get']>> };
type RoomMentionPicker = { active: ActiveRoom; version: number; textarea: HTMLTextAreaElement; value: string; start: number; end: number; query: MentionMatch | null; index: number; candidates: SelectedRoomAgent[] };
type ActiveRoom = HistoryProgress & { historyLoading?: boolean; workId: string | null; documentRootId: string; link: RoomLink; room: EkkoRoom; agents: EkkoAgent[]; sources: RoomSourceOption[]; hasMore: boolean };
export type RoomDraft = { reply?: RoomReply; text: string; selectedSources: SelectedRoomSource[]; selectedAgents: SelectedRoomAgent[]; unknownId?: string; composerHeight?: number };
const identity = (connection: EkkoConnection) => ({ connectionId: connection.id, deviceId: connection.deviceId, accountUserId: connection.accountUserId });
const sameIdentity = (link: RoomLink, connection: EkkoConnection) =>
  link.connectionId === connection.id && link.deviceId === connection.deviceId && link.accountUserId === connection.accountUserId;
const keyOf = (_workId: string | null, link: RoomLink) => `${roomScopeKey(link)}\u0000${link.connectionId}\u0000${link.deviceId}\u0000${link.accountUserId}\u0000${link.roomId}`;
const sameLink = (left: RoomLink, right: RoomLink) => sameRoomScope(left, right) &&
  left.connectionId === right.connectionId && left.deviceId === right.deviceId &&
  left.accountUserId === right.accountUserId && left.roomId === right.roomId;
const messageTime = (value: unknown): { short: string; full: string } | undefined => {
  const date = new Date(typeof value === 'number' ? value : String(value ?? ''));
  if (Number.isNaN(date.getTime())) return;
  return { short: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`, full: date.toISOString() };
};
/** Summary only: every expanded original, copy source and frozen send stays untouched. */
const quoteSummary = (content: string, label?: string): string => {
  const lines = content.split(/\r?\n/);
  if (label && lines[0] === `【${label}】`) lines.shift();
  return roomQuoteExcerpt(lines.filter(line => !/^[ \t]*(?:<|&lt;)\/?quoted_message(?:>|&gt;)[ \t]*$/.test(line)).join('\n'));
};
const connectionStateText = (state: string) => ({
  expired: 'EKKO 应用连接已到期，请重新配对同一账号',
  identity_changed: 'EKKO 设备或账号身份已变化，原房间关系保持但不可发言',
  access_denied: 'EKKO 拒绝当前账号访问；请检查应用连接是否撤销或账号状态',
  unavailable: 'EKKO 服务暂不可用；请检查本机服务',
} as Record<string, string>)[state] ?? 'EKKO 尚未连接';
const errorText = (error: unknown) => {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'access_denied') return '当前账号没有该房间权限';
  if (code === 'identity_changed') return connectionStateText('identity_changed');
  if (code === 'room_not_found') return '房间不存在或当前账号不可见';
  if (code === 'socket_auth_or_connect_failed') return '房间实时连接认证失败';
  return error instanceof Error ? error.message : '房间暂不可用，请检查 EKKO 连接';
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const definiteRejection = (error: unknown) => error instanceof BridgeError && error.status >= 400 && error.status < 500 &&
  error.status !== 408 && error.status !== 409 && error.status !== 429;

function button(doc: Document, label: string, action: string, id?: string): HTMLButtonElement {
  const item = doc.createElement('button');
  item.type = 'button'; item.textContent = label; item.dataset.ekkoAction = action;
  if (id) item.dataset.ekkoId = id;
  return item;
}
function text(doc: Document, tag: string, value: string, className?: string): HTMLElement {
  const item = doc.createElement(tag);
  item.textContent = value;
  if (className) item.className = className;
  return item;
}
function mergeMessages(previous: EkkoMessage[], incoming: EkkoMessage[]): EkkoMessage[] {
  const byId = new Map(previous.filter(item => item?.id).map(item => [item.id, item]));
  for (const item of incoming) if (item?.id) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => {
    const left = new Date(a.timestamp ?? 0).getTime();
    const right = new Date(b.timestamp ?? 0).getTime();
    return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
  });
}

/** Owns only the EKKO panel. Hermes Chat's composer and history stay independent. */
export class EkkoRoomUI {
  private readonly panel: HTMLElement;
  private readonly drafts: Map<string, RoomDraft>;
  private readonly histories = new Map<string, EkkoMessage[]>();
  private readonly sentReceipts = new Map<string, Map<string, SentReceipt>>();
  private readonly historyProgress = new Map<string, HistoryProgress>();
  private links: RoomLink[] = [];
  private rooms: EkkoRoom[] = [];
  private roomHasMore = false;
  private roomOffset = 0;
  private connection: EkkoConnection | null = null;
  private online = false;
  private active: ActiveRoom | null = null;
  private openedDocumentRootId = '';
  private version = 0;
  private sceneDocumentRootId = '';
  private sceneIdentity = '';
  private sceneBridgeIdentity?: string;
  private refreshing?: { version: number; scene: string; bridge: string | undefined; failed?: boolean };
  private scope(): RoomScope { const workId=this.options.getWorkId(); return workId === null ? {workId:null,documentRootId:this.options.getDocumentRootId()} : {workId}; }
  private listLinks(scope: RoomScope): Promise<RoomLink[]> {
    if(scope.workId !== null) return this.options.store.listForWork(scope.workId);
    if(!validRoomScope(scope)) throw new Error('请先打开一个思源文档');
    if(!this.options.store.listForDocument) throw new Error('文档房间读取接口不可用');
    return this.options.store.listForDocument(scope.documentRootId);
  }
  private captureScene(): void { this.sceneDocumentRootId=this.options.getDocumentRootId();this.sceneIdentity=this.options.getSceneIdentity?.() ?? '';this.sceneBridgeIdentity=this.options.getBridgeIdentity?.(); }
  private eventAbort?: AbortController;
  private readonly streamActivity = new Set<string>();
  private sending = new Map<string, 'preparing' | 'submitting' | 'confirmed'>();
  private status = '';
  private disposed = false;
  private readonly listeners: AbortController;
  private resizeCleanup?: () => void;
  private mentionPicker?: RoomMentionPicker;

  constructor(private readonly root: HTMLElement, public readonly options: EkkoRoomUIOptions) {
    const panel = root.querySelector<HTMLElement>('[data-ekko-panel]');
    if (!panel) throw new Error('EKKO 房间面板不存在');
    this.panel = panel;
    this.listeners=new (root.ownerDocument.defaultView as any).AbortController();
    const events={signal:this.listeners.signal};
    this.drafts = options.drafts ?? new Map();
    root.dataset.surface = 'chat';
    root.querySelector<HTMLButtonElement>('[data-action="open-ekko"]')?.addEventListener('click', () => void this.enter(),events);
    root.querySelector<HTMLButtonElement>('[data-action="open-chat"]')?.addEventListener('click', () => this.leave(),events);
    this.panel.addEventListener('click', event => void this.onClick(event),events);
    this.panel.addEventListener('submit', event => void this.onSubmit(event),events);
    this.panel.addEventListener('input', event => this.onInput(event),events);
    this.panel.addEventListener('change', event => this.onChange(event),events);
    this.panel.addEventListener('keydown', event => this.onMentionKey(event),events);
    this.panel.addEventListener('click', event => {
      if ((event.target as Element).matches('[data-ekko-composer]')) this.updateMentionQuery();
    },events);
    this.panel.addEventListener('keyup', event => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && (event.target as Element).matches('[data-ekko-composer]')) this.updateMentionQuery();
    },events);
    this.panel.addEventListener('compositionend', () => this.updateMentionQuery(),events);
    root.ownerDocument.addEventListener('pointerdown', event => {
      if (!(event.target as Element).closest('[data-ekko-send-form], [data-ekko-mention-list]')) this.closeMentionPicker();
    },events);
    this.panel.addEventListener('focusout', event => {
      const next = event.relatedTarget as Node | null;
      if (!this.panel.querySelector('[data-ekko-send-form]')?.contains(next) &&
          !this.panel.querySelector('[data-ekko-mention-list]')?.contains(next)) this.closeMentionPicker();
    },events);
  }

  get activeLink(): RoomLink | null { return this.active?.link || null; }
  get isSending(): boolean { return this.sending.size>0; }
  /** Explicit, freshly read search material uses the same room source boundary as the composer. */
  async addReferenceSource(option: RoomSourceOption, isCurrent: () => boolean): Promise<void> {
    const active=this.active,version=this.version;
    if(!active||!isCurrent()||!this.allowRoomInteraction())throw Error('当前房间状态待核对，资料尚未加入');
    const source=option.source;
    if(source.kind!=='selection'||!/^\d{14}-[a-z0-9]{7}$/.test(source.documentId)||!/^\d{14}-[a-z0-9]{7}$/.test(source.blockId)||
       !source.selectedText.trim()||!source.originalBlock.includes(source.selectedText))throw Error('检索引用的准确原文尚未核实');
    const available=await this.options.availableSources(active.workId);
    if(!isCurrent()||!this.stillCurrent(version,active)||!this.allowRoomInteraction())throw Error('页面或房间已变化，资料尚未加入');
    if((active.workId===null&&source.documentId!==active.documentRootId)||!available.some(item=>item.source.kind==='document'&&item.source.documentId===source.documentId))throw Error('这篇文档不在当前房间的可选资料范围；请先明确关联到当前 Work');
    this.saveVisibleDraft();
    const draft=this.draft();if(!draft.selectedSources.some(item=>same(item,source)))draft.selectedSources.push({...source});
    if(!active.sources.some(item=>same(item.source,source)))active.sources.push({label:option.label,source:{...source}});
    this.render();
  }
  private retainSelectedSources(sources: RoomSourceOption[], draft: RoomDraft): RoomSourceOption[] {
    const result=[...sources];
    for(const source of draft.selectedSources)if(source.kind==='selection'&&sources.some(item=>item.source.kind==='document'&&item.source.documentId===source.documentId)&&!result.some(item=>same(item.source,source)))result.push({label:'已选精确引用',source:{...source}});
    return result;
  }
  connectionChanged(): void { this.rejectIdentity({code:'identity_changed'}); }
  /** Only guarded ownership preparation may retain the original room or inactive management scene. */
  retainActiveRoomAfterScopePreparation(expectedLink: RoomLink | null, documentRootId: string): void {
    const active=this.active;
    if (this.refreshing?.version === this.version) { this.renderComposerState(); return; }
    if(this.disposed || !(this.options.isCurrent?.() ?? true) || this.isSending || this.activeLink!==expectedLink ||
       (active ? active.documentRootId : this.sceneDocumentRootId)!==documentRootId || this.options.getDocumentRootId()!==documentRootId ||
       (active && this.options.getWorkId()!==active.workId) || this.root.dataset.surface!=='ekko')return;
    this.saveVisibleDraft();this.stopEvents();const version=++this.version;this.captureScene();
    if(active && this.online && this.connection && sameIdentity(active.link,this.connection))this.watch(active,version);
  }
  private currentKey() { return this.active ? keyOf(this.active.workId, this.active.link) : ''; }
  private draft(key = this.currentKey()): RoomDraft {
    let value = this.drafts.get(key);
    if (!value) { value = { text: '', selectedSources: [], selectedAgents: [] }; this.drafts.set(key, value); }
    return value;
  }
  private stillCurrent(version: number, active?: ActiveRoom): boolean {
    return !this.disposed && (this.options.isCurrent?.() ?? true) && this.root.dataset.surface === 'ekko' && this.version === version && this.options.getDocumentRootId() === this.sceneDocumentRootId &&
      (this.options.getSceneIdentity?.() ?? '') === this.sceneIdentity && this.options.getBridgeIdentity?.() === this.sceneBridgeIdentity &&
      (!active || this.active === active && this.options.getWorkId() === active.workId && this.options.getDocumentRootId() === active.documentRootId);
  }
  private renderComposerState(): void {
    const active = this.active;
    if (!active || this.disposed || !this.root.isConnected || !(this.options.isCurrent?.() ?? true) ||
      this.root.dataset.surface !== 'ekko' || this.options.getWorkId() !== active.workId ||
      this.options.getDocumentRootId() !== active.documentRootId) return;
    const state = this.panel.querySelector<HTMLElement>('[data-ekko-composer-state]');
    if (!state) return;
    const stage = this.sending.get(this.currentKey());
    const failed = this.refreshing?.version === this.version && this.refreshing.failed;
    const stale = !this.stillCurrent(this.version, active) || failed;
    const unknown = !!this.draft().unknownId;
    const refreshing = this.refreshing?.version === this.version && !failed;
    state.querySelector<HTMLElement>('[data-ekko-composer-state-text]')!.textContent =
      (refreshing ? '正在刷新房间状态，请等待；草稿保留。' : stage === 'preparing' ? '正在准备发送并核对资料，请等待；不要重复发送。' :
        stage === 'submitting' ? '正在提交消息，等待发送结果；请勿重复发送。' :
        stage === 'confirmed' ? '发送已确认，正在更新本地状态和房间历史；请等待。' :
        unknown ? '上一条发送待核对；请先核对上一条发送状态，不能直接重复发送。' : '') +
      (stale ? '页面状态已变化，请刷新房间状态后再操作；草稿保留。' : '');
    const refresh = state.querySelector<HTMLButtonElement>('[data-ekko-action="refresh"]')!;
    refresh.hidden = !stale; refresh.disabled = !!stage || refreshing;
    state.hidden = !stage && !stale && !unknown && !refreshing;
  }
  private allowRoomInteraction(allowBusy = false): boolean {
    const active = this.active;
    const allowed = !!active && this.refreshing?.version !== this.version && this.stillCurrent(this.version, active) &&
      (allowBusy || !this.sending.has(this.currentKey()) && !this.draft().unknownId);
    if (!allowed) { this.closeMentionPicker(); this.renderComposerState(); }
    return allowed;
  }
  private rememberHistory(active: ActiveRoom): void {
    active.hasMore = active.gap ? Boolean(active.gap.before) : active.olderHasMore;
    this.historyProgress.set(keyOf(active.workId, active.link), {
      historyAnchor: active.historyAnchor, olderHasMore: active.olderHasMore, gap: active.gap,
    });
  }
  private renderStreamActivity(): void {
    const stream = this.panel.querySelector<HTMLElement>('[data-ekko-stream]');
    if (stream) stream.textContent = this.streamActivity.size ? '机器人正在回复…' : '';
  }
  private clearStreamActivity(): void { this.streamActivity.clear(); this.renderStreamActivity(); }
  private stopEvents(): void { this.closeMentionPicker(); this.eventAbort?.abort(); this.eventAbort = undefined; this.clearStreamActivity(); }
  private rejectIdentity(error: unknown): boolean {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'identity_changed')) return false;
    this.saveVisibleDraft(); this.version++; this.stopEvents();
    // Pending send metadata and its original draft remain visible but disabled for review.
    if (!this.active || !this.draft().unknownId) this.active = null;
    this.connection = null; this.online = false; this.rooms = []; this.roomHasMore = false;
    this.openedDocumentRootId = ''; this.status = 'EKKO 账号身份已变化，请刷新并核对新账号；原房间关系保留';
    this.render(); return true;
  }
  showScopePreparationError(value: string): void { if(this.stillCurrent(this.version))this.setStatus(value); }
  private setStatus(value: string): void {
    this.status = value;
    const line = this.panel.querySelector<HTMLElement>('[data-ekko-status]');
    if (line) line.textContent = value;
  }

  async enter(): Promise<void> {
    if (this.disposed) return;
    this.root.dataset.surface = 'ekko';
    this.panel.hidden = false;
    this.root.querySelector('[data-action="open-ekko"]')?.setAttribute('aria-current', 'page');
    this.root.querySelector('[data-action="open-chat"]')?.removeAttribute('aria-current');
    this.options.onChanged?.();
    await this.refresh();
  }
  leave(): void {
    this.resizeCleanup?.();this.resizeCleanup=undefined;
    this.saveVisibleDraft();
    this.version++;
    this.stopEvents();
    this.root.dataset.surface = 'chat';
    this.panel.hidden = true;
    this.root.querySelector('[data-action="open-ekko"]')?.removeAttribute('aria-current');
    this.root.querySelector('[data-action="open-chat"]')?.setAttribute('aria-current', 'page');
    this.options.onChanged?.();
  }
  dispose(): void { if(this.disposed)return;this.leave(); this.disposed = true;this.sentReceipts.clear();this.replyPreview=undefined;this.listeners.abort();this.messageRenderer?.dispose(); this.panel.replaceChildren(); }

  async workChanged(): Promise<void> {
    this.saveVisibleDraft();
    this.version++;
    this.stopEvents();
    this.active = null;
    this.openedDocumentRootId = '';
    if (this.root.dataset.surface === 'ekko') await this.refresh();
  }
  async documentChanged(): Promise<void> {
    if (this.sceneDocumentRootId !== this.options.getDocumentRootId() || this.active && this.active.workId !== this.options.getWorkId()) await this.workChanged();
    else if ((this.options.getSceneIdentity?.() ?? '') !== this.sceneIdentity || this.options.getBridgeIdentity?.() !== this.sceneBridgeIdentity) {
      const bridge = this.options.getBridgeIdentity?.();
      if (bridge && bridge === this.sceneBridgeIdentity) await this.refresh();
      else this.renderComposerState();
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed || !(this.options.isCurrent?.() ?? true) || this.root.dataset.surface !== 'ekko') return;
    // A refresh cannot replace the input frozen by an in-flight send. Its outcome
    // still belongs to the original room; a stale page can be reread afterwards.
    if (this.active && this.sending.has(this.currentKey())) { this.renderComposerState(); return; }
    const scene = this.options.getSceneIdentity?.() ?? '';
    const bridge = this.options.getBridgeIdentity?.();
    if (!this.refreshing?.failed && this.refreshing?.version === this.version && this.refreshing.scene === scene && this.refreshing.bridge === bridge) return;
    this.saveVisibleDraft();
    this.stopEvents();
    if(this.active && (this.active.documentRootId!==this.options.getDocumentRootId() || this.active.workId!==this.options.getWorkId())) {this.active=null;this.openedDocumentRootId='';}
    const original = this.active;
    const reopenLink = original?.link;
    const version = ++this.version;
    const documentRootId = this.options.getDocumentRootId();
    const workId = this.options.getWorkId();
    // Do not adopt a new scene marker until the original relationship and
    // connection have been reread. Late results cannot certify a newer scene.
    const current = () => !this.disposed && (this.options.isCurrent?.() ?? true) && this.root.dataset.surface === 'ekko' &&
      this.version === version && this.active === original && this.options.getWorkId() === workId &&
      this.options.getDocumentRootId() === documentRootId && (this.options.getSceneIdentity?.() ?? '') === scene && this.options.getBridgeIdentity?.() === bridge;
    this.refreshing = { version, scene, bridge };
    this.renderComposerState();
    let readingOriginalRoom = false;
    try {
      let links: RoomLink[];
      try { links = await this.listLinks(this.scope()); }
      catch (error) { if (current()) { this.setStatus(`刷新房间状态失败：${errorText(error)}；草稿保留，请重新刷新`); this.renderComposerState(); } return; }
      if (!current()) return;
      try {
        const result = await this.options.client().connection();
        if (!current()) return;
        const online = Boolean(result.connection && result.connection.state === 'connected');
        const exactRoom = !reopenLink || online && result.connection && sameIdentity(reopenLink, result.connection) &&
          links.some(link => sameLink(link, reopenLink));
        const firstPage = online ? await this.options.client().rooms({ offset: 0, limit: 50 }, identity(result.connection!)) : null;
        if (!current()) return;
        let loaded: LoadedRoom | undefined;
        if (reopenLink && exactRoom) {
          readingOriginalRoom = true;
          loaded = await this.readRoom(reopenLink, documentRootId, current);
          if (!current() || !loaded) return;
        }
        // The same original room still owns this input. Preserve edits made
        // during any readonly await before replacing its DOM, never a new view.
        this.saveVisibleDraft(true);
        this.links = links; this.connection = result.connection; this.online = online;
        this.rooms = firstPage?.rooms ?? [];
        this.roomOffset = firstPage?.rooms.length ?? 0; this.roomHasMore = firstPage?.hasMore ?? false;
        if (!exactRoom) { this.active = null; this.openedDocumentRootId = ''; }
        this.captureScene();
        this.status = !exactRoom ? '原房间关联或连接身份已变化；原草稿保留，请核对后重新打开房间' :
          online ? '' : `${connectionStateText(result.connection?.state ?? '')}；本地房间关联保留`;
        this.refreshing = undefined;
        if (reopenLink && loaded) await this.activateRoom(reopenLink, documentRootId, loaded, version);
        else this.render();
      } catch (error) {
        if (!current()) return;
        if (this.rejectIdentity(error)) return;
        let relationshipError = '';
        if (original && readingOriginalRoom) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
          let changed = ['room_link_changed', 'room_not_found', 'access_denied'].includes(code);
          // A failed late read is not proof of a changed relationship. Reread
          // that authority before deciding whether the original room can remain.
          if (!changed) {
            try {
              const latestLinks = await this.listLinks(roomScopeFields(original.link));
              if (!current()) return;
              changed = !latestLinks.some(link => sameLink(link, original.link));
              if (changed) this.links = latestLinks;
            } catch (checkError) {
              if (!current()) return;
              relationshipError = `；房间关联复核未完成：${errorText(checkError)}`;
            }
          }
          if (changed) {
            this.saveVisibleDraft(true); this.active = null; this.openedDocumentRootId = ''; this.captureScene();
            this.status = '原房间关联或访问身份已变化；原草稿保留，请核对后重新打开房间';
            this.render(); return;
          }
        }
        // Keep the original input and pending controls until a complete read
        // succeeds. The failed version remains guarded even on a manual refresh
        // whose scene marker did not change; an explicit readonly retry is safe.
        if (original && (readingOriginalRoom || scene !== this.sceneIdentity || bridge !== this.sceneBridgeIdentity)) {
          this.saveVisibleDraft(true);
          if (this.refreshing?.version === version) this.refreshing.failed = true;
          this.setStatus(`刷新房间状态失败：${errorText(error)}${relationshipError}；草稿保留，请重新刷新`); this.renderComposerState(); return;
        }
        this.online = false; this.rooms = []; this.roomOffset = 0; this.roomHasMore = false;
        this.active = null; this.openedDocumentRootId = ''; this.captureScene();
        this.status = `EKKO 暂不可用：${errorText(error)}；本地房间关联保留`;
        this.render();
      }
    } finally {
      if (this.refreshing?.version === version && !this.refreshing.failed) this.refreshing = undefined;
      if (current()) this.renderComposerState();
    }
  }

  async loadMoreRooms(): Promise<void> {
    if (!this.online || !this.roomHasMore) return;
    const version = this.version;
    const workId = this.options.getWorkId();
    try {
      const page = await this.options.client().rooms({ offset: this.roomOffset, limit: 50 }, identity(this.connection!));
      if (!this.stillCurrent(version) || this.options.getWorkId() !== workId) return;
      if (page.hasMore && page.rooms.length === 0) throw new Error('房间分页未前进，已停止加载');
      const known = new Set(this.rooms.map(item => item.id));
      this.rooms.push(...page.rooms.filter(item => !known.has(item.id)));
      this.roomOffset += page.rooms.length;
      this.roomHasMore = page.hasMore;
      this.saveVisibleDraft(); this.render();
    } catch (error) { if (this.stillCurrent(version) && !this.rejectIdentity(error)) this.setStatus(`读取更多房间失败：${errorText(error)}`); }
  }

  async pair(input: { baseUrl: string; username: string; password: string }): Promise<void> {
    if(!(this.options.isCurrent?.() ?? true)){this.setStatus('页面或连接已切换，请重新打开连接设置');return;}
    const version = this.version;
    try {
      const result = await this.options.client().pair(input);
      if (!this.stillCurrent(version)) return;
      if (!result.connection) throw new Error('未取得可核对的 EKKO 账号');
      this.connection = result.connection;
      this.online = result.connection.state === 'connected';
      await this.refresh();
      if (this.stillCurrent(this.version)) this.setStatus(`已核对 EKKO 账号：${result.connection.accountName}`);
    } catch (error) {
      if (this.stillCurrent(version)) this.setStatus(`配对结果未确认：${errorText(error)}。请先到 EKKO 核对应用连接，不要直接重复提交。`);
    }
  }

  async linkRoom(roomId: string): Promise<void> {
    if(!this.stillCurrent(this.version)){this.setStatus('页面、文档或连接已切换，请重新打开关联');return;}
    const workId = this.options.getWorkId();
    const connection = this.connection;
    const room = this.rooms.find(item => item.id === roomId);
    const scope=this.scope();
    if (!validRoomScope(scope) || !connection || !this.online || !room) { this.setStatus('请先打开文档、连接 EKKO 并选择有权访问的房间'); return; }
    const version = this.version;
    try {
      await this.options.store.linkRoom({ ...roomScopeFields(scope), ...identity(connection), roomId, roomNameAtLink: room.name });
      if (!this.stillCurrent(version) || this.options.getWorkId() !== workId) return;
      const links = await this.listLinks(scope);
      if(!this.stillCurrent(version))return;this.links=links;
      if (this.stillCurrent(version) && this.options.getWorkId() === workId) { this.render(); this.setStatus(`已将 ${room.name} 关联到${workId ? '所选 Work' : '当前文档'}；点击打开才切换会话`); this.options.onChanged?.(); }
    } catch (error) { if (this.stillCurrent(version)) this.setStatus(`关联失败：${errorText(error)}`); }
  }

  async unlinkRoom(link: RoomLink): Promise<void> {
    if (!this.stillCurrent(this.version)) { this.setStatus('页面、Work 或连接已变化，请重新打开房间管理后取消关联'); return; }
    if (!sameRoomScope(this.scope(),link) || !this.links.some(item => sameLink(item, link))) return;
    const version = this.version;
    let visibleVersion = version;
    try {
      await this.options.store.unlinkRoom(link);
      if (!this.stillCurrent(version)) return;
      if (this.active && sameLink(this.active.link, link)) { this.stopEvents(); this.active = null; visibleVersion = ++this.version; }
      const links = await this.listLinks(link);
      if(!this.stillCurrent(visibleVersion))return;this.links=links;
      if (!this.stillCurrent(visibleVersion) || this.options.getWorkId() !== link.workId) return;
      this.render(); this.setStatus(`已从${link.workId === null ? '当前文档' : '当前 Work '}取消房间关联；EKKO 房间未删除`);
    } catch (error) { if (this.stillCurrent(visibleVersion)) this.setStatus(`取消关联结果需核对：${errorText(error)}`); }
  }

  async openRoom(roomId: string, expectedLink?: RoomLink): Promise<void> {
    if(!this.stillCurrent(this.version))return;
    const workId = this.options.getWorkId();
    const documentRootId = this.options.getDocumentRootId();
    const connection = this.connection;
    const link = this.links.find(item => item.roomId === roomId && sameRoomScope(item,this.scope()) && connection && sameIdentity(item, connection));
    if (!validRoomScope(this.scope()) || !connection || !this.online || !link || (expectedLink && !sameLink(link, expectedLink))) { this.setStatus('房间关联与当前账号不一致，或 EKKO 暂不可用'); return; }
    this.saveVisibleDraft();
    this.stopEvents();
    this.active = null;
    const version = ++this.version;
    this.captureScene();
    this.render();
    const loadingStatus = '正在读取房间历史和可选资料…';
    this.setStatus(loadingStatus);
    try {
      const current = () => this.stillCurrent(version) && this.options.getWorkId() === workId && this.options.getDocumentRootId() === documentRootId;
      const loaded = await this.readRoom(link, documentRootId, current);
      if (!current() || !loaded) return;
      if (this.status === loadingStatus) this.status = '';
      await this.activateRoom(link, documentRootId, loaded, version);
    } catch (error) { if (this.stillCurrent(version) && !this.rejectIdentity(error)) { this.render(); this.setStatus(`无法进入房间：${errorText(error)}`); } }
  }

  /** One readonly verification order for explicit open and same-room recovery. */
  private async readRoom(link: RoomLink, documentRootId: string, current: () => boolean): Promise<LoadedRoom | undefined> {
    const expected = { connectionId: link.connectionId, deviceId: link.deviceId, accountUserId: link.accountUserId };
    const checked = await this.options.store.assertLinked(link.workId, expected, link.roomId, documentRootId);
    if (!current()) return;
    if (!sameLink(checked, link)) throw Object.assign(new Error('原房间关联已变化'), { code: 'room_link_changed' });
    const result = await this.options.client().room(link.roomId, { limit: 100 }, link);
    if (!current()) return;
    const sources = await this.options.availableSources(link.workId);
    if (!current()) return;
    const pending = await this.options.pendingStore.get(link);
    if (!current()) return;
    return { result, sources, pending };
  }

  private async activateRoom(link: RoomLink, documentRootId: string, loaded: LoadedRoom, version: number): Promise<void> {
    const { result, sources, pending } = loaded;
    const workId = link.workId;
    const key = keyOf(workId, link);
    const previous = this.historyProgress.get(key);
    const progress: HistoryProgress = previous ? { ...previous, gap: previous.gap ? { ...previous.gap, cursors: new Set(previous.gap.cursors) } : undefined } : {
      historyAnchor: mergeMessages([], result.messages).at(-1)?.id ?? (result.hasMore ? undefined : null), olderHasMore: result.hasMore,
    };
    const active: ActiveRoom = { workId, documentRootId, link, room: result.room, agents: result.agents, sources:this.retainSelectedSources(sources,this.draft(key)), hasMore: result.hasMore, ...progress };
    this.active = active;
    this.options.onChanged?.();
    if (!this.stillCurrent(version, active)) return;
    this.openedDocumentRootId = documentRootId;
    this.rememberHistory(active);
    if (pending) this.draft(key).unknownId = pending.clientMessageId;
    this.histories.set(key, mergeMessages(this.histories.get(key) ?? [], result.messages));
    this.render();
    if (previous) await this.reloadHistory(active, version, undefined, result);
    if (this.stillCurrent(version, active)) this.watch(active, version);
  }

  private watch(active: ActiveRoom, version: number): void {
    const controller = new AbortController();
    this.eventAbort = controller;
    const run = async () => {
      while (!controller.signal.aborted && this.stillCurrent(version, active)) {
        try {
          await this.options.client().events(active.link.roomId, event => {
            if (controller.signal.aborted || !this.stillCurrent(version, active)) return;
            if (event.data.reason === 'identity_changed') { this.rejectIdentity({code:'identity_changed'}); return; }
            if (event.event === 'room.message') {
              const item = event.data as EkkoMessage;
              if (item.roomId !== active.link.roomId || !item.id) return;
              this.streamActivity.delete(item.id); this.renderStreamActivity();
              const key = keyOf(active.workId, active.link);
              this.histories.set(key, mergeMessages(this.histories.get(key) ?? [], [item]));
              this.renderMessages();
            } else if (event.event === 'room.stream') {
              if (event.data.roomId !== active.link.roomId) return;
              const id = event.data.id;
              if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return;
              // Transport fragments are not persisted answers. Track activity only.
              if (['message_stream_start', 'message_stream_delta', 'message_stream_snapshot'].includes(String(event.data.type))) this.streamActivity.add(id);
              else if (event.data.type === 'message_stream_end') this.streamActivity.delete(id);
              this.renderStreamActivity(); this.renderMessages();
            } else if (event.event === 'room.disconnected') {
              this.clearStreamActivity();
              if (event.data.state === 'denied') { this.stopEvents(); this.setStatus('房间实时访问已被拒绝，请核对账号和权限'); }
              else this.setStatus('房间实时连接中断，正在补读历史');
            }
          }, controller.signal, active.link);
          if (!controller.signal.aborted && this.stillCurrent(version, active)) this.clearStreamActivity();
        } catch (error) {
          if (controller.signal.aborted || !this.stillCurrent(version, active)) break;
          this.clearStreamActivity();
          if (this.rejectIdentity(error)) break;
          if (error instanceof BridgeError && error.status === 403) { this.stopEvents(); this.setStatus(errorText(error)); break; }
          if (!controller.signal.aborted && this.stillCurrent(version, active)) this.setStatus(`房间实时连接中断：${errorText(error)}；正在补读历史`);
        }
        if (controller.signal.aborted || !this.stillCurrent(version, active)) break;
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (controller.signal.aborted || !this.stillCurrent(version, active)) break;
        await this.reloadHistory(active, version);
      }
    };
    void run();
  }

  private async reloadHistory(active: ActiveRoom, version: number, confirmed?: string, firstPage?: RoomPage): Promise<void> {
    if (active.historyLoading || !this.stillCurrent(version, active)) return;
    if (active.gap?.before) {
      // Finish the saved gap before scanning newer pages, which may hide a second gap.
      for (let page = 0; page < 20 && active.gap?.before && this.stillCurrent(version, active); page++) {
        const before: string = active.gap.before;
        await this.readOlder(false);
        if (active.gap?.before === before) return; // Failed or already busy: retain the retry cursor.
      }
      if (this.stillCurrent(version, active) && !active.gap) await this.reloadHistory(active, version, confirmed);
      return;
    }
    active.historyLoading = true;
    try {
      const key = keyOf(active.workId, active.link);
      // null records a verified empty start: all later pages are new history.
      const anchor = active.historyAnchor;
      const result = firstPage ?? await this.options.client().room(active.link.roomId, { limit: 100 }, active.link);
      if (!this.stillCurrent(version, active)) return;
      let page = result; let incoming = [...result.messages]; let pages = 1;
      const cursors = new Set<string>();
      let pageError: unknown;
      while ((!anchor || !incoming.some(item => item.id === anchor)) && page.hasMore && pages < 20) {
        const before = page.messages[0]?.id;
        if (!before || cursors.has(before)) break;
        cursors.add(before);
        try { page = await this.options.client().room(active.link.roomId, { before, limit: 100 }, active.link); }
        catch (error) {
          if (!this.stillCurrent(version, active) || this.rejectIdentity(error)) return;
          cursors.delete(before); pageError = error; break;
        }
        if (!this.stillCurrent(version, active)) return;
        incoming = mergeMessages(page.messages, incoming); pages++;
      }
      const complete = !pageError && (anchor ? incoming.some(item => item.id === anchor) : !page.hasMore);
      if (complete) {
        active.historyAnchor = mergeMessages([], incoming).at(-1)?.id ?? null;
        active.gap = undefined;
        active.olderHasMore = active.olderHasMore && page.hasMore;
      } else {
        const before = page.messages[0]?.id;
        active.gap = { before: page.hasMore && before && !cursors.has(before) ? before : undefined,
          newestAnchor: mergeMessages([], result.messages).at(-1)?.id ?? null, cursors };
      }
      result.messages = incoming;
      this.histories.set(key, mergeMessages(this.histories.get(key) ?? [], result.messages));
      this.saveVisibleDraft();
      const draft = this.draft(key);
      const selected = draft.selectedAgents;
      active.agents = result.agents;
      draft.selectedAgents = selected.filter(old => this.verifiedAgents(active).some(agent => same(agent, old)));
      const changed = selected.length !== draft.selectedAgents.length;
      active.agents = result.agents;
      this.rememberHistory(active);
      this.panel.querySelector('[data-ekko-agents]')?.replaceWith(this.createAgentBlock());
      this.sourcePreview(); this.renderMentionPicker();
      this.renderMessages();
      this.setStatus(!complete ? `${confirmed ? confirmed + '；' : ''}历史未补齐${pageError ? `：${errorText(pageError)}` : ''}，请继续读取更早消息或在 EKKO 核对` : changed ? 'Agent 名称或成员已变化，请核对并重新选择' : confirmed ?? '房间历史已补齐');
    } catch (error) { if (this.stillCurrent(version, active) && !this.rejectIdentity(error)) this.setStatus(`${confirmed ? `${confirmed}；` : ''}历史未补齐，补读失败：${errorText(error)}`); }
    finally { active.historyLoading = false; }
  }

  async loadOlder(): Promise<void> { await this.readOlder(true); }

  private async readOlder(recheckLatest: boolean): Promise<void> {
    const active = this.active;
    if (!this.online || !active || !active.hasMore || active.historyLoading) return;
    const key = this.currentKey();
    const gap = active.gap;
    // A gap ends at the old success anchor, not at the oldest merged cache row.
    const before = gap ? gap.before : this.histories.get(key)?.[0]?.id;
    if (!before) return;
    const version = this.version;
    active.historyLoading = true;
    try {
      const result = await this.options.client().room(active.link.roomId, { before, limit: 100 }, active.link);
      if (!this.stillCurrent(version, active)) return;
      this.histories.set(key, mergeMessages(this.histories.get(key) ?? [], result.messages));
      if (gap) {
        const complete = active.historyAnchor ? result.messages.some(item => item.id === active.historyAnchor) : !result.hasMore;
        if (complete) {
          active.historyAnchor = gap.newestAnchor;
          active.gap = undefined;
          active.olderHasMore = active.olderHasMore && result.hasMore;
          this.setStatus('此前缺口已补齐，正在核对最新历史');
        } else {
          gap.cursors.add(before);
          const next = result.messages[0]?.id;
          gap.before = result.hasMore && next && !gap.cursors.has(next) ? next : undefined;
          this.setStatus(gap.before ? '历史未补齐，请继续读取更早消息' : '历史未补齐，无法继续分页，请在 EKKO 核对');
        }
      } else active.olderHasMore = result.hasMore;
      this.rememberHistory(active);
      this.renderMessages(true);
    } catch (error) { if (this.stillCurrent(version, active) && !this.rejectIdentity(error)) this.setStatus(
      (gap ? '历史未补齐，' : '') + '读取更早消息失败：' + errorText(error)); }
    finally { active.historyLoading = false; }
    if (recheckLatest && gap && !active.gap && this.stillCurrent(version, active)) await this.reloadHistory(active, version);
  }

  private selectedSources(): SelectedRoomSource[] {
    const active = this.active;
    if (!active) return [];
    return [...this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-source]:checked')]
      .map(input => active.sources[Number(input.value)]?.source).filter((item): item is SelectedRoomSource => Boolean(item)).map(item => ({ ...item }));
  }
  private verifiedAgents(active: ActiveRoom): SelectedRoomAgent[] {
    // The room response is already scoped and verified by the room client.
    // Its optional per-member roomId may be omitted; explicit foreign rooms
    // and conflicting names for an ID still cannot represent this member.
    const inRoom = (agent: EkkoAgent) => agent.roomId === undefined || agent.roomId === active.link.roomId;
    const names = new Map<string, Set<string>>();
    for (const agent of active.agents) {
      if (inRoom(agent)) {
        const values = names.get(agent.agentId) ?? new Set<string>(); values.add(agent.name); names.set(agent.agentId, values);
      }
    }
    const used = new Set<string>();
    return active.agents.filter(agent => inRoom(agent) && /^[A-Za-z0-9_-]{1,160}$/.test(agent.agentId) &&
      typeof agent.name === 'string' && agent.name.trim() && !/[\r\n@]/.test(agent.name) && names.get(agent.agentId)?.size === 1 &&
      !used.has(agent.agentId) && Boolean(used.add(agent.agentId)))
      .map(agent => ({ roomId: active.link.roomId, agentId: agent.agentId, name: agent.name }));
  }
  private selectedAgents(): SelectedRoomAgent[] {
    const active = this.active;
    if (!active) return [];
    const checked = [...this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-agent]:checked')];
    return this.verifiedAgents(active).filter(agent => checked.some(input => input.value === agent.agentId && input.dataset.ekkoAgentName === agent.name));
  }
  private canChooseAgent(active: ActiveRoom, version: number): boolean {
    return this.refreshing?.version !== this.version && this.stillCurrent(version, active) && this.online && !!this.connection && sameIdentity(active.link, this.connection) &&
      !this.sending.has(keyOf(active.workId, active.link)) && !this.draft().unknownId;
  }
  private closeMentionPicker(): void {
    this.mentionPicker = undefined;
    const list = this.panel.querySelector<HTMLElement>('[data-ekko-mention-list]');
    if (list) { list.hidden = true; list.replaceChildren(); }
    this.panel.querySelector('[data-ekko-composer]')?.setAttribute('aria-expanded', 'false');
    this.panel.querySelector('[data-ekko-composer]')?.removeAttribute('aria-activedescendant');
    this.panel.querySelector('[data-ekko-action="mention-agents"]')?.setAttribute('aria-expanded', 'false');
  }
  private openMentionPicker(fromButton = false): void {
    const active = this.active;
    const textarea = this.panel.querySelector<HTMLTextAreaElement>('[data-ekko-composer]');
    if (!active || !textarea || !this.allowRoomInteraction() || !this.canChooseAgent(active, this.version)) { this.closeMentionPicker(); return; }
    const query = fromButton ? null : textarea.selectionStart === textarea.selectionEnd ? mentionQueryAtCursor(textarea.value, textarea.selectionStart) : null;
    if (!fromButton && !query) { this.closeMentionPicker(); return; }
    this.mentionPicker = { active, version: this.version, textarea, value: textarea.value, start: textarea.selectionStart,
      end: textarea.selectionEnd, query, index: 0, candidates: [] };
    this.renderMentionPicker();
    if (fromButton) textarea.focus();
  }
  private updateMentionQuery(): void { this.openMentionPicker(); }
  private pickerCurrent(picker: RoomMentionPicker): boolean {
    return this.mentionPicker === picker && this.canChooseAgent(picker.active, picker.version) &&
      this.panel.querySelector('[data-ekko-composer]') === picker.textarea && picker.textarea.value === picker.value &&
      picker.textarea.selectionStart === picker.start && picker.textarea.selectionEnd === picker.end;
  }
  private renderMentionPicker(): void {
    const picker = this.mentionPicker;
    const list = this.panel.querySelector<HTMLElement>('[data-ekko-mention-list]');
    if (!picker || !list) return;
    if (!this.pickerCurrent(picker)) { this.closeMentionPicker(); return; }
    const agents = this.verifiedAgents(picker.active);
    const needle = picker.query?.query.toLocaleLowerCase() ?? '';
    picker.candidates = agents.filter(agent => agent.name.toLocaleLowerCase().includes(needle));
    picker.index = clampMentionIndex(picker.index, picker.candidates.length);
    list.replaceChildren(); list.hidden = false;
    const room = list.parentElement!.getBoundingClientRect();
    const controls = this.panel.querySelector<HTMLElement>('.sac-ekko-send-controls')!.getBoundingClientRect();
    if (room.height > 0) {
      list.style.bottom = `${Math.max(0, room.bottom - controls.top + 4)}px`;
      list.style.maxHeight = `${Math.max(0, Math.min(220, controls.top - room.top - 8))}px`;
    }
    picker.textarea.setAttribute('aria-expanded', 'true');
    this.panel.querySelector('[data-ekko-action="mention-agents"]')?.setAttribute('aria-expanded', 'true');
    picker.textarea.removeAttribute('aria-activedescendant');
    if (!picker.candidates.length) {
      const empty = text(list.ownerDocument, 'div', agents.length ? '没有匹配的机器人' : '当前房间暂无已核实的机器人', 'sac-ekko-mention-empty');
      empty.setAttribute('role', 'status'); list.append(empty); return;
    }
    picker.candidates.forEach((agent, index) => {
      const option = button(list.ownerDocument, agent.name, 'mention-option'); option.removeAttribute('data-ekko-action');
      option.dataset.ekkoMentionOption = ''; option.id = `${list.id}-option-${index}`; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(index === picker.index)); option.tabIndex = -1; option.title = agent.name;
      option.addEventListener('focus', () => {
        if (!list.contains(option)) return;
        if (!this.pickerCurrent(picker)) { this.closeMentionPicker(); return; }
        picker.index = index;
        list.querySelectorAll('[data-ekko-mention-option]').forEach(item => item.setAttribute('aria-selected', String(item === option)));
        picker.textarea.setAttribute('aria-activedescendant', option.id);
      });
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => { if (list.contains(option)) this.chooseAgent(picker, agent); });
      list.append(option);
      if (index === picker.index) picker.textarea.setAttribute('aria-activedescendant', option.id);
    });
    list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }
  private chooseAgent(picker: RoomMentionPicker, agent: SelectedRoomAgent): void {
    if (!this.pickerCurrent(picker) || !this.verifiedAgents(picker.active).some(current => same(current, agent))) { this.closeMentionPicker(); return; }
    const checkbox = [...this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-agent]')].find(input => input.value === agent.agentId && input.dataset.ekkoAgentName === agent.name);
    if (!checkbox) { this.closeMentionPicker(); return; }
    checkbox.checked = true;
    const input = picker.textarea;
    if (picker.query) {
      input.value = picker.value.slice(0, picker.query.start) + picker.value.slice(picker.query.end);
      input.setSelectionRange(picker.query.start, picker.query.start);
    }
    this.closeMentionPicker(); this.saveVisibleDraft(); this.sourcePreview(); input.focus();
  }
  private onMentionKey(event: KeyboardEvent): void {
    if (!(event.target as Element).matches('[data-ekko-composer], [data-ekko-mention-option], [data-ekko-action="mention-agents"]')) return;
    const picker = this.mentionPicker;
    if (!picker) return;
    if (!this.pickerCurrent(picker)) { this.closeMentionPicker(); return; }
    const action = mentionKeyAction({ key: event.key, isComposing: event.isComposing || event.keyCode === 229,
      open: true, index: picker.index, count: picker.candidates.length });
    if (action.kind === 'ignore') return;
    event.preventDefault(); event.stopPropagation();
    if (action.kind === 'close') { this.closeMentionPicker(); picker.textarea.focus(); }
    else if (action.kind === 'move') {
      if ((event.target as Element).matches('[data-ekko-mention-option]'))
        this.panel.querySelectorAll<HTMLElement>('[data-ekko-mention-option]')[action.index]?.focus();
      else { picker.index = action.index; this.renderMentionPicker(); }
    }
    else if (action.kind === 'choose' && picker.candidates[action.index]) this.chooseAgent(picker, picker.candidates[action.index]);
  }
  private renderSelectedAgents(): void {
    const chips = this.panel.querySelector<HTMLElement>('[data-ekko-selected-agents]');
    const active = this.active;
    if (!chips || !active) return;
    chips.replaceChildren(); const version = this.version;
    this.selectedAgents().forEach(agent => {
      const chip = text(chips.ownerDocument, 'span', '', 'sac-ekko-agent-chip'); chip.title = agent.name;
      chip.append(text(chips.ownerDocument, 'span', `@${agent.name}`));
      const remove = button(chips.ownerDocument, '×', 'remove-agent'); remove.removeAttribute('data-ekko-action');
      remove.dataset.ekkoRemoveAgent = agent.agentId; remove.setAttribute('aria-label', `移除机器人 ${agent.name}`);
      remove.disabled = !this.canChooseAgent(active, version);
      remove.addEventListener('click', () => {
        if (!chips.contains(remove) || !this.canChooseAgent(active, version)) return;
        const input = [...this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-agent]')].find(input => input.value === agent.agentId && input.dataset.ekkoAgentName === agent.name);
        if (input) { input.checked = false; this.saveVisibleDraft(); this.sourcePreview(); }
      });
      chip.append(remove); chips.append(chip);
    });
    chips.hidden = !chips.children.length;
  }
  private saveVisibleDraft(textOnly = false): void {
    const active = this.active;
    if (!active) return;
    const textarea = this.panel.querySelector<HTMLTextAreaElement>('[data-ekko-composer]');
    if (!textarea) return;
    const draft = this.draft();
    draft.text = textarea.value;
    // Every collector (input, retry and scope exit) keeps only free typing
    // while choices are guarded. Restore those controls from the authoritative
    // draft so a later version cannot revive previously rejected DOM changes.
    if (textOnly || this.refreshing?.version === this.version || !this.stillCurrent(this.version, active)) {
      this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-source]').forEach(input => {
        input.checked = draft.selectedSources.some(source => same(source, active.sources[Number(input.value)]?.source));
      });
      this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-agent]').forEach(input => {
        input.checked = draft.selectedAgents.some(agent => agent.roomId === active.link.roomId && agent.agentId === input.value && agent.name === input.dataset.ekkoAgentName);
      });
      return;
    }
    draft.selectedSources = this.selectedSources();
    draft.selectedAgents = this.selectedAgents();
  }

  private sourcePreview(): void {
    this.renderSelectedAgents();
    const preview = this.panel.querySelector<HTMLElement>('[data-ekko-preview]');
    if (!preview || !this.active) return;
    const selected = this.selectedSources();
    const summary=this.panel.querySelector('[data-ekko-source-details] > summary');if(summary)summary.textContent=`本轮资料 ${selected.length} 项 · @Agent ${this.selectedAgents().length} 位（展开）`;
    preview.textContent = selected.length ? `本轮发送给房间所有可见成员和 Agent 的资料：${selected.map(source =>
      this.active!.sources.find(option => same(option.source, source))?.label ?? source.documentId).join('、')}` : this.draft().reply ? '本轮发送消息文字与已选房间引用；不附带文档、Chat 固定资料或任务资料' : '本轮仅发送消息文字；不附带文档、Chat 固定资料或任务资料';
    preview.title=preview.textContent;
  }

  private replyFor(id: string): RoomReply | undefined {
    const active = this.active;
    if (!active) return;
    const item = (this.histories.get(this.currentKey()) ?? []).find(item => item.id === id);
    if (!item || item.roomId !== active.link.roomId || item.isStreaming || this.streamActivity.has(id) ||
        roomMessageView(item, this.verifiedAgents(active))?.presentation !== 'reply' || !item.content.trim()) return;
    return { roomId: item.roomId, messageId: item.id, senderName: item.senderName ?? '', content: item.content };
  }
  private answerFor(id: string): RoomAnswerSource | undefined {
    const active = this.active;
    if (!active || !validMessageId(id)) return;
    const item = (this.histories.get(this.currentKey()) ?? []).find(message => message.id === id);
    if (!item || item.role !== 'assistant' || typeof item.senderId !== 'string' || item.senderId.startsWith('auth:') ||
      !this.verifiedAgents(active).some(agent => agent.agentId === item.senderId) ||
      (Object.hasOwn(item, 'isStreaming') ? item.isStreaming !== false : item.preservesStreamingFlagPresence !== true) || !this.replyFor(id)) return;
    return { link: { ...active.link }, documentId: active.documentRootId, messageId: id, senderId: item.senderId, content: item.content };
  }
  private replyPreview?: { element: HTMLElement; key: string; reply: RoomReply };
  private renderReply(): void {
    const previous = this.replyPreview;
    if (!this.active) { previous?.element.remove(); this.replyPreview = undefined; return; }
    this.sourcePreview();
    const draft = this.draft();
    this.renderComposerState();
    this.panel.querySelectorAll<HTMLButtonElement>('[data-ekko-action="reply"]').forEach(button => button.disabled = this.sending.has(this.currentKey()) || !!draft.unknownId || !this.replyFor(button.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? ''));
    if (!draft.reply) { previous?.element.remove(); this.replyPreview = undefined; return; }
    if (previous && this.panel.contains(previous.element) && previous.key === this.currentKey() && same(previous.reply, draft.reply)) {
      previous.element.querySelector<HTMLButtonElement>('[data-ekko-action="cancel-reply"]')!.disabled = this.sending.has(this.currentKey()) || !!draft.unknownId;
      return;
    }
    previous?.element.remove();
    const doc = this.panel.ownerDocument;
    const preview = text(doc, 'div', '', 'sac-ekko-reply-preview'); preview.dataset.ekkoReplyPreview = '';
    const details = doc.createElement('details'); details.className = 'sac-ekko-quote';
    const summary = text(doc, 'summary', ''); summary.title = '展开或收起完整原文';
    summary.append(text(doc, 'strong', `引用：${draft.reply.senderName || '房间成员'}`),
      text(doc, 'span', quoteSummary(draft.reply.content, `引用：${draft.reply.senderName || '房间成员'}`), 'sac-ekko-quote-excerpt'), text(doc, 'span', '原文', 'sac-ekko-quote-hint'));
    details.append(summary, text(doc, 'pre', draft.reply.content)); preview.append(details);
    const cancel = button(doc, '取消引用', 'cancel-reply'); cancel.disabled = this.sending.has(this.currentKey()) || !!draft.unknownId;
    preview.append(cancel); this.panel.querySelector('[data-ekko-send-form]')?.prepend(preview);
    this.replyPreview = { element: preview, key: this.currentKey(), reply: { ...draft.reply } };
  }

  async sendCurrent(): Promise<void> {
    const active = this.active;
    const connection = this.connection;
    if (!active || !connection || !this.online) { this.setStatus('请先进入已关联的房间并核对账号连接'); return; }
    const key = keyOf(active.workId, active.link);
    const draft = this.draft(key);
    const textarea = this.panel.querySelector<HTMLTextAreaElement>('[data-ekko-composer]');
    if (!textarea || !this.allowRoomInteraction()) return;
    draft.text = textarea.value;
    draft.selectedSources = this.selectedSources();
    draft.selectedAgents = this.selectedAgents();
    const workId = active.workId;
    const expectedIdentity = { connectionId: active.link.connectionId, deviceId: active.link.deviceId, accountUserId: active.link.accountUserId };
    const documentRootId = this.options.getDocumentRootId();
    const text = draft.text;
    const reply = draft.reply ? { ...draft.reply } : undefined;
    const selectedSources = draft.selectedSources.map(source => ({ ...source }));
    const selectedAgents = draft.selectedAgents.map(agent => ({ ...agent }));
    const version = this.version;
    const bridgeIdentity = this.options.getBridgeIdentity?.();
    // Navigation may stale the scene while the original input stays mounted.
    // Only that owned input can consume an ACK; no new room/view/connection can.
    const ownsInput = () => !this.disposed && this.root.isConnected && (this.options.isCurrent?.() ?? true) &&
      this.active === active && this.panel.querySelector('[data-ekko-composer]') === textarea && this.currentKey() === key &&
      this.options.getWorkId() === workId && this.options.getDocumentRootId() === documentRootId &&
      this.online && !!this.connection && sameIdentity(active.link, this.connection) &&
      (this.stillCurrent(version, active) || Boolean(bridgeIdentity && this.options.getBridgeIdentity?.() === bridgeIdentity));
    let submitted = false;
    let claimed = false;
    let confirmedSent = false;
    let clientMessageId = '';
    this.sending.set(key, 'preparing'); this.closeMentionPicker(); this.renderSelectedAgents(); this.renderReply(); this.renderComposerState();
    try {
      if (this.options.getWorkId() !== workId || !documentRootId) throw new Error('Work 或文档已切换，请重新核对');
      const freshConnection = (await this.options.client().connection()).connection;
      if (!freshConnection || freshConnection.state !== 'connected' || !sameIdentity(active.link, freshConnection)) throw new Error('EKKO 连接账号或设备已变化');
      await this.options.store.assertLinked(workId, identity(freshConnection), active.link.roomId, documentRootId);
      const input = { workId, roomLink: active.link, documentRootId, text, reply, selectedSources, selectedAgents, loadSource: this.options.loadSource };
      const frozen = await prepareRoomSend(input);
      clientMessageId = frozen.clientMessageId;
      // Claim the immutable ID before POST so a crash or another panel cannot silently send again.
      await this.options.pendingStore.remember(active.link, clientMessageId);
      claimed = true;
      draft.unknownId = clientMessageId;
      // Finish connection and link checks before the last source read; nothing awaits between that read and POST.
      const currentConnection = (await this.options.client().connection()).connection;
      if (!currentConnection || currentConnection.state !== 'connected' || !sameIdentity(active.link, currentConnection)) throw new Error('EKKO 连接账号或设备已变化');
      await this.options.store.assertLinked(workId, identity(currentConnection), active.link.roomId, documentRootId);
      const currentSources = selectedSources.length ? (await prepareRoomSend(input)).sources : [];
      if (!this.stillCurrent(version, active) || this.panel.querySelector('[data-ekko-composer]') !== textarea || this.options.getDocumentRootId() !== documentRootId) throw new Error('发送前 Work、房间或文档已切换；草稿保持不变');
      if (reply && !same(reply, this.replyFor(reply.messageId))) throw new Error('引用原消息已变化或不可引用，请重新选择；草稿保持不变');
      assertRoomSendCurrent(frozen, { workId: this.options.getWorkId(), roomLink: active.link,
        documentRootId: this.options.getDocumentRootId(), text: textarea.value, selectedSources: this.selectedSources(),
        selectedAgents: this.selectedAgents(), reply: draft.reply, loadedSources: currentSources });
      if (!this.online || !this.connection || !sameIdentity(active.link, this.connection)) throw new Error('EKKO 连接已变化');
      submitted = true; this.sending.set(key, 'submitting'); this.renderComposerState();
      const result = await this.options.client().send(active.link.roomId,
        { clientMessageId, content: frozen.content, mentions: frozen.mentions }, expectedIdentity, documentRootId);
      if (result.state !== 'sent') {
        if (this.stillCurrent(version, active)) {
          this.panel.querySelectorAll<HTMLButtonElement>('[data-ekko-unknown-control]').forEach(item => item.hidden = false);
          this.setStatus('发送结果未知，已保留草稿和消息 ID；请到 EKKO 核对，不要重复发送');
        }
        return;
      }
      confirmedSent = true; this.sending.set(key, 'confirmed');
      if (ownsInput()) this.renderComposerState();
      // This receipt proves the frozen POST was acknowledged, never that history contains it.
      if (!this.disposed) {
        let receipts = this.sentReceipts.get(key);
        if (!receipts) { receipts = new Map(); this.sentReceipts.set(key, receipts); }
        const receipt: SentReceipt = Object.freeze({ clientMessageId,
          ...(validMessageId(result.messageId) ? { messageId: result.messageId } : {}),
          roomId: active.link.roomId, senderId: `auth:${expectedIdentity.accountUserId}`, content: frozen.content, timestamp: new Date().toISOString() });
        receipts.set(clientMessageId, receipt);
        if (this.stillCurrent(version, active)) {
          this.renderMessages();
          const loaded = (this.histories.get(key) ?? []).find(item => receiptMatches(item, receipt));
          // A tall quoted message may exceed the pane: reveal its body, rather than scrolling past it.
          this.messageRenderer?.revealMessage(loaded?.id ?? 'receipt:'+clientMessageId, '.sac-ekko-message-content');
        }
      }
      await this.options.pendingStore.clear(active.link, clientMessageId);
      delete draft.unknownId;
      const owned = ownsInput();
      if (owned && textarea.value === text) textarea.value = '';
      if (draft.text === text) draft.text = owned ? textarea.value : '';
      draft.selectedSources = [];
      draft.selectedAgents = [];
      delete draft.reply; if (owned) this.renderReply();
      if (owned && this.stillCurrent(version, active)) {
        this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-source], [data-ekko-agent]').forEach(item => item.checked = false);
        this.sourcePreview();
        await this.reloadHistory(active, version, `已发送至${active.room.name}；房间所有可见成员和 Agent 可查看`);
      }
    } catch (error) {
      if (confirmedSent) {
        if (this.stillCurrent(version, active)) {
          this.panel.querySelectorAll<HTMLButtonElement>('[data-ekko-unknown-control]').forEach(item => item.hidden = false);
          this.setStatus(`发送已确认，但本地未决标识清理失败：${errorText(error)}；草稿和消息 ID 保留，请先核对`);
        }
        return;
      }
      if (claimed && !submitted) {
        try {
          await this.options.pendingStore.clear(active.link, clientMessageId);
          delete draft.unknownId;
          claimed = false;
        } catch (clearError) {
          if (this.stillCurrent(version, active)) {
            this.panel.querySelectorAll<HTMLButtonElement>('[data-ekko-unknown-control]').forEach(item => item.hidden = false);
            this.setStatus(`消息未发送，但本地预存标识清理失败：${errorText(clearError)}；草稿和消息 ID 保留，请先核对`);
          }
          return;
        }
      }
      const rejected = submitted && definiteRejection(error);
      if (rejected && claimed) {
        try {
          await this.options.pendingStore.clear(active.link, clientMessageId);
          delete draft.unknownId;
        } catch (clearError) {
          if (this.stillCurrent(version, active)) {
            this.panel.querySelectorAll<HTMLButtonElement>('[data-ekko-unknown-control]').forEach(item => item.hidden = false);
            this.setStatus(`发送被拒绝，但本地未决标识清理失败：${errorText(clearError)}；草稿和消息 ID 保留，请先核对`);
          }
          return;
        }
      }
      if (this.stillCurrent(version, active)) {
        if (submitted && !rejected) this.panel.querySelectorAll<HTMLButtonElement>('[data-ekko-unknown-control]').forEach(item => item.hidden = false);
        this.setStatus(`${rejected ? '发送被拒绝' : submitted ? '发送结果未知' : '未发送'}：${errorText(error)}；草稿保持不变${submitted && !rejected ? '，请先到 EKKO 核对' : ''}`);
      }
    } finally {
      this.sending.delete(key);
      if (ownsInput()) { this.renderSelectedAgents(); this.renderReply(); }
      if (this.active === active) this.renderComposerState();
    }
  }

  unknownMessageId(): string | undefined { return this.active ? this.draft().unknownId : undefined; }
  async checkUnknown(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!this.allowRoomInteraction(true) || this.sending.has(this.currentKey())) { this.renderComposerState(); return; }
    this.saveVisibleDraft();
    const draft = this.draft();
    const id = draft.unknownId;
    if (!id) return;
    const checked = { reply: draft.reply ? { ...draft.reply } : undefined, text: draft.text, selectedSources: draft.selectedSources.map(source => ({ ...source })),
      selectedAgents: draft.selectedAgents.map(agent => ({ ...agent })) };
    const version = this.version;
    try {
      const result = await this.options.client().sendStatus(active.link.roomId, id,
        { connectionId: active.link.connectionId, deviceId: active.link.deviceId, accountUserId: active.link.accountUserId });
      if (result.state === 'sent') {
        await this.options.pendingStore.clear(active.link, id);
        if (this.stillCurrent(version, active)) this.saveVisibleDraft();
        const textUnchanged = draft.text === checked.text;
        const sourcesUnchanged = same(draft.selectedSources, checked.selectedSources);
        const agentsUnchanged = same(draft.selectedAgents, checked.selectedAgents);
        delete draft.unknownId;
        if (same(draft.reply, checked.reply)) delete draft.reply;
        this.renderReply();
        if (textUnchanged) draft.text = '';
        if (sourcesUnchanged) draft.selectedSources = [];
        if (agentsUnchanged) draft.selectedAgents = [];
        if (this.stillCurrent(version, active)) {
          this.panel.querySelectorAll<HTMLButtonElement>('[data-ekko-unknown-control]').forEach(item => item.hidden = true);
          if (textUnchanged) {
            const textarea = this.panel.querySelector<HTMLTextAreaElement>('[data-ekko-composer]');
            if (textarea) textarea.value = '';
          }
          if (sourcesUnchanged) this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-source]').forEach(item => item.checked = false);
          if (agentsUnchanged) this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-agent]').forEach(item => item.checked = false);
          if (sourcesUnchanged) this.sourcePreview();
          await this.reloadHistory(active, version, `已在房间历史核对到上一条消息${textUnchanged && sourcesUnchanged && agentsUnchanged ? '' : '；期间新编辑的草稿已保留'}`);
        }
      } else if (this.stillCurrent(version, active)) this.setStatus('历史仍未确认上一条消息；草稿和消息 ID 保留，请到 EKKO 核对');
    } catch (error) { if (this.stillCurrent(version, active) && !this.rejectIdentity(error)) this.setStatus(`核对失败：${errorText(error)}；草稿和消息 ID 保留`); }
  }

  async discardUnknownAfterReview(): Promise<void> {
    const active = this.active;
    if (!active) return;
    if (!this.allowRoomInteraction(true) || this.sending.has(this.currentKey())) { this.renderComposerState(); return; }
    const draft = this.draft();
    const id = draft.unknownId;
    if (!id) return;
    const confirmed = this.root.ownerDocument.defaultView?.confirm('请先在 EKKO 房间核对这条消息。确认放弃本地未决标识并清空这条草稿？') ?? false;
    if (!confirmed) return;
    const version = this.version;
    try {
      await this.options.pendingStore.clear(active.link, id);
      delete draft.unknownId;
      draft.text = '';
      draft.selectedSources = [];
      draft.selectedAgents = [];
      delete draft.reply; this.renderReply();
      if (this.stillCurrent(version, active)) {
        const textarea = this.panel.querySelector<HTMLTextAreaElement>('[data-ekko-composer]');
        if (textarea) textarea.value = '';
        this.panel.querySelectorAll<HTMLInputElement>('[data-ekko-source], [data-ekko-agent]').forEach(item => item.checked = false);
        this.sourcePreview();
        this.panel.querySelectorAll<HTMLButtonElement>('[data-ekko-unknown-control]').forEach(item => item.hidden = true);
        this.setStatus('已解除本地未决阻止；EKKO 房间历史未删除，下一条会使用新消息 ID');
      }
    } catch (error) { if (this.stillCurrent(version, active) && !this.rejectIdentity(error)) this.setStatus(`未决标识仍保留：${errorText(error)}`); }
  }

  private async onSubmit(event: Event): Promise<void> {
    const form = event.target as HTMLFormElement;
    if (!form.matches('[data-ekko-pair-form], [data-ekko-send-form]')) return;
    event.preventDefault();
    if (form.matches('[data-ekko-send-form]')) { await this.sendCurrent(); return; }
    const baseUrl = form.querySelector<HTMLInputElement>('[name="baseUrl"]')?.value.trim() ?? '';
    const username = form.querySelector<HTMLInputElement>('[name="username"]')?.value.trim() ?? '';
    const passwordInput = form.querySelector<HTMLInputElement>('[name="password"]');
    const password = passwordInput?.value ?? '';
    if (passwordInput) passwordInput.value = '';
    await this.pair({ baseUrl, username, password });
  }
  private async onClick(event: Event): Promise<void> {
    const target = (event.target as Element).closest<HTMLButtonElement>('[data-ekko-action]');
    if (!target) return;
    if (!this.panel.contains(target)) return;
    const id = target.dataset.ekkoId ?? '';
    switch (target.dataset.ekkoAction) {
      case 'adopt-answer':
      case 'draft-answer': {
        const active = this.active, version = this.version;
        const source = this.answerButtons.get(target);
        if (!active || !source || !this.options.onAnswerAction) break;
        const current = () => this.canChooseAgent(active, version) && same(source, this.answerFor(source.messageId));
        if (!current()) { this.setStatus('原回答或房间状态已变化，请重新选择'); break; }
        try { await this.options.onAnswerAction(target.dataset.ekkoAction === 'adopt-answer' ? 'adopt' : 'task-draft', structuredClone(source), current); }
        catch (error) { if (this.stillCurrent(version, active)) this.setStatus(error instanceof Error ? error.message : '回答操作暂不可用'); }
        break;
      }
      case 'reply': {
        const active = this.active;
        if (!active || !this.allowRoomInteraction()) break;
        const snapshot = this.replyButtons.get(target);
        const reply = snapshot && this.replyFor(snapshot.messageId);
        if (!reply || !same(snapshot, reply)) { this.setStatus('原消息已变化，请重新选择引用'); break; }
        this.saveVisibleDraft(); this.draft().reply = reply; this.renderReply(); break;
      }
      case 'cancel-reply':
        if (this.allowRoomInteraction()) { delete this.draft().reply; this.renderReply(); }
        break;
      case 'mention-agents': this.openMentionPicker(true); break;
      case 'open-sources': {
        if (!this.allowRoomInteraction(true)) break;
        const details = this.panel.querySelector<HTMLDetailsElement>('[data-ekko-source-details]');
        if (details) details.open = true;
        break;
      }
      case 'configure-connection': this.options.openConnectionSettings?.(); break;
      case 'refresh': await this.refresh(); break;
      case 'more-rooms': await this.loadMoreRooms(); break;
      case 'link': await this.linkRoom(id); break;
      case 'unlink': {
        const link = this.links.find(item => keyOf(item.workId, item) === target.dataset.ekkoLinkKey);
        if (link) await this.unlinkRoom(link);
        break;
      }
      case 'open': {
        const version=this.version;
        const link=this.links.find(item=>item.roomId===id&&this.connection&&sameIdentity(item,this.connection));
        try {if(link && this.options.onOpenLink) await this.options.onOpenLink(link); else await this.openRoom(id);}
        catch(error){if(this.stillCurrent(version))this.setStatus(errorText(error));}
        break;
      }
      case 'older': await this.loadOlder(); break;
      case 'check-unknown': await this.checkUnknown(); break;
      case 'discard-unknown': await this.discardUnknownAfterReview(); break;
      case 'refresh-sources': {
        const active = this.active; const version = this.version;
        if (!active || !this.allowRoomInteraction(true) || this.sending.has(this.currentKey())) { this.renderComposerState(); break; }
        try {
          const sources = await this.options.availableSources(active.workId);
          if (this.stillCurrent(version, active)) {
            const expanded = this.panel.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')?.open ?? false;
            this.saveVisibleDraft(); active.sources = this.retainSelectedSources(sources,this.draft()); this.render();
            const details = this.panel.querySelector<HTMLDetailsElement>('[data-ekko-source-details]');
            if (details) details.open = expanded;
          }
        } catch (error) { if (this.stillCurrent(version, active) && !this.rejectIdentity(error)) this.setStatus(`刷新资料失败：${errorText(error)}`); }
        break;
      }
    }
  }
  private onInput(event: Event): void {
    if ((event.target as Element).matches('[data-ekko-composer]') && this.panel.contains(event.target as Node) && this.stillCurrent(this.version, this.active ?? undefined)) { this.saveVisibleDraft(); this.updateMentionQuery(); }
  }
  private onChange(event: Event): void {
    if ((event.target as Element).matches('[data-ekko-source], [data-ekko-agent]') && this.refreshing?.version !== this.version && this.stillCurrent(this.version, this.active ?? undefined)) {
      this.saveVisibleDraft(); this.sourcePreview();
    }
  }

  private render(): void {
    this.closeMentionPicker();
    const doc = this.panel.ownerDocument;
    this.resizeCleanup?.();this.resizeCleanup=undefined;
    this.panel.replaceChildren();
    const top = doc.createElement('div'); top.className = 'sac-ekko-top';
    top.append(text(doc, 'strong', 'EKKO 房间'), button(doc, '刷新', 'refresh'));
    this.panel.append(top);
    this.panel.append(text(doc, 'div', this.status, 'sac-ekko-status'));
    this.panel.lastElementChild!.setAttribute('data-ekko-status', '');
    this.panel.append(text(doc, 'p', this.online && this.connection ? `已核对账号：${this.connection.accountName}` : 'EKKO 未连接；已有房间关系保留', 'sac-ekko-account'));
    if (!this.online) this.renderPairForm();
    const workId = this.options.getWorkId();
    if (!validRoomScope(this.scope())) { this.panel.append(text(doc, 'p', '请先打开一个思源文档，再关联房间')); return; }
    this.panel.append(text(doc, 'h3', workId ? '当前 Work 已关联房间' : '当前文档已关联房间'));
    const linked = doc.createElement('div'); linked.className = 'sac-ekko-list';
    for (const link of this.links) {
      const row = doc.createElement('div'); row.dataset.ekkoLinkedRoom = link.roomId;
      row.append(text(doc, 'span', link.roomNameAtLink));
      if (this.online && this.connection && sameIdentity(link, this.connection)) row.append(button(doc, '打开', 'open', link.roomId));
      else row.append(text(doc, 'small', '当前账号或服务不可用'));
      const unlink = button(doc, '取消关联', 'unlink'); unlink.dataset.ekkoLinkKey = keyOf(link.workId, link);
      row.append(unlink);
      linked.append(row);
    }
    if (!this.links.length) linked.append(text(doc, 'p', '尚未关联房间'));
    this.panel.append(linked);
    if (this.online) {
      this.panel.append(text(doc, 'h3', '可关联的房间'));
      const available = doc.createElement('div'); available.className = 'sac-ekko-list';
      for (const room of this.rooms) {
        if (this.links.some(link => link.roomId === room.id && this.connection && sameIdentity(link, this.connection))) continue;
        const row = doc.createElement('div'); row.append(text(doc, 'span', room.name), button(doc, workId ? '关联到当前 Work' : '关联到当前文档', 'link', room.id)); available.append(row);
      }
      if (!available.children.length) available.append(text(doc, 'p', '暂无可关联房间'));
      this.panel.append(available);
      if (this.roomHasMore) this.panel.append(button(doc, '加载更多房间', 'more-rooms'));
    }
    const manager=doc.createElement('details'); manager.className='sac-ekko-management';manager.open=!this.active;
    const summary=text(doc,'summary','连接与房间管理');manager.append(summary);
    // Keep unknown-send status outside the collapsed management area.
    for(const child of [...this.panel.children]) if(!child.hasAttribute('data-ekko-status')) manager.append(child);
    this.panel.append(manager);
    if (this.active) this.renderRoom();
  }

  private renderPairForm(): void {
    const doc = this.panel.ownerDocument;
    if(this.options.openConnectionSettings){this.panel.append(button(doc,'配置 EKKO 连接','configure-connection'));return;}
    const form = doc.createElement('form'); form.dataset.ekkoPairForm = '';
    for (const [name, label, type, placeholder] of [
      ['baseUrl', 'EKKO Studio 本机服务地址（与 Hermes Bridge 不同）', 'url', 'http://127.0.0.1:8748'],
      ['username', 'EKKO 账号', 'text', ''],
      ['password', '本次密码', 'password', ''],
    ]) {
      const wrapper = doc.createElement('label'); wrapper.textContent = label;
      const input = doc.createElement('input'); input.name = name; input.type = type; input.required = true; input.autocomplete = 'off';
      if (placeholder) input.placeholder = placeholder;
      if (name === 'baseUrl') input.value = 'http://127.0.0.1:8748';
      wrapper.append(input); form.append(wrapper);
    }
    form.append(button(doc, '连接 EKKO', 'pair-submit'));
    form.lastElementChild!.removeAttribute('data-ekko-action');
    (form.lastElementChild as HTMLButtonElement).type = 'submit';
    form.append(text(doc, 'small', '127.0.0.1 指这台电脑。请先启动 EKKO Studio 的本机服务，并从它的启动信息核对端口；若端口为 8748，填写 http://127.0.0.1:8748。这里不能填 Hermes Bridge 的 8782。'));
    form.append(text(doc, 'small', '密码仅用于这次连接请求；可在 EKKO 的应用连接中撤销。'));
    this.panel.append(form);
  }

  private renderRoom(): void {
    const active = this.active!;
    const doc = this.panel.ownerDocument;
    const detail = doc.createElement('div'); detail.className = 'sac-ekko-room';
    detail.append(text(doc, 'h3', active.room.name));
    const history = doc.createElement('div'); history.dataset.ekkoMessages = ''; history.className = 'sac-ekko-messages';
    detail.append(history);
    const stream = text(doc, 'div', '', 'sac-ekko-stream'); stream.dataset.ekkoStream = ''; stream.setAttribute('role', 'status'); detail.append(stream);
    const sourceBlock = doc.createElement('fieldset'); sourceBlock.append(text(doc, 'legend', '本轮资料（默认仅消息）'));
    sourceBlock.append(text(doc, 'small', '勾选文章全文或选区；新选区请重新读取。'));
    sourceBlock.append(button(doc, '重新读取可选资料', 'refresh-sources'));
    const draft = this.draft();
    active.sources.forEach((option, index) => {
      const label = doc.createElement('label');
      const input = doc.createElement('input'); input.type = 'checkbox'; input.value = String(index); input.dataset.ekkoSource = '';
      input.checked = draft.selectedSources.some(source => same(source, option.source));
      label.append(input, text(doc, 'span', option.label)); sourceBlock.append(label);
    });
    const sources=doc.createElement('details');sources.dataset.ekkoSourceDetails='';sources.id=`ekko-sources-${crypto.randomUUID()}`;
    sources.append(text(doc,'summary','本轮资料与 @Agent（按需展开）'),sourceBlock);detail.append(sources);
    const preview = text(doc, 'p', '', 'sac-ekko-preview'); preview.dataset.ekkoPreview = ''; detail.append(preview);
    const agentBlock = this.createAgentBlock();
    sources.append(agentBlock);
    const form = doc.createElement('form'); form.dataset.ekkoSendForm = '';form.className='sac-composer sac-ekko-composer';
    const grip = text(doc,'div','','sac-composer-resize');grip.dataset.composerResize='';grip.tabIndex=0;
    grip.setAttribute('role','separator');grip.setAttribute('aria-orientation','horizontal');
    grip.setAttribute('aria-label','调整房间消息输入框高度');grip.setAttribute('aria-valuemin','38');grip.setAttribute('aria-valuenow','38');
    grip.title='上下拖动调整输入框高度';form.append(grip);
    const textarea = doc.createElement('textarea'); textarea.dataset.ekkoComposer = ''; textarea.setAttribute('aria-label', '房间消息');
    textarea.placeholder = '给房间发送文字，输入 @ 选择机器人…'; textarea.value = draft.text;
    const chips = text(doc, 'div', '', 'sac-ekko-selected-agents'); chips.dataset.ekkoSelectedAgents = '';
    chips.setAttribute('aria-label', '本轮已选机器人'); chips.hidden = true;
    const wrap = text(doc, 'div', '', 'sac-ekko-mention-wrap');
    const list = text(doc, 'div', '', 'sac-ekko-mention-list'); list.dataset.ekkoMentionList = ''; list.hidden = true;
    list.id = `ekko-robots-${crypto.randomUUID()}`; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '当前房间机器人');
    textarea.setAttribute('aria-controls', list.id); textarea.setAttribute('aria-haspopup', 'listbox'); textarea.setAttribute('aria-expanded', 'false');
    wrap.append(textarea);
    const toolbar = text(doc, 'div', '', 'sac-ekko-send-controls');
    const mention = button(doc, '@机器人', 'mention-agents'); mention.setAttribute('aria-haspopup', 'listbox');
    mention.setAttribute('aria-controls', list.id); mention.setAttribute('aria-expanded', 'false');
    const openSources = button(doc, '引用文章', 'open-sources'); openSources.setAttribute('aria-controls', sources.id);
    const send = button(doc, '发送到房间', 'send-submit'); send.removeAttribute('data-ekko-action'); send.type = 'submit';
    toolbar.append(openSources, mention, send);
    const state = text(doc, 'div', '', 'sac-ekko-composer-state'); state.dataset.ekkoComposerState = ''; state.setAttribute('role', 'status');
    const stateText = text(doc, 'span', ''); stateText.dataset.ekkoComposerStateText = '';
    state.append(stateText, button(doc, '刷新房间状态', 'refresh'));
    form.append(chips, wrap, state, toolbar);
    // Position the room-only menu inside the clipping boundary, above controls.
    detail.append(list);
    detail.append(form);
    const check = button(doc, '核对上一条发送状态', 'check-unknown'); check.dataset.ekkoUnknownControl = '';
    check.hidden = !draft.unknownId; state.append(check);
    const discard = button(doc, '我已在 EKKO 核对，放弃本地未决', 'discard-unknown'); discard.dataset.ekkoUnknownControl = '';
    discard.hidden = !draft.unknownId; state.append(discard);
    if (!this.online) detail.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button').forEach(control => control.disabled = true);
    this.panel.append(detail);
    this.resizeCleanup=bindComposerResize(detail,{initialHeight:draft.composerHeight,onResize:height=>{draft.composerHeight=height;this.closeMentionPicker();}});
    this.renderMessages(); this.renderStreamActivity(); this.sourcePreview(); this.renderReply(); this.renderComposerState();
  }

  private createAgentBlock(): HTMLElement {
    const active = this.active!; const doc = this.panel.ownerDocument; const draft = this.draft();
    const agentBlock = doc.createElement('fieldset'); agentBlock.append(text(doc, 'legend', '@Agent（仅列出当前房间已核实的 Agent）'));
    this.verifiedAgents(active).forEach(agent => {
      const label = doc.createElement('label');
      const input = doc.createElement('input'); input.type = 'checkbox'; input.value = agent.agentId; input.dataset.ekkoAgent = ''; input.dataset.ekkoAgentName = agent.name;
      input.checked = draft.selectedAgents.some(selected => selected.agentId === agent.agentId && selected.name === agent.name);
      label.append(input, text(doc, 'span', agent.name)); agentBlock.append(label);
    });

    agentBlock.dataset.ekkoAgents = ''; return agentBlock;
  }
  private replyButtons = new WeakMap<HTMLButtonElement, RoomReply>();
  private answerButtons = new WeakMap<HTMLButtonElement, RoomAnswerSource>();
  private messageRenderer?: MessageRenderer<RenderedRoomMessage>;
  private messageArea?: HTMLElement;
  private renderMessages(prepend=false): void {
    const active = this.active;
    const container = this.panel.querySelector<HTMLElement>('[data-ekko-messages]');
    if (!active || !container) return;
    if(this.messageArea!==container){this.messageRenderer?.dispose();this.messageArea=container;this.messageRenderer=new MessageRenderer(container,(item,doc)=>{
      const own = isOwnRoomMessage(item, this.active!.link.accountUserId);
      const time = messageTime(item.timestamp);
      const meta='<div class="sac-ekko-message-meta"><span>'+escapeMessage(own ? '你' : item.senderName || '房间成员')+'</span>'+(time ? '<time datetime="'+escapeMessage(time.full)+'" title="'+escapeMessage(time.full)+'">'+escapeMessage(time.short)+'</time>' : '')+'</div>';
      const projected = projectRoomContent(item.content);
      const quote = projected.quote ? '<details class="sac-ekko-quote" data-ekko-history-quote><summary title="展开或收起完整原文"><strong>'+escapeMessage(projected.quote.label)+'</strong><span class="sac-ekko-quote-excerpt">'+escapeMessage(quoteSummary(projected.quote.content, projected.quote.label))+'</span><span class="sac-ekko-quote-hint">原文</span></summary><pre><code>'+escapeMessage(projected.quote.content).replace(/\r/g,'&#13;')+'</code></pre></details>' : '';
      const body=item.presentation==='waiting'?'<div role="status">正在回复…</div>':item.presentation==='tools'||item.presentation==='stats'||item.presentation==='result'?
        '<details class="sac-ekko-technical" data-ekko-technical><summary>'+ (item.presentation==='tools'?'工具定义':item.presentation==='stats'?'运行统计':'工具结果')+'（展开查看原文）</summary><pre><code>'+escapeMessage(item.content).replace(/\r/g,'&#13;')+'</code></pre></details>':
        '<div class="sac-ekko-message-content">'+markdownMarkup(projected.body,doc)+'</div>'+quote;
      const reply = !item.acknowledged && this.replyFor(item.id);
      const answer = !item.acknowledged && this.options.onAnswerAction && this.answerFor(item.id);
      const actions = item.presentation === 'reply' ? '<div class="sac-ekko-message-actions"><button type="button" class="sac-copy-reply" data-copy-reply>复制</button>'+(reply ? '<button type="button" data-ekko-action="reply">引用回复</button>' : '')+(answer ? '<button type="button" data-ekko-action="adopt-answer">采纳</button><button type="button" data-ekko-action="draft-answer">待办草稿</button>' : '')+'</div>' : '';
      return '<article class="sac-ekko-message">'+meta+body+(item.acknowledged ? '<div class="sac-ekko-receipt-status" role="status">已发送，等待历史同步</div>' : '')+actions+'</article>';
    });}
    const agents=this.verifiedAgents(active);
    const key = this.currentKey();
    const history = this.histories.get(key) ?? [];
    const receipts = this.sentReceipts.get(key);
    // Reconcile only full canonical proof. Names, roles, timestamps and approximate text prove nothing.
    if (receipts) {
      for (const [id, receipt] of receipts) if (history.some(item => receiptMatches(item, receipt))) receipts.delete(id);
      if (!receipts.size) this.sentReceipts.delete(key);
    }
    const items: RenderedRoomMessage[] = history.map(item=>roomMessageView(item,agents)).filter((item): item is RoomMessageView=>item!==null);
    // Local-only IDs cannot collide with validated transport IDs; receipts never enter histories or paging.
    for (const receipt of receipts?.values() ?? []) items.push({ id: 'receipt:'+receipt.clientMessageId,
      roomId: receipt.roomId, senderId: receipt.senderId, content: receipt.content, timestamp: receipt.timestamp,
      presentation: 'reply', acknowledged: true });
    const older=active.hasMore?(container.querySelector<HTMLButtonElement>('[data-ekko-action="older"]')??button(container.ownerDocument,'读取更早消息','older')):undefined;
    this.messageRenderer!.render(this.currentKey(),items,'<p>暂无文字消息</p>',older,prepend);
    // Shared renderer patches children only on same-ID edits: refresh row identity explicitly.
    const byId = new Map(items.map(item => [item.id, item]));
    for (const row of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
      const item = byId.get(row.dataset.messageId!);
      if (!item) continue;
      const author = isOwnRoomMessage(item, active.link.accountUserId) ? 'self' : 'other';
      if (row.dataset.author !== author) row.dataset.author = author;
      row.toggleAttribute('data-ekko-pending-history', !!item.acknowledged);
    }
    container.querySelectorAll<HTMLButtonElement>('[data-ekko-action="reply"]').forEach(button => {
      const reply = this.replyFor(button.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? '');
      button.disabled = !reply || this.sending.has(this.currentKey()) || !!this.draft().unknownId;
      if (reply) this.replyButtons.set(button, reply);
    });
    container.querySelectorAll<HTMLButtonElement>('[data-ekko-action="adopt-answer"], [data-ekko-action="draft-answer"]').forEach(button => {
      const source = this.answerFor(button.closest<HTMLElement>('[data-message-id]')?.dataset.messageId ?? '');
      button.disabled = !source || !this.canChooseAgent(active, this.version);
      if (source) this.answerButtons.set(button, source);
    });
  }
}
