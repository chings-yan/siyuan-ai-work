export type ContextRef = { documentId: string; blockId: string | null; kind: 'document' | 'block' };
export type ChatAdapter = 'serve' | 'studio' | 'legacy-api' | 'unresolved';
export type ChatState = 'creating' | 'pending' | 'ready' | 'unknown' | 'source-unknown';
export type LegacyChatLink = { chatId: string; workId: string; documentRootId: string; connectionId: string };
export type ChatLink = Omit<LegacyChatLink, 'workId'> & { workId: string | null; adapter: ChatAdapter; profile: string; storedSessionId: string | null; legacyCandidateId?: string; legacyBridgeUrl?: string; installId: string | null; title: string; state: ChatState };
export type LegacyChatClassification = { chatId: string; connectionId: string; adapter: 'studio' | 'legacy-api'; profile: string; storedSessionId: string; documentRootId: string; installId: null };
export type TaskLink = { taskId: string; workId: string; connectionId: string };
export type ResumeState = { workId: string; documentId: string; focusBlockId: string | null; chatId: string | null; taskId: string | null; updatedAt: string };
export type PendingOperation = { id: string; kind: 'work' | 'chat' | 'task' | 'write'; workId: string | null; state: 'unknown' | 'partial'; details: string; updatedAt: string };
export type StoragePort = { loadData(key: string): Promise<unknown> | unknown; saveData(key: string, value: unknown): Promise<unknown> | unknown };

type FormalV1 = { schema: 1; works: string[]; chats: LegacyChatLink[]; tasks: TaskLink[]; pins: Record<string, ContextRef[]> };
type Formal = { schema: 2; works: string[]; chats: ChatLink[]; tasks: TaskLink[]; pins: Record<string, ContextRef[]> };
type Resume = { schema: 1; items: Record<string, ResumeState> };
type Pending = { schema: 1; items: PendingOperation[] };
const FORMAL_V1 = 'work-formal-v1';
const FORMAL = 'work-formal-v2';
const RESUME = 'work-resume-v1';
const PENDING = 'work-pending-v1';
const emptyFormal = (): Formal => ({ schema: 2, works: [], chats: [], tasks: [], pins: {} });
const emptyResume = (): Resume => ({ schema: 1, items: {} });
const emptyPending = (): Pending => ({ schema: 1, items: [] });
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const missing = (value: unknown) => value === undefined || value === '';
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const stringOrNull = (value: unknown) => value === null || nonempty(value);
const unique = (values: string[]) => new Set(values).size === values.length;
const invalidFormal = (): never => { throw new Error('正式关系数据损坏或版本不兼容；已停止写入，请先恢复备份'); };
function validateCommon(value: Record<string, unknown>): void {
  if (!Array.isArray(value.works) || !value.works.every(nonempty) || !unique(value.works)
    || !Array.isArray(value.chats) || !Array.isArray(value.tasks) || !isRecord(value.pins)) invalidFormal();
  const works = value.works as string[];
  const tasks = value.tasks as unknown[];
  const pins = value.pins as Record<string, unknown>;
  if (!tasks.every(x => isRecord(x) && nonempty(x.taskId) && nonempty(x.workId) && nonempty(x.connectionId) && works.includes(x.workId))) invalidFormal();
  if (!unique(tasks.map(x => { const task = x as TaskLink; return `${task.connectionId}\u0000${task.taskId}`; }))) invalidFormal();
  for (const refs of Object.values(pins)) {
    if (!Array.isArray(refs) || !refs.every(x => isRecord(x) && nonempty(x.documentId) && (x.blockId === null || nonempty(x.blockId)) && (x.kind === 'document' || x.kind === 'block'))) invalidFormal();
  }
}
function validateV1(value: unknown): FormalV1 {
  if (!isRecord(value) || value.schema !== 1) invalidFormal();
  const data = value as Record<string, unknown>;
  validateCommon(data);
  const works = data.works as string[];
  const chats = data.chats as unknown[];
  if (!chats.every(x => isRecord(x) && nonempty(x.chatId) && nonempty(x.workId) && nonempty(x.documentRootId) && nonempty(x.connectionId) && works.includes(x.workId))) invalidFormal();
  if (!unique(chats.map(x => (x as LegacyChatLink).chatId))) invalidFormal();
  return value as FormalV1;
}
function validateV2(value: unknown): Formal {
  if (!isRecord(value) || value.schema !== 2) invalidFormal();
  const data = value as Record<string, unknown>;
  validateCommon(data);
  const works = data.works as string[];
  const chats = data.chats as unknown[];
  const pins = data.pins as Record<string, unknown>;
  if (!chats.every(x => isRecord(x) && nonempty(x.chatId)
    // Explicit null extends modern v2 only; migrated legacy identities stay Work-owned.
    && (x.workId === null
      ? x.adapter !== 'unresolved' && x.state !== 'source-unknown' && x.legacyCandidateId === undefined && x.legacyBridgeUrl === undefined
      : nonempty(x.workId) && works.includes(x.workId))
    && nonempty(x.documentRootId) && nonempty(x.connectionId) && typeof x.adapter === 'string' && ['serve', 'studio', 'legacy-api', 'unresolved'].includes(x.adapter)
    && nonempty(x.profile) && stringOrNull(x.storedSessionId) && stringOrNull(x.installId) && nonempty(x.title)
    && typeof x.state === 'string' && ['creating', 'pending', 'ready', 'unknown', 'source-unknown'].includes(x.state)
    && (x.legacyCandidateId === undefined || nonempty(x.legacyCandidateId))
    && (x.legacyBridgeUrl === undefined || nonempty(x.legacyBridgeUrl))
    && (x.state !== 'source-unknown' || (x.adapter === 'unresolved' && x.storedSessionId === null && nonempty(x.legacyCandidateId)
      && (x.legacyBridgeUrl === undefined || x.legacyBridgeUrl === x.connectionId)))
    && (x.state !== 'ready' || (x.adapter !== 'unresolved' && nonempty(x.storedSessionId)))
    && !(x.adapter === 'serve' && x.state === 'ready' && !nonempty(x.installId)))) invalidFormal();
  if (!unique(chats.map(x => (x as ChatLink).chatId))) invalidFormal();
  for (const key of Object.keys(pins)) if (!chats.some(x => (x as ChatLink).chatId === key)) invalidFormal();
  return value as Formal;
}

