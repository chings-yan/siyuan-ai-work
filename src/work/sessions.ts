import { ReferenceBasket } from '../references.ts';
import type { ChatThread } from '../chat.ts';
import type { ContextChoice } from './controller.ts';
import type { ChatLink } from './store.ts';
import { sameRoomScope, type RoomLink } from './room-store.ts';

export type SessionChat = ChatLink & { title?: string; local?: boolean };
export type SessionChoice = { kind: 'hermes'; link: SessionChat } | { kind: 'ekko'; link: RoomLink };
export function sessionKey(choice: SessionChoice): string {
  const link = choice.link;
  return JSON.stringify(choice.kind === 'hermes'
    ? ['hermes', link.workId, choice.link.documentRootId, link.connectionId, choice.link.profile, choice.link.installId, choice.link.chatId]
    : choice.link.workId === null
      ? ['ekko', null, choice.link.documentRootId, link.connectionId, choice.link.deviceId, choice.link.accountUserId, choice.link.roomId]
      : ['ekko', link.workId, link.connectionId, choice.link.deviceId, choice.link.accountUserId, choice.link.roomId]);
}
export function sessionChoices(workId: string | null, chats: SessionChat[], rooms: RoomLink[], documentRootId?: string): SessionChoice[] {
  return [...chats.filter(link => link.workId === workId).map(link => ({ kind: 'hermes' as const, link })),
    ...rooms.filter(link => sameRoomScope(link, { workId, documentRootId })).map(link => ({ kind: 'ekko' as const, link }))];
}
export function sessionLabel(choice: SessionChoice): string {
  return choice.kind === 'hermes'
    ? `Hermes · ${choice.link.title || stableChatTitle(choice.link.chatId)}${choice.link.local ? '（本地）' : ` · ${choice.link.adapter==='serve'?'Hermes 服务':choice.link.adapter==='studio'?'Studio':choice.link.adapter==='legacy-api'?'旧 API':'待确认来源'}`}`
    : `EKKO · ${choice.link.roomNameAtLink || '房间'}`;
}
export function stableChatTitle(id:string):string { return `对话 · ${id.slice(-8)}`; }
export function sessionDetails(choice:SessionChoice):string {
 const link=choice.link;
 return choice.kind==='hermes'?`Hermes · ${choice.link.adapter} · ${link.connectionId} · ${choice.link.profile} · ${choice.link.installId||'无安装标识'} · ${choice.link.chatId} · ${choice.link.storedSessionId||'持久会话待确认'} · ${choice.link.state}`: `EKKO · ${link.connectionId} · 房间 ${choice.link.roomId} · 账号 ${choice.link.accountUserId} · 设备 ${choice.link.deviceId}`;
}
export type HermesDraft = { text: string; references: ReferenceBasket; context: ContextChoice; pending?: { kind:'unknown'|'stop-pending'; message:string } };
/** All state is scoped to one plugin lifetime. Credentials are compared privately, never used as UI keys. */
export class SessionMemory {
  private connections: { url: string; token: string; id: string }[] = [];
  private drafts = new Map<string, HermesDraft>();
  private scopes = new Map<string, { threads: ChatThread[]; selected: string }>();
  connection(url: string, token: string): string {
    let found = this.connections.find(item => item.url === url && item.token === token);
    if (!found) { found = { url, token, id: `connection-${this.connections.length + 1}` }; this.connections.push(found); }
    return found.id;
  }
  draft(workId: string, connection: string, chatId: string): HermesDraft {
    const key = JSON.stringify([workId, connection, chatId]);
    let draft = this.drafts.get(key);
    if (!draft) { draft = { text: '', references: new ReferenceBasket(), context: { mode: 'document', documentIds: [] } }; this.drafts.set(key, draft); }
    return draft;
  }
  scope(workId: string, connection: string) {
    const key = JSON.stringify([workId, connection]);
    let scope = this.scopes.get(key);
    if (!scope) { scope = { threads: [], selected: '' }; this.scopes.set(key, scope); }
    return scope;
  }
}
