import type { StoragePort } from '../work/store.ts';
import { roomScopeFields, roomScopeKey, validRoomScope, type RoomScope, type RoomLink } from '../work/room-store.ts';

export type PendingRoomSend = RoomScope & Pick<RoomLink, 'connectionId' | 'deviceId' | 'accountUserId' | 'roomId'> & {
  clientMessageId: string;
  state: 'unknown';
};
type Data = { schema: 1; items: PendingRoomSend[] };
const KEY = 'ekko-send-pending-v1';
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const fields = ['workId', 'connectionId', 'deviceId', 'accountUserId', 'roomId', 'clientMessageId', 'state'] as const;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const safeString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
const valid = (value: unknown): value is PendingRoomSend => record(value) &&
  Object.keys(value).length === fields.length + (value.workId === null ? 1 : 0) && fields.every(field => Object.hasOwn(value, field)) &&
  validRoomScope(value) && (value.workId === null || safeString(value.workId)) && safeString(value.connectionId) && safeString(value.deviceId) &&
  Number.isSafeInteger(value.accountUserId) && (value.accountUserId as number) > 0 &&
  typeof value.roomId === 'string' && ID.test(value.roomId) &&
  typeof value.clientMessageId === 'string' && ID.test(value.clientMessageId) && value.state === 'unknown';
const roomKey = (item: RoomScope & Pick<PendingRoomSend, 'connectionId' | 'roomId'>) => `${roomScopeKey(item)}\u0000${item.connectionId}\u0000${item.roomId}`;
const sameIdentity = (a: PendingRoomSend, b: Pick<PendingRoomSend, 'deviceId' | 'accountUserId'>) =>
  a.deviceId === b.deviceId && a.accountUserId === b.accountUserId;
const copy = (item: PendingRoomSend): PendingRoomSend => ({ ...item });

/** Only stores the identifier needed to reconcile an uncertain send; never the message body. */
export class PendingRoomSendStore {
  private mutations: Promise<unknown> = Promise.resolve();
  constructor(private readonly storage: StoragePort) {}

  private async data(): Promise<Data> {
    const value = await this.storage.loadData(KEY);
    if (value === undefined || value === null || value === '') return { schema: 1, items: [] };
    if (!record(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'schema') || !Object.hasOwn(value, 'items') ||
        value.schema !== 1 || !Array.isArray(value.items)) {
      throw new Error('EKKO 未决发送记录损坏或版本不兼容；已停止覆盖，请恢复备份');
    }
    const items: unknown[] = value.items;
    if (!items.every(valid) || items.some((item, index) =>
      items.slice(0, index).some(prior => valid(prior) && valid(item) &&
        (roomKey(prior) === roomKey(item) || prior.connectionId === item.connectionId && !sameIdentity(prior, item))))) {
      throw new Error('EKKO 未决发送记录损坏或版本不兼容；已停止覆盖，请恢复备份');
    }
    return { schema: 1, items: items.map(item => copy(item as PendingRoomSend)) };
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation, operation);
    this.mutations = next.then(() => undefined, () => undefined);
    return next;
  }
  async get(link: RoomLink): Promise<PendingRoomSend | null> {
    const item = (await this.data()).items.find(row => roomKey(row) === roomKey(link));
    if (!item) return null;
    if (!sameIdentity(item, link)) throw new Error('EKKO 未决发送记录身份与房间关系不一致；请核对备份');
    return copy(item);
  }
  async remember(link: RoomLink, clientMessageId: string): Promise<void> {
    await this.enqueue(async () => {
      const item: PendingRoomSend = { ...roomScopeFields(link), connectionId: link.connectionId, deviceId: link.deviceId,
        accountUserId: link.accountUserId, roomId: link.roomId, clientMessageId, state: 'unknown' };
      if (!valid(item)) throw new Error('EKKO 未决发送标识无效');
      const data = await this.data();
      if(data.items.some(row => row.connectionId === item.connectionId && !sameIdentity(row,item))) throw new Error('EKKO 未决发送记录连接身份冲突，已停止覆盖');
      const prior = data.items.find(row => roomKey(row) === roomKey(item));
      if (prior) {
        if (!sameIdentity(prior, item) || prior.clientMessageId !== clientMessageId) throw new Error('EKKO 上一条发送仍未决，已停止覆盖');
        return;
      }
      data.items.push(item);
      await this.storage.saveData(KEY, data);
    });
  }
  async clear(link: RoomLink, clientMessageId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.data();
      const prior = data.items.find(row => roomKey(row) === roomKey(link));
      if (!prior) return;
      if (!sameIdentity(prior, link) || prior.clientMessageId !== clientMessageId) throw new Error('EKKO 未决发送标识不一致，已停止覆盖');
      data.items = data.items.filter(row => roomKey(row) !== roomKey(link));
      await this.storage.saveData(KEY, data);
    });
  }
}
