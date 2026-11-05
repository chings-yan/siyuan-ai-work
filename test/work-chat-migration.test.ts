import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkStore } from '../src/work/store.ts';

function storage(seed: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(seed));
  const writes: string[] = [];
  return { values, writes,
    loadData: async (key: string) => values.get(key),
    saveData: async (key: string, value: unknown) => { writes.push(key); values.set(key, structuredClone(value)); },
  };
}

const oldLink = { chatId: 'old-id', workId: 'work-1', documentRootId: 'doc-1', connectionId: 'http://127.0.0.1:8782' };
const v1 = () => ({ schema: 1, works: ['work-1'], chats: [oldLink], tasks: [{ taskId: 'task-1', workId: 'work-1', connectionId: 'task-plugin' }], pins: { 'old-id': [{ documentId: 'doc-2', blockId: null, kind: 'document' }] } });

test('v1 migration creates strict v2 while preserving old bytes, pins, tasks and Resume', async () => {
  const original = v1();
  const disk = storage({ 'work-formal-v1': original, 'work-resume-v1': { schema: 1, items: { 'work-1': { workId: 'work-1', documentId: 'doc-2', focusBlockId: null, chatId: 'old-id', taskId: null, updatedAt: 'now' } } } });
  const before = JSON.stringify(original);
  const store = new WorkStore(disk);
  const links = await store.listChats('work-1');
  assert.deepEqual(links[0], { ...oldLink, adapter: 'unresolved', profile: 'default', storedSessionId: null, legacyCandidateId: 'old-id', legacyBridgeUrl: oldLink.connectionId, installId: null, state: 'source-unknown', title: 'Hermes 对话' });
  assert.equal(JSON.stringify(disk.values.get('work-formal-v1')), before);
  assert.equal((disk.values.get('work-formal-v2') as any).schema, 2);
  assert.equal((await store.getPins('old-id'))[0].documentId, 'doc-2');
  assert.equal((await store.listTasks('work-1'))[0].taskId, 'task-1');
  assert.equal((await store.getResume('work-1'))?.chatId, 'old-id');
  assert.deepEqual(disk.writes, ['work-formal-v2']);
});

test('legacy classification changes only the matching chat and rejects mismatched evidence', async () => {
  const disk = storage({ 'work-formal-v1': v1() });
  const store = new WorkStore(disk);
  await store.listChats('work-1');
  const correct = { chatId: 'old-id', connectionId: 'studio-default', adapter: 'studio' as const, profile: 'default', storedSessionId: 'old-id', documentRootId: 'doc-1', installId: null };
  await assert.rejects(store.resolveLegacyChat('old-id', { ...correct, documentRootId: 'other' }, oldLink.connectionId), /不符|不一致|来源/);
  await assert.rejects(store.resolveLegacyChat('old-id', { ...correct, storedSessionId: 'other' }, oldLink.connectionId), /不符|不一致|来源/);
  await assert.rejects(store.resolveLegacyChat('old-id', correct, 'http://127.0.0.1:9999'), /不符|不一致|来源/);
  await assert.rejects(store.resolveLegacyChat('old-id', { ...correct, connectionId: 'serve-local' }, oldLink.connectionId), /不符|不一致|来源/);
  await assert.rejects(store.resolveLegacyChat('old-id', { ...correct, adapter: 'serve' as 'studio' }, oldLink.connectionId), /不符|不一致|来源/);
  await assert.rejects(store.resolveLegacyChat('old-id', { ...correct, profile: 'other' }, oldLink.connectionId), /不符|不一致|来源/);
  await assert.rejects(store.resolveLegacyChat('old-id', { ...correct, installId: 'forged-install' as unknown as null }, oldLink.connectionId), /不符|不一致|来源/);
  assert.equal((await store.chatLink('old-id'))?.state, 'source-unknown');
  await store.resolveLegacyChat('old-id', correct, oldLink.connectionId);
  const writesAfterFirstClassification = disk.writes.length;
  await store.resolveLegacyChat('old-id', correct, oldLink.connectionId);
  assert.equal(disk.writes.length, writesAfterFirstClassification);
  await assert.rejects(store.resolveLegacyChat('old-id', correct, 'http://127.0.0.1:9999'), /不符|不一致|来源/);
  assert.equal((await store.chatLink('old-id'))?.adapter, 'studio');
  assert.equal((await store.chatLink('old-id'))?.storedSessionId, 'old-id');
  assert.equal((await store.chatLink('old-id'))?.state, 'ready');
  assert.deepEqual(disk.values.get('work-formal-v1'), v1());
});

