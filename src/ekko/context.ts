import { buildContextPayload, refreshSelection, type LoadedContext } from '../work/context.ts';
import { validRoomScope, type RoomLink } from '../work/room-store.ts';

const MAX_SEND_CHARS = 120_000;
const ID = /^[A-Za-z0-9_-]{1,160}$/;

export type SelectedRoomSource =
  | { kind: 'document'; documentId: string }
  | { kind: 'block'; documentId: string; blockId: string }
  | { kind: 'selection'; documentId: string; blockId: string; selectedText: string; originalBlock: string };
export type SelectedRoomAgent = { roomId: string; agentId: string; name: string };
export type RoomReply = Readonly<{ roomId: string; messageId: string; senderName: string; content: string }>;
export type RoomMention = { type: 'agent'; participantId: string; displayName: string };
export type PrepareRoomSendInput = {
  workId: string | null;
  roomLink: RoomLink;
  documentRootId: string;
  text: string;
  selectedSources: SelectedRoomSource[];
  selectedAgents?: SelectedRoomAgent[];
  reply?: RoomReply;
  loadSource: (source: SelectedRoomSource) => Promise<LoadedContext>;
};
export type FrozenRoomSend = Readonly<{
  workId: string | null;
  roomLink: Readonly<RoomLink>;
  documentRootId: string;
  text: string;
  selectedSources: ReadonlyArray<Readonly<SelectedRoomSource>>;
  selectedAgents: ReadonlyArray<Readonly<SelectedRoomAgent>>;
  sources: ReadonlyArray<Readonly<LoadedContext>>;
  reply?: RoomReply;
  content: string;
  mentions: ReadonlyArray<Readonly<RoomMention>>;
  clientMessageId: string;
}>;
export type CurrentRoomSend = Pick<PrepareRoomSendInput, 'workId' | 'roomLink' | 'documentRootId' | 'text' | 'selectedSources' | 'selectedAgents' | 'reply'> & {
  // When sources were selected, the caller must re-read and normalize them just before submit.
  loadedSources?: ReadonlyArray<Readonly<LoadedContext>>;
};

const sourceKey = (source: SelectedRoomSource) => `${source.kind}:${source.documentId}:${source.kind === 'document' ? '' : source.blockId}`;
const copySource = (source: SelectedRoomSource): SelectedRoomSource => ({ ...source });
const copyLoaded = (source: LoadedContext): LoadedContext => ({ ...source });
const copyLink = (link: RoomLink): RoomLink => ({ ...link });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
// Keep source-authored quote tags readable without letting them delimit the outer source quote.
const escapeSourceQuoteTags = (context: string) => context.replace(/<(?=\s*\/?\s*quoted_message(?=[\s/>]))/gi, '&lt;');

function checkedAgents(agents: SelectedRoomAgent[], roomId: string): { selected: SelectedRoomAgent[]; mentions: RoomMention[] } {
  const used = new Set<string>();
  const selected: SelectedRoomAgent[] = [];
  const mentions: RoomMention[] = [];
  for (const agent of agents) {
    if (!agent || agent.roomId !== roomId || !ID.test(agent.agentId) || !agent.name?.trim() || /[\r\n@]/.test(agent.name) || used.has(agent.agentId)) {
      throw new Error('所选 Agent 与当前房间不一致，请重新核对');
    }
    used.add(agent.agentId);
    selected.push({ roomId, agentId: agent.agentId, name: agent.name });
    mentions.push({ type: 'agent', participantId: agent.agentId, displayName: agent.name });
  }
  return { selected, mentions };
}

function checkedLoaded(source: SelectedRoomSource, loaded: LoadedContext): LoadedContext {
  if (!loaded || loaded.documentId !== source.documentId || !loaded.title?.trim() || typeof loaded.text !== 'string' ||
      loaded.kind !== (source.kind === 'selection' ? 'block' : source.kind) ||
      (source.kind !== 'document' && loaded.blockId !== source.blockId)) {
    throw new Error('资料与选定文档或范围不一致，请重新核对');
  }
  if (source.kind === 'selection') {
    return { documentId: source.documentId, title: loaded.title, kind: 'selection', blockId: source.blockId,
      text: refreshSelection(source, loaded.text) };
  }
  return copyLoaded(loaded);
}

