import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkStore, type ChatLink, type LegacyChatLink } from '../src/work/store.ts';

const FORMAL = 'work-formal-v2';
function storage(seed: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(seed));
  const writes: string[] = [];
  return {
    values, writes,
    loadData: async (key: string) => values.get(key),
    saveData: async (key: string, value: unknown) => { writes.push(key); values.set(key, structuredClone(value)); },
  };
}
function chat(overrides: Partial<ChatLink> = {}): ChatLink {
  return { chatId: 'local-chat-a', workId: null, documentRootId: 'document-a', connectionId: 'serve-a', adapter: 'serve', profile: 'default', storedSessionId: 'session-a', installId: 'install-a', title: '虚构对话', state: 'ready', ...overrides };
}
const formal = (chats: ChatLink[] = [], works: string[] = []) => ({ schema: 2, works, chats, tasks: [], pins: {} });
const bytes = (disk: ReturnType<typeof storage>) => JSON.stringify([...disk.values]);

// Compile-time coverage: the modern extension must not relax legacy input.
function legacyRequiresWork() {
  // @ts-expect-error Legacy links require a non-null Work identity.
  const legacy: LegacyChatLink = { chatId: 'legacy', workId: null, documentRootId: 'document-a', connectionId: 'legacy-api' };
  return legacy;
}

test('standalone Chats persist across reinstantiation without creating Works or document records', async () => {
  const disk = storage();
  const store = new WorkStore(disk);
  const first = chat();
  const second = chat({ chatId: 'local-chat-b', documentRootId: 'document-b', storedSessionId: 'session-b' });
  const sameDocument = chat({ chatId: 'local-chat-c', storedSessionId: 'session-c' });
  await Promise.all([first, second, sameDocument].map(link => store.linkChat(link)));
  const restored = new WorkStore(disk);
  assert.deepEqual(await restored.listDocumentChats('document-a'), [first, sameDocument]);
  assert.deepEqual(await restored.listDocumentChats('document-b'), [second]);
  assert.deepEqual(await restored.listDocumentChats('document-a/child'), []);
  assert.deepEqual(await restored.listWorks(), []);
  assert.deepEqual(await restored.listChats('document-a'), []);
  assert.deepEqual(await restored.chatLink(first.chatId), first);
  assert.deepEqual([...disk.values.keys()], [FORMAL]);
  assert.deepEqual(disk.values.get(FORMAL), formal([first, second, sameDocument]));
});

test('document listing excludes Work Chats with the same binding root and returns isolated values', async () => {
  const disk = storage();
  const store = new WorkStore(disk);
  await store.registerWork('work-a');
  const standalone = chat();
  const workChat = chat({ chatId: 'work-chat', workId: 'work-a' });
  await store.linkChat(standalone);
  await store.linkChat(workChat);
  const listed = await store.listDocumentChats('document-a');
  assert.deepEqual(listed, [standalone]);
  assert.deepEqual(await store.listChats('work-a'), [workChat]);
  listed[0].title = 'caller mutation';
  assert.equal((await store.chatLink(standalone.chatId))?.title, standalone.title);
});

for (const adapter of ['serve', 'studio', 'legacy-api'] as const) {
  test(`${adapter} standalone pending confirmation retains null Work and exact session identity`, async () => {
    const disk = storage();
    const store = new WorkStore(disk);
    const pending = chat({ adapter, connectionId: adapter + '-a', installId: adapter === 'serve' ? 'install-a' : null, state: 'pending', storedSessionId: null });
    await store.linkChat(pending);
    await assert.rejects(store.assertChatSendable(pending.chatId), /不能发送/);
    const before = bytes(disk);
    for (const changed of [
      { workId: 'work-a' }, { documentRootId: 'document-b' }, { connectionId: 'other' },
      { adapter: 'unresolved' as const }, { profile: 'other' }, { installId: 'other' },
    ]) {
      await assert.rejects(store.confirmChatSession({ ...pending, ...changed }, 'session-confirmed'), /身份.*不符/);
      assert.equal(bytes(disk), before);
    }
    await assert.rejects(store.confirmChatSession(pending, ''), /身份.*不符/);
    const confirmed = await store.confirmChatSession(pending, 'session-confirmed');
    assert.deepEqual(confirmed, { ...pending, state: 'ready', storedSessionId: 'session-confirmed' });
    const restored = new WorkStore(disk);
    assert.deepEqual(await restored.assertChatSendable(pending.chatId), confirmed);
    const writes = disk.writes.length;
    await restored.confirmChatSession(confirmed, 'session-confirmed');
    assert.equal(disk.writes.length, writes);
    const readyBytes = bytes(disk);
    await assert.rejects(restored.confirmChatSession(confirmed, 'other-session'), /身份.*不符/);
    assert.equal(bytes(disk), readyBytes);
  });
}

