import { isValidDocumentRootId } from '../core.ts';
import type { StoragePort } from './store.ts';

export type RoomScope = { workId: string; documentRootId?: never } | { workId: null; documentRootId: string };
export const validRoomScope = (value: { workId?: unknown; documentRootId?: unknown }): boolean =>
  value.workId === null ? isValidDocumentRootId(value.documentRootId) :
    typeof value.workId === 'string' && value.workId.trim().length > 0 && !Object.hasOwn(value, 'documentRootId');
export const sameRoomScope = (a: { workId: string | null; documentRootId?: string }, b: { workId: string | null; documentRootId?: string }) =>
  a.workId === b.workId && (a.workId !== null || a.documentRootId === b.documentRootId);
export const roomScopeFields = (scope: RoomScope): RoomScope => scope.workId === null
  ? { workId: null, documentRootId: scope.documentRootId } : { workId: scope.workId };
export const roomScopeKey = (scope: RoomScope) => JSON.stringify(scope.workId === null ? ['document', scope.documentRootId] : ['work', scope.workId]);

export type RoomLink = RoomScope & {
  connectionId: string;
  deviceId: string;
  accountUserId: number;
  roomId: string;
  roomNameAtLink: string;
};

type RoomData = { schema: 1; links: RoomLink[] };
const KEY = 'work-rooms-v1';
const empty = (): RoomData => ({ schema: 1, links: [] });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const LINK_FIELDS = ['workId', 'connectionId', 'deviceId', 'accountUserId', 'roomId', 'roomNameAtLink'] as const;
const isLink = (value: unknown): value is RoomLink => isRecord(value) &&
  validRoomScope(value) && nonEmpty(value.connectionId) && nonEmpty(value.deviceId) &&
  Number.isSafeInteger(value.accountUserId) && (value.accountUserId as number) > 0 &&
  nonEmpty(value.roomId) && nonEmpty(value.roomNameAtLink);
const isStoredLink = (value: unknown): value is RoomLink => isLink(value) &&
  Object.keys(value).length === LINK_FIELDS.length + (value.workId === null ? 1 : 0) && LINK_FIELDS.every(field => Object.hasOwn(value, field));
const sameKey = (a: RoomLink, b: RoomScope & Pick<RoomLink, 'connectionId' | 'roomId'>) =>
  sameRoomScope(a, b) && a.connectionId === b.connectionId && a.roomId === b.roomId;
const sameIdentity = (a: RoomLink, b: Pick<RoomLink, 'deviceId' | 'accountUserId'>) =>
  a.deviceId === b.deviceId && a.accountUserId === b.accountUserId;
const copyLink = (link: RoomLink): RoomLink => ({
  ...roomScopeFields(link),
  connectionId: link.connectionId,
  deviceId: link.deviceId,
  accountUserId: link.accountUserId,
  roomId: link.roomId,
  roomNameAtLink: link.roomNameAtLink,
});

export class RoomLinkStore {
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: StoragePort, private readonly listWorks: () => Promise<string[]>) {}

  private async data(): Promise<RoomData> {
    const value = await this.storage.loadData(KEY);
    if (value === undefined || value === null || value === '') return empty();
    if (!isRecord(value) || value.schema !== 1 || !Array.isArray(value.links)) {
      throw new Error('房间关系数据损坏或版本不兼容；已停止写入，请先恢复备份');
    }
    const links: unknown[] = value.links;
    if (!links.every(isStoredLink) ||
        links.some((item, index) => links.slice(0, index).some(prior =>
          sameKey(prior, item) ||
          (prior.connectionId === item.connectionId && !sameIdentity(prior, item))))) {
      throw new Error('房间关系数据损坏或版本不兼容；已停止写入，请先恢复备份');
    }
    return value as RoomData;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(task, task);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }

  async listForWork(workId: string): Promise<RoomLink[]> {
    return (await this.data()).links.filter(item => item.workId === workId).map(copyLink);
  }

  async listForDocument(documentRootId: string): Promise<RoomLink[]> {
    if (!isValidDocumentRootId(documentRootId)) throw new Error('当前文档无效');
    return (await this.data()).links.filter(item => item.workId === null && item.documentRootId === documentRootId).map(copyLink);
  }

  async linkRoom(link: RoomLink): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.data();
      if (!isLink(link)) throw new Error('房间关联信息无效');
      if (link.workId !== null && !(await this.listWorks()).includes(link.workId)) throw new Error('Work 不存在');
      if (data.links.some(item => item.connectionId === link.connectionId && !sameIdentity(item, link))) {
        throw new Error('房间关联身份冲突，请核对连接和账号');
      }
      const existing = data.links.find(item => sameKey(item, link));
      if (existing) {
        if (!sameIdentity(existing, link)) throw new Error('房间关联身份冲突，请核对连接和账号');
        return;
      }
      data.links.push(copyLink(link));
      await this.storage.saveData(KEY, data);
    });
  }

  async unlinkRoom(link: RoomLink): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.data();
      if (!isLink(link)) throw new Error('房间关联信息无效');
      const existing = data.links.find(item => sameKey(item, link));
      if (!existing) return;
      if (!sameIdentity(existing, link)) throw new Error('房间关联身份冲突，请核对连接和账号');
      data.links = data.links.filter(item => !sameKey(item, link));
      await this.storage.saveData(KEY, data);
    });
  }

  async assertLinked(workId: string | null, identity: Pick<RoomLink, 'connectionId' | 'deviceId' | 'accountUserId'>, roomId: string, documentRootId?: string): Promise<RoomLink> {
    const link = (await this.data()).links.find(item => sameKey(item, { ...(workId === null ? { workId: null, documentRootId: documentRootId! } : { workId }), connectionId: identity.connectionId, roomId }));
    if (!link || !sameIdentity(link, identity)) throw new Error('当前范围与房间未关联或连接身份不符');
    return copyLink(link);
  }
}
