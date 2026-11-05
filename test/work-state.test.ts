import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkStore } from '../src/work/store.ts';
import { decideNavigation, resolveCandidates } from '../src/work/navigation.ts';

function storage(seed: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(seed));
  return {
    values,
    loadData: async (key: string) => values.get(key),
    saveData: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
  };
}

test('正式关系损坏时拒绝覆盖，Resume 损坏仅失去最近位置', async () => {
  const broken = storage({ 'work-formal-v1': { schema: 4 } });
  const store = new WorkStore(broken);
  await assert.rejects(store.registerWork('w1'), /正式关系数据/);
  assert.deepEqual(broken.values.get('work-formal-v1'), { schema: 4 });
  assert.equal(broken.values.has('work-formal-v2'), false);

  const safe = storage({ 'work-resume-v1': { schema: 99 } });
  const restored = new WorkStore(safe);
  await restored.registerWork('w1');
  assert.equal(await restored.getResume('w1'), null);
  assert.deepEqual(await restored.listWorks(), ['w1']);
});

test('思源首次读取不存在的插件数据返回空字符串时可以建立 Work', async () => {
  const disk = storage({ 'work-formal-v1': '', 'work-resume-v1': '', 'work-pending-v1': '' });
  const store = new WorkStore(disk);
  assert.deepEqual(await store.listWorks(), []);
  await store.registerWork('w1');
  await store.setPending({ id: 'op1', kind: 'work', workId: 'w1', state: 'unknown', details: 'test', updatedAt: '2026-09-23T00:00:00Z' });
  assert.deepEqual(await store.listWorks(), ['w1']);
  assert.equal((disk.values.get('work-formal-v2') as { schema: number }).schema, 2);
  assert.equal(disk.values.get('work-formal-v1'), '');
  assert.equal((await store.listPending())[0].id, 'op1');
  assert.equal(await store.getResume('w1'), null);
});

test('非空且无效的正式关系仍拒绝覆盖', async () => {
  const disk = storage({ 'work-formal-v1': '{broken' });
  const store = new WorkStore(disk);
  await assert.rejects(store.registerWork('w1'), /正式关系数据/);
  assert.equal(disk.values.get('work-formal-v1'), '{broken');
  assert.equal(disk.values.has('work-formal-v2'), false);
});

test('一个 Chat 只属于一个 Work，正式关系和固定资料跨重启保留', async () => {
  const disk = storage();
  const a = new WorkStore(disk);
  await a.registerWork('w1');
  await a.registerWork('w2');
  await a.linkChat({ chatId: 's1', workId: 'w1', documentRootId: 'd1', connectionId: 'bridge-a' });
  await a.setPins('s1', [{ documentId: 'd2', blockId: null, kind: 'document' }]);
  await a.saveResume({ workId: 'w1', documentId: 'd2', focusBlockId: 'b1', chatId: 's1', taskId: null, updatedAt: '2026-09-23T00:00:00Z' });
  const b = new WorkStore(disk);
  assert.equal((await b.listChats('w1'))[0].chatId, 's1');
  assert.equal((await b.getPins('s1'))[0].documentId, 'd2');
  assert.equal((await b.getResume('w1'))?.focusBlockId, 'b1');
  await assert.rejects(b.linkChat({ chatId: 's1', workId: 'w2', documentRootId: 'd1', connectionId: 'bridge-a' }), /已有主 Work/);
});

test('连续保存 Resume 和正式关系不丢更新', async () => {
  const disk = storage();
  const store = new WorkStore(disk);
  await Promise.all(['a', 'b', 'c'].map(id => store.registerWork(id)));
  assert.deepEqual(await store.listWorks(), ['a', 'b', 'c']);
  await Promise.all(['a', 'b', 'c'].map(id => store.saveResume({ workId: id, documentId: id, focusBlockId: null, chatId: null, taskId: null, updatedAt: '2026-09-23T00:00:00Z' })));
  assert.ok(await store.getResume('b'));
});

test('已点开具体文档时仅恢复侧栏，迟到结果不能抢回旧现场', () => {
  const candidates = resolveCandidates('/w1/child.sy', ['w1', 'w2'], []);
  assert.deepEqual(candidates, ['w1']);
  const decision = decideNavigation({ currentWorkId: null, busy: false, pendingWrite: false }, candidates);
  assert.deepEqual(decision, { kind: 'switch', workId: 'w1', navigateEditor: false });
  assert.deepEqual(decideNavigation({ currentWorkId: 'w2', busy: true, pendingWrite: false }, candidates), { kind: 'keep', workId: 'w2', navigateEditor: false });
  assert.deepEqual(decideNavigation({ currentWorkId: null, busy: false, pendingWrite: false }, ['w1', 'w2']), { kind: 'choose', workIds: ['w1', 'w2'], navigateEditor: false });
});