test('standalone pins survive restart and remain Chat-scoped', async () => {
  const disk = storage();
  const store = new WorkStore(disk);
  await store.linkChat(chat());
  await store.linkChat(chat({ chatId: 'local-chat-b', documentRootId: 'document-b' }));
  const refs = [{ documentId: 'reference-doc', blockId: null, kind: 'document' as const }];
  await store.setPins('local-chat-a', refs);
  refs[0].documentId = 'caller mutation';
  const restored = new WorkStore(disk);
  assert.deepEqual(await restored.getPins('local-chat-a'), [{ documentId: 'reference-doc', blockId: null, kind: 'document' }]);
  assert.deepEqual(await restored.getPins('local-chat-b'), []);
  const before = bytes(disk);
  await assert.rejects(restored.setPins('missing-chat', []), /未正式关联/);
  await assert.rejects(restored.setPins('local-chat-a', [{ documentId: '', blockId: null, kind: 'document' }]), /正式关系数据/);
  assert.equal(bytes(disk), before);
});

test('standalone binding and source identities cannot be overwritten or promoted to a Work', async () => {
  const disk = storage();
  const store = new WorkStore(disk);
  await store.registerWork('work-a');
  const link = chat();
  await store.linkChat(link);
  const before = bytes(disk);
  const writes = disk.writes.length;
  for (const changed of [
    { workId: 'work-a' }, { documentRootId: 'document-b' }, { connectionId: 'serve-b' },
    { adapter: 'studio' as const }, { profile: 'other' }, { storedSessionId: 'other' }, { installId: 'other' },
  ]) {
    await assert.rejects(store.linkChat({ ...link, ...changed }), /不能覆盖/);
    assert.equal(bytes(disk), before);
  }
  await store.linkChat(link);
  assert.equal(disk.writes.length, writes);
});

test('Work-owned and migrated legacy Chats cannot be moved into standalone scope', async () => {
  const disk = storage();
  const store = new WorkStore(disk);
  await store.registerWork('work-a');
  const modern = chat({ workId: 'work-a' });
  await store.linkChat(modern);
  await store.linkChat({ chatId: 'old-chat', workId: 'work-a', documentRootId: 'document-a', connectionId: 'legacy-bridge' });
  const legacy = (await store.chatLink('old-chat'))!;
  const before = bytes(disk);
  for (const link of [modern, legacy]) {
    await assert.rejects(store.linkChat({ ...link, workId: null }), /不能覆盖/);
    assert.equal(bytes(disk), before);
  }
});

for (const workId of [undefined, '', 'unregistered-work']) {
  test(`new Chat rejects invalid Work ${String(workId)} without changing formal bytes`, async () => {
    const disk = storage({ [FORMAL]: formal() });
    const before = bytes(disk);
    await assert.rejects(new WorkStore(disk).linkChat({ ...chat(), workId } as unknown as ChatLink), /Work 不存在|正式关系数据/);
    assert.equal(bytes(disk), before);
    assert.deepEqual(disk.writes, []);
  });
}

const invalidStandalone = [
  { chatId: '' }, { documentRootId: '' }, { connectionId: '' }, { profile: '' }, { title: '' },
  { storedSessionId: null }, { storedSessionId: undefined }, { installId: null }, { installId: undefined },
  { adapter: 'unresolved', state: 'pending', storedSessionId: null },
  { adapter: 'unresolved', state: 'source-unknown', storedSessionId: null, legacyCandidateId: 'legacy-id' },
  { legacyCandidateId: 'legacy-id' }, { legacyBridgeUrl: 'legacy-bridge' },
];
test('invalid standalone identities and legacy evidence are refused on write and reload', async () => {
  for (const changed of invalidStandalone) {
    const invalid = { ...chat(), ...changed } as ChatLink;
    const disk = storage({ [FORMAL]: formal() });
    const before = bytes(disk);
    await assert.rejects(new WorkStore(disk).linkChat(invalid), /正式关系数据/);
    assert.equal(bytes(disk), before);
    assert.deepEqual(disk.writes, []);
    const corrupt = storage({ [FORMAL]: formal([invalid]) });
    const corruptBytes = bytes(corrupt);
    await assert.rejects(new WorkStore(corrupt).listDocumentChats('document-a'), /正式关系数据/);
    await assert.rejects(new WorkStore(corrupt).registerWork('new-work'), /正式关系数据/);
    assert.equal(bytes(corrupt), corruptBytes);
    assert.deepEqual(corrupt.writes, []);
  }
});