test('source-unknown v2 with conflicting original Bridge URLs is rejected without overwrite', async () => {
  const corrupt = { schema: 2, works: ['work-1'], chats: [{ ...oldLink, adapter: 'unresolved', profile: 'default', storedSessionId: null, legacyCandidateId: 'old-id', legacyBridgeUrl: 'http://127.0.0.1:9999', installId: null, state: 'source-unknown', title: 'Hermes 对话' }], tasks: [], pins: {} };
  const disk = storage({ 'work-formal-v2': corrupt });
  const before = structuredClone(corrupt);
  const store = new WorkStore(disk);
  await assert.rejects(store.listChats('work-1'), /正式关系数据/);
  await assert.rejects(store.registerWork('work-2'), /正式关系数据/);
  assert.deepEqual(disk.values.get('work-formal-v2'), before);
  assert.deepEqual(disk.writes, []);
});

test('early v2 source-unknown record without legacyBridgeUrl uses its original connectionId', async () => {
  const early = { schema: 2, works: ['work-1'], chats: [{ ...oldLink, adapter: 'unresolved', profile: 'default', storedSessionId: null, legacyCandidateId: 'old-id', installId: null, state: 'source-unknown', title: 'Hermes 对话' }], tasks: [], pins: {} };
  const disk = storage({ 'work-formal-v2': early });
  const store = new WorkStore(disk);
  const classification = { chatId: 'old-id', connectionId: 'studio-default', adapter: 'studio' as const, profile: 'default', storedSessionId: 'old-id', documentRootId: 'doc-1', installId: null };
  await assert.rejects(store.resolveLegacyChat('old-id', classification, 'http://127.0.0.1:9999'), /来源/);
  await store.resolveLegacyChat('old-id', classification, oldLink.connectionId);
  assert.equal((await store.chatLink('old-id'))?.legacyBridgeUrl, oldLink.connectionId);
});

test('bad v1 or v2 never gets replaced by a plausible empty structure', async () => {
  for (const seed of [
    { 'work-formal-v1': { ...v1(), pins: { 'old-id': [null] } } },
    { 'work-formal-v1': v1(), 'work-formal-v2': { schema: 2, works: ['work-1'], chats: [{ chatId: 'bad' }], tasks: [], pins: {} } },
    { 'work-formal-v1': v1(), 'work-formal-v2': null },
  ]) {
    const disk = storage(seed);
    const before = structuredClone([...disk.values]);
    await assert.rejects(new WorkStore(disk).listChats('work-1'), /正式关系数据/);
    assert.deepEqual([...disk.values], before);
    assert.deepEqual(disk.writes, []);
  }
});

test('valid v2 remains authoritative even when the old v1 copy is damaged', async () => {
  const disk = storage({ 'work-formal-v1': { schema: 99 }, 'work-formal-v2': { schema: 2, works: ['work-2'], chats: [], tasks: [], pins: {} } });
  assert.deepEqual(await new WorkStore(disk).listWorks(), ['work-2']);
  assert.deepEqual(disk.writes, []);
});

test('failed v2 migration write leaves the v1 data and Resume untouched', async () => {
  const original = v1();
  const resume = { schema: 1, items: { 'work-1': { workId: 'work-1', documentId: 'doc-2', focusBlockId: null, chatId: 'old-id', taskId: null, updatedAt: 'now' } } };
  const disk = storage({ 'work-formal-v1': original, 'work-resume-v1': resume });
  const store = new WorkStore({ loadData: disk.loadData, saveData: async () => { throw new Error('write failed'); } });
  await assert.rejects(store.listChats('work-1'), /write failed/);
  assert.equal(disk.values.has('work-formal-v2'), false);
  assert.deepEqual(disk.values.get('work-formal-v1'), original);
  assert.deepEqual(disk.values.get('work-resume-v1'), resume);
});

test('two connections may point to the same stored ID under distinct local Chat IDs', async () => {
  const disk = storage();
  const store = new WorkStore(disk);
  await store.registerWork('work-1');
  const base = { workId: 'work-1', documentRootId: 'doc-1', adapter: 'serve' as const, profile: 'default', storedSessionId: 'shared-external', installId: 'install-1', state: 'ready' as const, title: '会话' };
  await store.linkChat({ ...base, chatId: 'local-a', connectionId: 'serve-a' });
  await store.linkChat({ ...base, chatId: 'local-b', connectionId: 'serve-b' });
  assert.deepEqual((await store.listChats('work-1')).map(link => link.chatId), ['local-a', 'local-b']);
  await assert.rejects(store.linkChat({ ...base, chatId: 'local-a', connectionId: 'serve-b' }), /已有主 Work|绑定根|不能覆盖/);
  await assert.rejects(store.linkChat({ ...base, chatId: 'local-a', connectionId: 'serve-a', storedSessionId: 'other-external' }), /已有主 Work|绑定根|不能覆盖/);
});