export async function prepareRoomSend(input: PrepareRoomSendInput): Promise<FrozenRoomSend> {
  if (!input.roomLink || !validRoomScope(input.roomLink) || input.roomLink.workId !== input.workId ||
      (input.workId === null && input.roomLink.documentRootId !== input.documentRootId) || !input.documentRootId || !input.roomLink.roomId ||
      !input.roomLink.connectionId || !input.roomLink.deviceId || !Number.isSafeInteger(input.roomLink.accountUserId) ||
      typeof input.text !== 'string' || !Array.isArray(input.selectedSources) || !Array.isArray(input.selectedAgents ?? [])) {
    throw new Error('Work、文档或房间身份无效，请重新核对');
  }
  const workId = input.workId;
  const documentRootId = input.documentRootId;
  const roomLink = copyLink(input.roomLink);
  const selectedSources = input.selectedSources.map(copySource);
  const keys = selectedSources.map(sourceKey);
  if (new Set(keys).size !== keys.length) throw new Error('本轮资料存在重复选择，请重新核对');
  const { selected: selectedAgents, mentions } = checkedAgents(input.selectedAgents ?? [], roomLink.roomId);
  const reply = input.reply ? Object.freeze({ ...input.reply }) : undefined;
  if (reply && (reply.roomId !== roomLink.roomId || !reply.messageId || typeof reply.senderName !== 'string' || typeof reply.content !== 'string' || !reply.content.trim())) throw new Error('引用与当前房间不一致，请重新选择引用');
  const text = input.text;
  const loadSource = input.loadSource;
  const loaded: LoadedContext[] = [];
  for (const source of selectedSources) {
    if (!source || !source.documentId || (source.kind !== 'document' && (!source.blockId || !ID.test(source.blockId))) ||
        !['document', 'block', 'selection'].includes(source.kind)) throw new Error('本轮资料范围无效，请重新选择');
    if (workId === null && source.documentId !== documentRootId) throw new Error('独立文档仅可选择当前文档或选区资料');
    // A selection reads its full original block again, then refreshSelection confines the payload to the selected text.
    const fresh = await loadSource(source);
    loaded.push(checkedLoaded(source, fresh));
  }
  if (workId !== input.workId || documentRootId !== input.documentRootId || !same(roomLink, input.roomLink) ||
      text !== input.text || !same(selectedSources, input.selectedSources) ||
      !same(selectedAgents, input.selectedAgents ?? []) || !same(reply, input.reply)) {
    throw new Error('读取资料期间 Work、文档、房间、账号、勾选项或草稿已变化；请重新核对后发送，草稿保持不变');
  }
  const mentionText = selectedAgents.map(agent => `@${agent.name}`).join(' ');
  const message = mentionText ? `${mentionText}${text ? ` ${text}` : ''}` : text;
  if (!message.trim()) throw new Error('请输入房间消息');
  // Both document context and explicit replies use Ekko's existing inert quote boundary.
  const parts: string[] = [];
  if (reply) parts.push(escapeSourceQuoteTags(`【引用：${reply.senderName}】\n${reply.content}`));
  if (loaded.length) parts.push(escapeSourceQuoteTags(buildContextPayload(loaded, MAX_SEND_CHARS)));
  const content = message + (parts.length ? `\n\n<quoted_message>\n${parts.join('\n\n')}\n</quoted_message>` : '');
  if (content.length > MAX_SEND_CHARS) throw new Error('消息超过本次 120000 字符上限；请缩小范围');
  const clientMessageId = crypto.randomUUID();
  return Object.freeze({ workId, roomLink: Object.freeze(roomLink), documentRootId,
    text, reply, selectedSources: Object.freeze(selectedSources.map(source => Object.freeze(source))),
    selectedAgents: Object.freeze(selectedAgents.map(agent => Object.freeze(agent))),
    sources: Object.freeze(loaded.map(source => Object.freeze(source))), content,
    mentions: Object.freeze(mentions.map(mention => Object.freeze(mention))), clientMessageId });
}

export function assertRoomSendCurrent(frozen: FrozenRoomSend, current: CurrentRoomSend): void {
  if (frozen.workId !== current.workId || frozen.documentRootId !== current.documentRootId ||
      !same(frozen.roomLink, current.roomLink) || frozen.text !== current.text ||
      !same(frozen.selectedSources, current.selectedSources) ||
      !same(frozen.selectedAgents, current.selectedAgents ?? []) || !same(frozen.reply, current.reply) ||
      (frozen.sources.length > 0 && !same(frozen.sources, current.loadedSources))) {
    throw new Error('发送前 Work、文档、房间、账号、资料、Agent 或草稿已变化；已停止发送，请重新核对，草稿保持不变');
  }
}