for (const [label, changed] of [
  ['array unresolved adapter', { adapter: ['unresolved'] }],
  ['array serve adapter', { adapter: ['serve'] }],
  ['array source-unknown state', { state: ['source-unknown'] }],
  ['array ready state', { state: ['ready'] }],
  ['object adapter', { adapter: { toString: 'serve' } }],
  ['object state', { state: { toString: 'ready' } }],
] as const) {
  test(`standalone rejects ${label} on write without replacing formal bytes`, async () => {
    const invalid = { ...chat(), ...changed } as unknown as ChatLink;
    const disk = storage({ [FORMAL]: formal() });
    const before = bytes(disk);
    await assert.rejects(new WorkStore(disk).linkChat(invalid), /正式关系数据/);
    assert.equal(bytes(disk), before);
    assert.deepEqual(disk.writes, []);
  });
  test(`standalone rejects ${label} after JSON reload before listing or sending`, async () => {
    const invalid = JSON.parse(JSON.stringify({ ...chat(), ...changed })) as ChatLink;
    const disk = storage({ [FORMAL]: formal([invalid]) });
    const before = bytes(disk);
    const store = new WorkStore(disk);
    await assert.rejects(store.listDocumentChats('document-a'), /正式关系数据/);
    await assert.rejects(store.assertChatSendable(invalid.chatId), /正式关系数据/);
    await assert.rejects(store.registerWork('new-work'), /正式关系数据/);
    assert.equal(bytes(disk), before);
    assert.deepEqual(disk.writes, []);
  });
}

test('a runtime legacy payload with null Work is rejected instead of creating standalone', async () => {
  const disk = storage({ [FORMAL]: formal() });
  const before = bytes(disk);
  const invalid = { chatId: 'legacy-id', workId: null, documentRootId: 'document-a', connectionId: 'legacy-bridge' } as unknown as LegacyChatLink;
  await assert.rejects(new WorkStore(disk).linkChat(invalid), /Work 不存在|正式关系数据/);
  assert.equal(bytes(disk), before);
  assert.deepEqual(disk.writes, []);
});

test('standalone listing preserves v1 migration identities and authoritative v2 corrupt-data guards', async () => {
  const old = { schema: 1, works: ['work-a'], chats: [{ chatId: 'old-chat', workId: 'work-a', documentRootId: 'document-a', connectionId: 'legacy-bridge' }], tasks: [], pins: {} };
  const disk = storage({ 'work-formal-v1': old });
  const before = JSON.stringify(old);
  const store = new WorkStore(disk);
  assert.deepEqual(await store.listDocumentChats('document-a'), []);
  const migrated = (await store.listChats('work-a'))[0];
  assert.equal(migrated.workId, 'work-a');
  assert.equal(migrated.state, 'source-unknown');
  assert.equal(migrated.legacyCandidateId, 'old-chat');
  assert.equal(JSON.stringify(disk.values.get('work-formal-v1')), before);
  await store.linkChat(chat());
  assert.deepEqual(await store.listDocumentChats('document-a'), [chat()]);
  assert.equal(JSON.stringify(disk.values.get('work-formal-v1')), before);
  for (const bad of [null, { schema: 99 }, { ...formal(), pins: { orphan: [] } }]) {
    const corrupt = storage({ 'work-formal-v1': old, [FORMAL]: bad });
    const original = bytes(corrupt);
    await assert.rejects(new WorkStore(corrupt).listDocumentChats('document-a'), /正式关系数据/);
    await assert.rejects(new WorkStore(corrupt).linkChat(chat()), /正式关系数据/);
    assert.equal(bytes(corrupt), original);
    assert.deepEqual(corrupt.writes, []);
  }
});
