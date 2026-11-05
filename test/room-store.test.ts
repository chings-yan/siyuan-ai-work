import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomLinkStore, type RoomLink } from '../src/work/room-store.ts';
import { WorkStore, type ChatLink } from '../src/work/store.ts';

function fixture(seed: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(seed));
  const storage = {
    loadData: async (key: string) => values.get(key),
    saveData: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
  };
  const works = new WorkStore(storage);
  const rooms = new RoomLinkStore(storage, () => works.listWorks());
  return { values, works, rooms, storage };
}

async function fixtureWithFormalRelations() {
  const f = fixture();
  await f.works.registerWork('work-a');
  await f.works.registerWork('work-b');
  const chat: ChatLink = {
    chatId: 'chat-a', workId: 'work-a', documentRootId: '20260928123456-abcdefg',
    connectionId: 'serve-local', adapter: 'serve', profile: 'default',
    storedSessionId: 'session-a', installId: 'installation-a', title: '虚构测试对话', state: 'ready',
  };
  const task = { taskId: 'task-a', workId: 'work-a', connectionId: 'native-task' };
  const pins = [{ documentId: '20260928123456-abcdefg', blockId: null, kind: 'document' as const }];
  await f.works.linkChat(chat);
  await f.works.linkTask(task);
  await f.works.setPins(chat.chatId, pins);
  const expected = { schema: 2, works: ['work-a', 'work-b'], chats: [chat], tasks: [task], pins: { 'chat-a': pins } };
  const formalBefore = structuredClone(f.values.get('work-formal-v2'));
  assert.ok(formalBefore, '正式关系快照必须非空，不能比较两个 undefined');
  assert.deepEqual(formalBefore, expected);
  return { ...f, formalBefore };
}

const link: RoomLink = {
  workId: 'work-a', connectionId: 'connection-a', deviceId: 'device-a',
  accountUserId: 101, roomId: 'room-a', roomNameAtLink: '虚构测试房间',
};

test('同一房间可关联两个已登记 Work，重启后各自可见且不触碰正式关系', async () => {
  const f = await fixtureWithFormalRelations();
  await f.rooms.linkRoom(link);
  await f.rooms.linkRoom({ ...link, workId: 'work-b' });
  const restarted = new RoomLinkStore(f.storage, () => f.works.listWorks());
  assert.deepEqual(await restarted.listForWork('work-a'), [link]);
  assert.deepEqual(await restarted.listForWork('work-b'), [{ ...link, workId: 'work-b' }]);
  assert.deepEqual(f.values.get('work-formal-v2'), f.formalBefore);
});

test('同一 Work、连接、房间重复关联幂等，不能借重复关联更换身份', async () => {
  const f = fixture();
  await f.works.registerWork('work-a');
  await f.rooms.linkRoom(link);
  await f.rooms.linkRoom({ ...link, roomNameAtLink: '新显示名' });
  assert.deepEqual(await f.rooms.listForWork('work-a'), [link]);
  await assert.rejects(f.rooms.linkRoom({ ...link, deviceId: 'device-b' }), /身份|冲突/);
  assert.deepEqual(await f.rooms.listForWork('work-a'), [link]);
});

test('取消一个 Work 的关联不影响另一个，断线状态不会自动清理关系', async () => {
  const f = await fixtureWithFormalRelations();
  await f.rooms.linkRoom(link);
  await f.rooms.linkRoom({ ...link, workId: 'work-b' });
  assert.deepEqual(f.values.get('work-formal-v2'), f.formalBefore);
  await f.rooms.unlinkRoom(link);
  assert.deepEqual(f.values.get('work-formal-v2'), f.formalBefore);
  assert.deepEqual(await f.rooms.listForWork('work-a'), []);
  assert.deepEqual(await f.rooms.listForWork('work-b'), [{ ...link, workId: 'work-b' }]);
  assert.deepEqual(await f.rooms.assertLinked('work-b', { connectionId: 'connection-a', deviceId: 'device-a', accountUserId: 101 }, 'room-a'), { ...link, workId: 'work-b' });
});

test('未登记 Work 禁止关联', async () => {
  const f = fixture();
  await assert.rejects(f.rooms.linkRoom(link), /Work 不存在/);
  assert.equal(f.values.has('work-rooms-v1'), false);
});