export class WorkStore {
  private mutations: Promise<unknown> = Promise.resolve();
  private migration: Promise<Formal> | null = null;
  constructor(private readonly storage: StoragePort) {}

  private async formal(): Promise<Formal> {
    const value = await this.storage.loadData(FORMAL);
    if (!missing(value)) return structuredClone(validateV2(value));
    if (!this.migration) this.migration = this.migrateV1().finally(() => { this.migration = null; });
    return structuredClone(await this.migration);
  }
  private async migrateV1(): Promise<Formal> {
    const legacy = await this.storage.loadData(FORMAL_V1);
    const migrated = missing(legacy) ? emptyFormal() : (() => {
      const old = validateV1(legacy);
      const chats: ChatLink[] = old.chats.map(x => ({ ...x, adapter: 'unresolved', profile: 'default', storedSessionId: null, legacyCandidateId: x.chatId, legacyBridgeUrl: x.connectionId, installId: null, state: 'source-unknown', title: 'Hermes 对话' }));
      return { schema: 2 as const, works: structuredClone(old.works), chats, tasks: structuredClone(old.tasks), pins: structuredClone(old.pins) };
    })();
    validateV2(migrated);
    await this.storage.saveData(FORMAL, migrated);
    return migrated;
  }
  private async saveFormal(data: Formal): Promise<void> {
    validateV2(data);
    await this.storage.saveData(FORMAL, data);
  }
  private async resume(): Promise<Resume> {
    const value = await this.storage.loadData(RESUME);
    return isRecord(value) && value.schema === 1 && isRecord(value.items) ? value as Resume : emptyResume();
  }
  private async pending(): Promise<Pending> {
    const value = await this.storage.loadData(PENDING);
    if (value === undefined || value === null || value === '') return emptyPending();
    if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.items)) throw new Error('未决操作数据损坏；已停止写入');
    return structuredClone(value as Pending);
  }
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(task, task);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }
  async listWorks(): Promise<string[]> { return [...(await this.formal()).works]; }
  async registerWork(workId: string): Promise<void> {
    await this.enqueue(async () => { const data = await this.formal(); if (!data.works.includes(workId)) { data.works.push(workId); await this.saveFormal(data); } });
  }
  async listChats(workId: string): Promise<ChatLink[]> { return (await this.formal()).chats.filter(x => x.workId === workId); }
  async listDocumentChats(documentRootId: string): Promise<ChatLink[]> { return (await this.formal()).chats.filter(x => x.workId === null && x.documentRootId === documentRootId); }
  async chatLink(chatId: string): Promise<ChatLink | null> { return (await this.formal()).chats.find(x => x.chatId === chatId) ?? null; }
  async linkChat(link: ChatLink | LegacyChatLink): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.formal(); const existing = data.chats.find(x => x.chatId === link.chatId);
      if (existing) {
        if (existing.workId !== link.workId || existing.documentRootId !== link.documentRootId || existing.connectionId !== link.connectionId
          || ('adapter' in link && (existing.adapter !== link.adapter || existing.profile !== link.profile
            || existing.storedSessionId !== link.storedSessionId || existing.installId !== link.installId))) throw new Error('Chat 已有主 Work 或绑定根，不能覆盖');
        return;
      }
      if (link.workId === null) {
        if (!('adapter' in link)) invalidFormal();
      } else if (!data.works.includes(link.workId)) throw new Error('Work 不存在');
      const next: ChatLink = 'adapter' in link ? { ...link } : { ...link, adapter: 'unresolved', profile: 'default', storedSessionId: null, legacyCandidateId: link.chatId, legacyBridgeUrl: link.connectionId, installId: null, state: 'source-unknown', title: 'Hermes 对话' };
      data.chats.push(next); await this.saveFormal(data);
    });
  }
  async confirmChatSession(expected: ChatLink, storedSessionId: string): Promise<ChatLink> {
    return this.enqueue(async () => {
      const data = await this.formal();
      const current = data.chats.find(x => x.chatId === expected.chatId);
      if (!current || !nonempty(storedSessionId) || current.workId !== expected.workId || current.documentRootId !== expected.documentRootId
        || current.connectionId !== expected.connectionId || current.adapter !== expected.adapter || current.profile !== expected.profile
        || current.installId !== expected.installId || (current.storedSessionId !== null && current.storedSessionId !== storedSessionId)
        || !['pending','ready'].includes(current.state)) throw new Error('Chat 持久会话身份与正式关系不符；已停止写入');
      const confirmed = { ...current, storedSessionId, state:'ready' as const };
      if (current.state !== 'ready' || current.storedSessionId !== storedSessionId) {
        data.chats[data.chats.indexOf(current)] = confirmed;
        await this.saveFormal(data);
      }
      return confirmed;
    });
  }
  async resolveLegacyChat(chatId: string, classification: LegacyChatClassification, sourceBridgeUrl: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.formal();
      const link = data.chats.find(x => x.chatId === chatId);
      if (!link || classification.chatId !== chatId || classification.documentRootId !== link.documentRootId
        || sourceBridgeUrl !== (link.legacyBridgeUrl || (link.state === 'source-unknown' ? link.connectionId : undefined)) || !nonempty(link.legacyCandidateId)
        || classification.storedSessionId !== link.legacyCandidateId
        || classification.profile !== 'default' || classification.installId !== null
        || !((classification.adapter === 'studio' && classification.connectionId === 'studio-default')
          || (classification.adapter === 'legacy-api' && classification.connectionId === 'legacy-api'))) throw new Error('旧 Chat 来源证据不符；已停止写入');
      if (link.state !== 'source-unknown') {
        if (link.adapter === classification.adapter && link.connectionId === classification.connectionId && link.profile === classification.profile && link.storedSessionId === classification.storedSessionId && link.installId === classification.installId) return;
        throw new Error('旧 Chat 来源已有不同分类；已停止写入');
      }
      const index = data.chats.indexOf(link);
      data.chats[index] = { ...link, legacyBridgeUrl: sourceBridgeUrl, adapter: classification.adapter, connectionId: classification.connectionId, profile: classification.profile, storedSessionId: classification.storedSessionId, installId: classification.installId, state: 'ready' };
      await this.saveFormal(data);
    });
  }
  async assertChatSendable(chatId: string): Promise<ChatLink> {
    const link = await this.chatLink(chatId);
    if (!link || link.adapter === 'unresolved' || link.state !== 'ready') throw new Error('Chat 来源或结果待确认，不能发送');
    return link;
  }
  async getPins(chatId: string): Promise<ContextRef[]> { return [...((await this.formal()).pins[chatId] ?? [])]; }
  async setPins(chatId: string, refs: ContextRef[]): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.formal();
      if (!data.chats.some(x => x.chatId === chatId)) throw new Error('Chat 未正式关联');
      data.pins[chatId] = refs.map(x => ({ ...x })); await this.saveFormal(data);
    });
  }
  async linkTask(link: TaskLink, guard?: { validate: () => Promise<void>; checkCurrent: () => void }): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.formal();
      if (guard) { await guard.validate(); guard.checkCurrent(); }
      const existing = data.tasks.find(x => x.taskId === link.taskId && x.connectionId === link.connectionId);
      if (existing) { if (existing.workId !== link.workId) throw new Error('Task 已有主 Work'); return; }
      if (!data.works.includes(link.workId)) throw new Error('Work 不存在');
      data.tasks.push(link); await this.saveFormal(data);
    });
  }
  async listTasks(workId: string): Promise<TaskLink[]> { return (await this.formal()).tasks.filter(x => x.workId === workId); }
  async getResume(workId: string): Promise<ResumeState | null> { return (await this.resume()).items[workId] ?? null; }
  async listResume(): Promise<ResumeState[]> { return Object.values((await this.resume()).items); }
  async saveResume(state: ResumeState): Promise<void> {
    await this.enqueue(async () => { const data = await this.resume(); data.items[state.workId] = { ...state }; await this.storage.saveData(RESUME, data); });
  }
  async listPending(): Promise<PendingOperation[]> { return [...(await this.pending()).items]; }
  async setPending(item: PendingOperation): Promise<void> {
    await this.enqueue(async () => { const data = await this.pending(); data.items = [...data.items.filter(x => x.id !== item.id), item]; await this.storage.saveData(PENDING, data); });
  }
  async clearPending(id: string): Promise<void> {
    await this.enqueue(async () => { const data = await this.pending(); data.items = data.items.filter(x => x.id !== id); await this.storage.saveData(PENDING, data); });
  }
}