test('仅保存约定的关系字段，不把调用方多余字段写入插件数据', async () => {
  const f = fixture();
  await f.works.registerWork('work-a');
  await f.rooms.linkRoom({ ...link, secret: '仅用于测试的虚构值' } as RoomLink);
  assert.deepEqual(await f.rooms.listForWork('work-a'), [link]);
  assert.deepEqual(f.values.get('work-rooms-v1'), { schema: 1, links: [link] });
});

test('已存房间记录含额外字段时拒绝读取和覆盖', async () => {
  const bad = { schema: 1, links: [{ ...link, extra: '不应被重写' }] };
  const f = fixture({ 'work-rooms-v1': bad });
  await f.works.registerWork('work-a');
  await assert.rejects(f.rooms.listForWork('work-a'), /房间关系数据损坏或版本不兼容/);
  await assert.rejects(f.rooms.linkRoom({ ...link, roomId: 'room-b' }), /房间关系数据损坏或版本不兼容/);
  assert.deepEqual(f.values.get('work-rooms-v1'), bad);
});

test('同一连接在另一个 Work 不能改绑设备身份', async () => {
  const f = fixture();
  await f.works.registerWork('work-a');
  await f.works.registerWork('work-b');
  await f.rooms.linkRoom(link);
  await assert.rejects(f.rooms.linkRoom({ ...link, workId: 'work-b', deviceId: 'device-b' }), /身份|冲突/);
  assert.deepEqual(await f.rooms.listForWork('work-b'), []);
  assert.deepEqual(await f.rooms.listForWork('work-a'), [link]);
});

test('同一连接在另一个房间不能改绑账号身份', async () => {
  const f = fixture();
  await f.works.registerWork('work-a');
  await f.rooms.linkRoom(link);
  await assert.rejects(f.rooms.linkRoom({ ...link, roomId: 'room-b', accountUserId: 102 }), /身份|冲突/);
  assert.deepEqual(await f.rooms.listForWork('work-a'), [link]);
});

test('已存同一连接存在两套身份时拒绝继续写入', async () => {
  const bad = { schema: 1, links: [link, { ...link, workId: 'work-b', accountUserId: 102 }] };
  const f = fixture({ 'work-rooms-v1': bad });
  await f.works.registerWork('work-a');
  await f.works.registerWork('work-b');
  await assert.rejects(f.rooms.linkRoom({ ...link, roomId: 'room-b' }), /房间关系数据损坏或版本不兼容/);
  assert.deepEqual(f.values.get('work-rooms-v1'), bad);
});

test('房间存储损坏或版本不兼容时读取和写入均拒绝且原值不变', async () => {
  for (const bad of ['{broken', { schema: 2, links: [] }, { schema: 1, links: [{ ...link, accountUserId: '101' }] }]) {
    const f = fixture({ 'work-rooms-v1': bad });
    await f.works.registerWork('work-a');
    await assert.rejects(f.rooms.listForWork('work-a'), /房间关系数据损坏或版本不兼容/);
    await assert.rejects(f.rooms.linkRoom(link), /房间关系数据损坏或版本不兼容/);
    await assert.rejects(f.rooms.unlinkRoom(link), /房间关系数据损坏或版本不兼容/);
    assert.deepEqual(f.values.get('work-rooms-v1'), bad);
  }
});

test('账号、设备、连接实例变化时拒绝确认；旧关系仍保留', async () => {
  const f = fixture();
  await f.works.registerWork('work-a');
  await f.rooms.linkRoom(link);
  for (const identity of [
    { connectionId: 'connection-b', deviceId: 'device-a', accountUserId: 101 },
    { connectionId: 'connection-a', deviceId: 'device-b', accountUserId: 101 },
    { connectionId: 'connection-a', deviceId: 'device-a', accountUserId: 102 },
  ]) await assert.rejects(f.rooms.assertLinked('work-a', identity, 'room-a'), /未关联|身份/);
  assert.deepEqual(await f.rooms.listForWork('work-a'), [link]);
});

test('并发写入串行化，不丢不同房间或 Work 的关系', async () => {
  const f = fixture();
  await f.works.registerWork('work-a');
  await f.works.registerWork('work-b');
  await Promise.all([
    f.rooms.linkRoom(link),
    f.rooms.linkRoom({ ...link, roomId: 'room-b' }),
    f.rooms.linkRoom({ ...link, workId: 'work-b' }),
  ]);
  assert.equal((await f.rooms.listForWork('work-a')).length, 2);
  assert.equal((await f.rooms.listForWork('work-b')).length, 1);
});
