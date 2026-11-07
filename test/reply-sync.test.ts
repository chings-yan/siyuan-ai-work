import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  ReplyReadStateStore, ReplySyncController, compareReadCursor, makeReadCursor,
  pairedBridgeNamespace, replyScopeKey, type ReplySnapshot, type ReplySyncPorts,
} from '../src/work/reply-sync.ts';
import type { ChatLink, StoragePort } from '../src/work/store.ts';

const link: ChatLink = {
  chatId: 'synthetic-chat', workId: null, documentRootId: '20990101000000-aaaaaaa',
  connectionId: 'studio-default', adapter: 'studio', profile: 'default', installId: null,
  storedSessionId: 'synthetic-session', title: '虚构原会话', state: 'ready',
};
const messages = [
  { id: 'real-user-1', role: 'user', content: '虚构问题' },
  { id: 'real-assistant-1', role: 'assistant', content: '虚构答复' },
];
function snapshot(items = messages, target = link): ReplySnapshot {
  return { schemaVersion: 1, complete: true, completeness: 'display-history', consistency: 'two-complete-reads-match',
    source: { chatId: target.chatId, documentRootId: target.documentRootId, connectionId: target.connectionId,
      kind: target.adapter as 'studio' | 'serve', profile: target.profile,
      storedSessionId: target.storedSessionId!, installId: target.installId },
    messages: structuredClone(items),
  } as ReplySnapshot;
}
function storage(initial?: unknown) {
  const values = new Map<string, unknown>(initial === undefined ? [] : [['hermes-read-state-v1', initial]]);
  const writes: { key: string; value: unknown }[] = [];
  const port: StoragePort = {
    loadData: key => structuredClone(values.get(key)),
    saveData: (key, value) => { writes.push({ key, value: structuredClone(value) }); values.set(key, structuredClone(value)); },
  };
  return { port, values, writes };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('a paired Bridge namespace normalizes its URL and does not persist pairing material', async () => {
  const first = await pairedBridgeNamespace(' HTTP://LOCALHOST:8782/ ', 'synthetic-pairing-one');
  assert.equal(first, await pairedBridgeNamespace('http://localhost:8782', 'synthetic-pairing-one'));
  assert.notEqual(first, await pairedBridgeNamespace('http://localhost:8782', 'synthetic-pairing-two'));
  assert.notEqual(first, await pairedBridgeNamespace('http://localhost:8783', 'synthetic-pairing-one'));
  assert.match(first, /^bridge:[a-f0-9]{64}$/);
  assert.doesNotMatch(first, /localhost|synthetic/);
  await assert.rejects(pairedBridgeNamespace('https://external.invalid', 'synthetic-pairing-one'));
  await assert.rejects(pairedBridgeNamespace('http://localhost:8782', ''));
});

test('the same exact remote session shares a cursor across documents while each source identity stays isolated', () => {
  const scope = replyScopeKey('bridge-a', link);
  assert.equal(scope, replyScopeKey('bridge-a', { ...link, chatId: 'other-chat', workId: 'other-work', documentRootId: '20990101000000-bbbbbbb' }));
  for (const changed of [
    { ...link, adapter: 'serve' as const, installId: 'install-a' },
    { ...link, connectionId: 'other-connection' }, { ...link, profile: 'other-profile' },
    { ...link, installId: 'other-install' }, { ...link, storedSessionId: 'other-session' },
  ]) assert.notEqual(scope, replyScopeKey('bridge-a', changed));
  assert.notEqual(scope, replyScopeKey('bridge-b', link));
});

test('first inspection has no read baseline and counts only appended nonempty assistant replies after acknowledgement', async () => {
  assert.deepEqual(await compareReadCursor(snapshot(), undefined), { status: 'baseline-unset', unreadCount: null });
  const cursor = await makeReadCursor(snapshot(), '2099-01-01T00:00:00.000Z');
  assert.equal(cursor.seenCount, 2);
  assert.equal(cursor.lastMessageId, 'real-assistant-1');
  assert.deepEqual(await compareReadCursor(snapshot(), cursor), { status: 'read', unreadCount: 0 });
  const added = snapshot([...messages,
    { id: 'sys-1', role: 'system', content: '系统记录' },
    { id: 'tool-1', role: 'tool', content: '工具记录' },
    { id: 'user-2', role: 'user', content: '下一问' },
    { id: 'assistant-empty', role: 'assistant', content: ' \n ' },
    { id: 'real-assistant-2', role: 'assistant', content: '下一答' },
  ]);
  assert.deepEqual(await compareReadCursor(added, cursor), { status: 'unread', unreadCount: 1 });
});

test('a removed, reordered, edited or replaced read prefix is history-changed and never becomes zero unread', async () => {
  const cursor = await makeReadCursor(snapshot(), '2099-01-01T00:00:00.000Z');
  for (const changed of [
    messages.slice(0, 1), [...messages].reverse(),
    [messages[0], { ...messages[1], content: '已改正文' }],
    [{ ...messages[0], role: 'system' }, messages[1]],
    [{ ...messages[0], id: 'replacement-id' }, messages[1]],
  ]) assert.deepEqual(await compareReadCursor(snapshot(changed), cursor), { status: 'history-changed', unreadCount: null });
});

test('an explicit empty-history baseline can see later replies without inventing a message id', async () => {
  const cursor = await makeReadCursor(snapshot([]), '2099-01-01T00:00:00.000Z');
  assert.equal(cursor.lastMessageId, null);
  assert.equal(cursor.seenCount, 0);
  assert.deepEqual(await compareReadCursor(snapshot(), cursor), { status: 'unread', unreadCount: 1 });
});

test('read-state writes contain only cursor data and preserve unrelated state', async () => {
  const data = storage(); data.values.set('work-pending-v1', { unchanged: true });
  const state = new ReplyReadStateStore(data.port);
  const cursor = await makeReadCursor(snapshot(), '2099-01-01T00:00:00.000Z');
  const key = replyScopeKey('bridge-a', link);
  assert.equal(await state.write(key, cursor, () => true), true);
  assert.deepEqual((await state.read()).items[key], cursor);
  assert.deepEqual(data.values.get('work-pending-v1'), { unchanged: true });
  assert.equal(data.writes.length, 1);
  assert.equal(data.writes[0].key, 'hermes-read-state-v1');
  assert.deepEqual(Object.keys(cursor).sort(), ['lastMessageId', 'prefixDigest', 'seenCount', 'updatedAt']);
  assert.doesNotMatch(JSON.stringify(data.writes), /虚构问题|虚构答复|虚构原会话|documentRootId/);
});

test('corrupt read-state is preserved and blocks writes rather than resetting the baseline', async () => {
  for (const invalid of [{ schema: 2, items: {} }, { schema: 1, items: { bad: { seenCount: -1 } } }, null]) {
    const data = storage(invalid), state = new ReplyReadStateStore(data.port);
    await assert.rejects(state.read(), /已读记录/);
    await assert.rejects(state.write('scope', await makeReadCursor(snapshot(), '2099-01-01T00:00:00.000Z'), () => true), /已读记录/);
    assert.deepEqual(data.values.get('hermes-read-state-v1'), invalid);
    assert.equal(data.writes.length, 0);
  }
});

test('serialized cursor writes recheck their source after loading and preserve the last saved data on failure', async () => {
  const data = storage(), initial = new ReplyReadStateStore(data.port);
  const old = await makeReadCursor(snapshot(), '2099-01-01T00:00:00.000Z');
  await initial.write('scope', old, () => true);
  const gate = deferred<unknown>(); let current = true;
  const blocked = new ReplyReadStateStore({ ...data.port, loadData: async key => { await gate.promise; return data.port.loadData(key); } });
  const write = blocked.write('scope', { ...old, updatedAt: '2099-01-02T00:00:00.000Z' }, () => current);
  current = false; gate.resolve(undefined);
  assert.equal(await write, false);
  assert.deepEqual((await initial.read()).items.scope, old);
  const failed = new ReplyReadStateStore({ ...data.port, saveData: () => { throw new Error('synthetic-save-failed'); } });
  await assert.rejects(failed.write('scope', { ...old, updatedAt: '2099-01-03T00:00:00.000Z' }, () => true), /synthetic-save-failed/);
  assert.deepEqual((await initial.read()).items.scope, old);
});

test('the final synchronous source guard stops a change after an asynchronous binding check', async () => {
  const data = storage(), store = new ReplyReadStateStore(data.port);
  const cursor = await makeReadCursor(snapshot(), '2099-01-01T00:00:00.000Z');
  let current = true;
  assert.equal(await store.write('scope', cursor, async () => {
    queueMicrotask(() => { current = false; }); return true;
  }, () => current), false);
  assert.equal(data.writes.length, 0);
});

test('overlapping cursor saves serialize the read-modify-write and keep both sessions', async () => {
  const data = storage(), gate = deferred<void>(), entered = deferred<void>(); let writes = 0;
  const store = new ReplyReadStateStore({ ...data.port, saveData: async (key, value) => {
    writes++; if (writes === 1) { entered.resolve(); await gate.promise; } return data.port.saveData(key, value);
  } });
  const cursor = await makeReadCursor(snapshot(), '2099-01-01T00:00:00.000Z');
  const first = store.write('session-one', cursor, () => true); await entered.promise;
  const second = store.write('session-two', cursor, () => true); await setImmediate();
  assert.equal(writes, 1); gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(Object.keys((await store.read()).items).sort(), ['session-one', 'session-two']);
});

function controllerFixture(overrides: Partial<ReplySyncPorts> = {}, options: { concurrency?: number; maxTargets?: number; budgetMs?: number } = {}) {
  const data = storage(); let generation = 1;
  let targets = [link], next = snapshot();
  const reads: ChatLink[] = [];
  const ports: ReplySyncPorts = {
    storage: data.port,
    captureSource: async () => { const captured = generation; return { namespace: `bridge-${captured}`, isCurrent: () => captured === generation }; },
    listTargets: async () => ({ links: structuredClone(targets), unresolvedCount: 0 }),
    isTargetCurrent: target => targets.some(item => JSON.stringify(item) === JSON.stringify(target)),
    readSnapshot: async target => { reads.push(structuredClone(target)); return snapshot(next.messages, target); },
    ...overrides,
  };
  const controller = new ReplySyncController(ports, options);
  return { controller, ports, data, reads, setTargets: (value: ChatLink[]) => { targets = value; },
    setSnapshot: (value: ReplySnapshot) => { next = value; }, changeSource: () => { generation++; },
    row: () => controller.view().rows[0] };
}

test('the controller starts idle, checks formal links explicitly and does not treat an initial snapshot as read', async () => {
  const f = controllerFixture();
  try {
    await setImmediate();
    assert.equal(f.reads.length, 0);
    assert.equal(f.controller.view().autoCheck, false);
    await f.controller.check();
    assert.equal(f.reads.length, 1);
    assert.equal(f.row().status, 'baseline-unset');
    assert.equal(f.row().unreadCount, null);
    assert.ok(f.row().checkedAt);
    assert.equal(f.data.writes.length, 0);
    assert.equal(await f.controller.markRead(f.row().key, f.row().revision), true);
    assert.equal(f.row().status, 'read');
    f.setSnapshot(snapshot([...messages, { id: 'assistant-2', role: 'assistant', content: '新增回复' }]));
    await f.controller.check();
    assert.equal(f.row().status, 'unread');
    assert.equal(f.row().unreadCount, 1);
    assert.equal(f.data.writes.length, 1);
  } finally { f.controller.dispose(); }
});

test('marking one document updates other bindings of the same remote session without merging their identities', async () => {
  const f = controllerFixture();
  const other = { ...link, chatId: 'other-chat', documentRootId: '20990101000000-bbbbbbb', title: '另一个文档中的原关系' };
  f.setTargets([link, other]);
  try {
    await f.controller.check();
    assert.equal(await f.controller.markRead(f.row().key, f.row().revision), true);
    assert.deepEqual(f.controller.view().rows.map(row => [row.link.chatId, row.status, row.unreadCount]), [
      ['synthetic-chat', 'read', 0], ['other-chat', 'read', 0],
    ]);
    const persisted = f.data.values.get('hermes-read-state-v1') as { items: Record<string, unknown> };
    assert.equal(Object.keys(persisted.items).length, 1);
  } finally { f.controller.dispose(); }
});

test('acknowledging a newer shared snapshot does not mislabel an older cached peer as changed history', async () => {
  const other = { ...link, chatId: 'other-chat', documentRootId: '20990101000000-bbbbbbb' };
  const f = controllerFixture({ readSnapshot: async target => snapshot(target.chatId === link.chatId ? messages
    : [...messages, { id: 'new-shared-answer', role: 'assistant', content: '稍后到达的回复' }], target) }, { concurrency: 1 });
  f.setTargets([link, other]);
  try {
    await f.controller.check(); const [old, newer] = f.controller.view().rows;
    assert.equal(await f.controller.markRead(newer.key, newer.revision), true);
    assert.equal(f.row().status, 'unchecked');
    assert.equal(f.row().unreadCount, null);
    assert.equal(f.row().canMarkRead, false);
    assert.match(f.row().error || '', /另一关联|重新检查/);
    assert.equal(await f.controller.markRead(old.key, old.revision), false);
    assert.equal(f.controller.view().rows[1].status, 'read');
  } finally { f.controller.dispose(); }
});

test('snapshot A acknowledgement keeps a newer B reply unread when B arrives during the save', async () => {
  const data = storage(), saving = deferred<void>(), entered = deferred<void>();
  const f = controllerFixture({ storage: { ...data.port, saveData: async (key, value) => {
    entered.resolve(); await saving.promise; return data.port.saveData(key, value);
  } } });
  try {
    await f.controller.check();
    const displayed = f.row();
    const marking = f.controller.markRead(displayed.key, displayed.revision);
    await entered.promise;
    f.setSnapshot(snapshot([...messages, { id: 'assistant-B', role: 'assistant', content: '保存时到达的B' }]));
    const checking = f.controller.check();
    await setImmediate();
    saving.resolve();
    assert.equal(await marking, true); await checking;
    assert.equal(f.row().status, 'unread');
    assert.equal(f.row().unreadCount, 1);
    const cursor = Object.values((data.values.get('hermes-read-state-v1') as { items: Record<string, { lastMessageId: string }> }).items)[0];
    assert.equal(cursor.lastMessageId, 'real-assistant-1');
  } finally { saving.resolve(); f.controller.dispose(); }
});

test('stale revision controls cannot acknowledge a newer displayed snapshot', async () => {
  const f = controllerFixture();
  try {
    await f.controller.check(); const old = f.row();
    f.setSnapshot(snapshot([...messages, { id: 'assistant-new', role: 'assistant', content: '新的检查' }]));
    await f.controller.check();
    assert.equal(await f.controller.markRead(old.key, old.revision), false);
    assert.equal(f.row().status, 'baseline-unset');
    assert.equal(f.data.writes.length, 0);
  } finally { f.controller.dispose(); }
});

test('source changes during a read or during the post-load write guard cannot save an old cursor', async () => {
  const readGate = deferred<ReplySnapshot>();
  const f = controllerFixture({ readSnapshot: async () => readGate.promise });
  try {
    const checking = f.controller.check(); await setImmediate();
    f.changeSource(); readGate.resolve(snapshot()); await checking;
    assert.equal(f.controller.view().rows.some(row => row.checkedAt !== null), false);
    assert.equal(f.data.writes.length, 0);
  } finally { f.controller.dispose(); }

  const data = storage(), loadGate = deferred<void>(); let blockLoad = false;
  const g = controllerFixture({ storage: { ...data.port, loadData: async key => {
    if (blockLoad) await loadGate.promise; return data.port.loadData(key);
  } } });
  try {
    await g.controller.check(); blockLoad = true;
    const displayed = g.row(), marking = g.controller.markRead(displayed.key, displayed.revision);
    await setImmediate(); g.changeSource(); loadGate.resolve();
    assert.equal(await marking, false);
    assert.equal(data.writes.length, 0);
  } finally { loadGate.resolve(); g.controller.dispose(); }
});

test('a new check with the same namespace cannot renew an old acknowledgement source closure', async () => {
  const data = storage(), loading = deferred<void>(), entered = deferred<void>();
  let generation = 1, blocked = false;
  const f = controllerFixture({
    captureSource: async () => { const captured = generation; return { namespace: 'same-bridge', isCurrent: () => captured === generation }; },
    storage: { ...data.port, loadData: async key => { if (blocked) { entered.resolve(); await loading.promise; } return data.port.loadData(key); } },
  });
  try {
    await f.controller.check(); const old = f.row(); blocked = true;
    const marking = f.controller.markRead(old.key, old.revision); await entered.promise;
    generation++;
    const checking = f.controller.check(); await setImmediate();
    loading.resolve();
    assert.equal(await marking, false); await checking;
    assert.equal(data.writes.length, 0);
    assert.equal(f.row().status, 'baseline-unset');
  } finally { loading.resolve(); f.controller.dispose(); }
});

test('a binding changed while the cursor is loading cannot publish the old history as a fresh result', async () => {
  const data = storage(), loading = deferred<void>(), entered = deferred<void>();
  const f = controllerFixture({ storage: { ...data.port, loadData: async key => {
    entered.resolve(); await loading.promise; return data.port.loadData(key);
  } } });
  try {
    const checking = f.controller.check(); await entered.promise;
    f.setTargets([{ ...link, storedSessionId: 'replacement-session' }]);
    loading.resolve(); await checking;
    assert.equal(f.row().checkedAt, null);
    assert.equal(f.row().unreadCount, null);
    assert.equal(f.row().canMarkRead, false);
  } finally { loading.resolve(); f.controller.dispose(); }
});

test('a changed formal binding refuses acknowledgement without clearing existing Work pending state', async () => {
  const f = controllerFixture(); f.data.values.set('work-pending-v1', { pending: 'keep' });
  try {
    await f.controller.check(); const displayed = f.row();
    f.setTargets([{ ...link, storedSessionId: 'replacement-session' }]);
    assert.equal(await f.controller.markRead(displayed.key, displayed.revision), false);
    assert.equal(f.data.writes.length, 0);
    assert.deepEqual(f.data.values.get('work-pending-v1'), { pending: 'keep' });
  } finally { f.controller.dispose(); }
});

test('partial failures preserve the last verified count and time while successful peers advance', async () => {
  let fail = false, append = false;
  const other = { ...link, chatId: 'other-chat', storedSessionId: 'other-session' };
  const f = controllerFixture({ readSnapshot: async target => {
    if (fail && target.chatId === link.chatId) throw new Error('synthetic failure');
    return snapshot(append ? [...messages, { id: 'new-answer', role: 'assistant', content: '新回复' }] : messages, target);
  } }); f.setTargets([link, other]);
  try {
    await f.controller.check();
    for (const row of f.controller.view().rows) assert.equal(await f.controller.markRead(row.key, row.revision), true);
    append = true; await f.controller.check(); const previous = f.row();
    fail = true; await f.controller.check();
    assert.equal(f.row().unreadCount, 1);
    assert.equal(f.row().status, 'unread');
    assert.equal(f.row().checkedAt, previous.checkedAt);
    assert.match(f.row().error || '', /保留上次/);
    assert.equal(f.controller.view().rows[1].unreadCount, 1);
    assert.equal(f.controller.view().rows[1].error, null);
  } finally { f.controller.dispose(); }
});

test('a failed or corrupt cursor save preserves the verified snapshot and never writes other plugin state', async () => {
  const data = storage(); let failSave = false;
  const f = controllerFixture({ storage: { ...data.port, saveData: (key, value) => {
    if (failSave) throw new Error('synthetic save failure'); return data.port.saveData(key, value);
  } } });
  try {
    await f.controller.check(); await f.controller.markRead(f.row().key, f.row().revision);
    const original = structuredClone(data.values.get('hermes-read-state-v1'));
    f.setSnapshot(snapshot([...messages, { id: 'new-answer', role: 'assistant', content: '待查看' }]));
    await f.controller.check(); const before = f.row();
    failSave = true;
    assert.equal(await f.controller.markRead(before.key, before.revision), false);
    assert.deepEqual(data.values.get('hermes-read-state-v1'), original);
    assert.equal(f.row().unreadCount, 1); assert.equal(f.row().checkedAt, before.checkedAt);
    data.values.set('hermes-read-state-v1', { schema: 1, items: { corrupt: 'do not replace' } });
    await f.controller.check();
    assert.equal(f.row().unreadCount, 1); assert.equal(f.row().checkedAt, before.checkedAt);
    assert.match(f.row().error || '', /保留上次/);
    assert.equal(await f.controller.markRead(f.row().key, f.row().revision), false);
    assert.deepEqual(data.values.get('hermes-read-state-v1'), { schema: 1, items: { corrupt: 'do not replace' } });
    assert.deepEqual(data.writes.map(item => item.key), ['hermes-read-state-v1']);
  } finally { f.controller.dispose(); }
});

test('an unsupported snapshot capability stays unknown on first check and preserves prior verified results later', async () => {
  let unsupported = true;
  const f = controllerFixture({ readSnapshot: async () => {
    if (unsupported) throw Object.assign(new Error('synthetic unsupported'), { code: 'history_snapshot_unsupported' });
    return snapshot();
  } });
  try {
    await f.controller.check();
    assert.equal(f.row().status, 'unsupported'); assert.equal(f.row().unreadCount, null);
    assert.equal(f.row().canMarkRead, false);
    unsupported = false; await f.controller.check();
    await f.controller.markRead(f.row().key, f.row().revision); const before = f.row();
    unsupported = true; await f.controller.check();
    assert.equal(f.row().status, 'read'); assert.equal(f.row().unreadCount, 0);
    assert.equal(f.row().checkedAt, before.checkedAt); assert.match(f.row().error || '', /配套无法核验/);
  } finally { f.controller.dispose(); }
});

test('unresolved, legacy and non-ready links remain unverifiable and never reach the snapshot port', async () => {
  const f = controllerFixture({ listTargets: async () => ({ unresolvedCount: 2, links: [
    link, { ...link, chatId: 'old', adapter: 'legacy-api', connectionId: 'legacy-api' },
    { ...link, chatId: 'pending', state: 'pending' },
    { ...link, chatId: 'legacy-studio', legacyBridgeUrl: 'http://localhost:8782' },
    { ...link, chatId: 'unresolved', adapter: 'unresolved', storedSessionId: null, state: 'source-unknown' },
  ] }) });
  try {
    await f.controller.check();
    assert.deepEqual(f.reads.map(item => item.chatId), ['synthetic-chat']);
    assert.equal(f.controller.view().unresolvedCount, 2);
    assert.deepEqual(f.controller.view().rows.map(row => row.status), ['baseline-unset', 'unsupported', 'unsupported', 'unsupported', 'unsupported']);
    assert.ok(f.controller.view().rows.slice(1).every(row => row.unreadCount === null && !row.canMarkRead));
  } finally { f.controller.dispose(); }
});

test('malformed or misattributed snapshots cannot create a cursor or become a verified empty history', async () => {
  const invalid: unknown[] = [
    { ...snapshot(), complete: false }, { ...snapshot(), consistency: 'atomic' },
    { ...snapshot(), source: { ...snapshot().source, storedSessionId: 'wrong-session' } },
    { ...snapshot(), source: { ...snapshot().source, documentRootId: '20990101000000-bbbbbbb' } },
    snapshot([{ id: '', role: 'assistant', content: '缺标识' }]),
    snapshot([{ id: 'same', role: 'user', content: '1' }, { id: 'same', role: 'assistant', content: '2' }]),
    snapshot([{ id: 'invented-role', role: 'bot', content: '非法角色' }]),
    snapshot([{ id: 'technical-role', role: 'tool', content: '工具不能冒充答复' }]),
    { ...snapshot(), messages: [{ id: 'missing-body', role: 'assistant' }] },
    { ...snapshot(), messages: [{ id: 'array-role', role: ['assistant'], content: '非法角色数组' }] },
  ];
  for (const value of invalid) {
    const f = controllerFixture({ readSnapshot: async () => value as ReplySnapshot });
    try {
      await f.controller.check();
      assert.equal(f.row().status, 'error');
      assert.equal(f.row().unreadCount, null);
      assert.equal(f.row().checkedAt, null);
      assert.equal(f.row().canMarkRead, false);
      assert.equal(f.data.writes.length, 0);
    } finally { f.controller.dispose(); }
  }
});

test('a manual batch uses small concurrency, a target cap and a total timeout without late result overwrite', async () => {
  let active = 0, peak = 0;
  const f = controllerFixture({ readSnapshot: async target => {
    active++; peak = Math.max(peak, active); await setImmediate(); active--; return snapshot(messages, target);
  } }, { concurrency: 2, maxTargets: 3 });
  f.setTargets(Array.from({ length: 5 }, (_, index) => ({ ...link, chatId: `chat-${index}`, storedSessionId: `session-${index}` })));
  try {
    await f.controller.check();
    assert.equal(peak, 2);
    assert.equal(f.controller.view().rows.filter(row => row.checkedAt).length, 3);
    assert.equal(f.controller.view().remainingCount, 2);
    await f.controller.check();
    assert.equal(f.controller.view().rows.filter(row => row.checkedAt).length, 5);
  } finally { f.controller.dispose(); }

  const late = deferred<ReplySnapshot>(); let signal: AbortSignal | undefined;
  const g = controllerFixture({ readSnapshot: async (_target, received) => { signal = received; return late.promise; } }, { budgetMs: 20 });
  try {
    await g.controller.check();
    assert.equal(signal?.aborted, true);
    assert.equal(g.controller.view().checking, false);
    assert.equal(g.row().unreadCount, null);
    late.resolve(snapshot()); await setImmediate();
    assert.equal(g.row().checkedAt, null);
    assert.equal(g.data.writes.length, 0);
  } finally { late.resolve(snapshot()); g.controller.dispose(); }
});

test('manual cancellation and disposal abort reads and suppress late publication', async () => {
  for (const dispose of [false, true]) {
    const late = deferred<ReplySnapshot>(); let signal: AbortSignal | undefined;
    const f = controllerFixture({ readSnapshot: async (_target, received) => { signal = received; return late.promise; } });
    let notifications = 0; f.controller.subscribe(() => { notifications++; });
    try {
      const checking = f.controller.check(); await setImmediate();
      if (dispose) f.controller.dispose(); else f.controller.cancel();
      await checking; const previous = notifications;
      assert.equal(signal?.aborted, true);
      late.resolve(snapshot()); await setImmediate();
      assert.equal(f.controller.view().checking, false);
      assert.equal(f.controller.view().rows.some(row => row.checkedAt), false);
      assert.equal(notifications, previous);
      assert.equal(f.data.writes.length, 0);
    } finally { late.resolve(snapshot()); f.controller.dispose(); }
  }
});

test('an old request failure after cancellation cannot overwrite a newer completed check', async () => {
  const old = deferred<ReplySnapshot>(); let requests = 0;
  const f = controllerFixture({ readSnapshot: async () => { requests++; return requests === 1 ? old.promise : snapshot(); } });
  try {
    const first = f.controller.check(); await setImmediate(); f.controller.cancel(); await first;
    await f.controller.check(); const newer = f.row();
    old.reject(new Error('late old failure')); await setImmediate();
    assert.deepEqual(f.row(), newer);
    assert.equal(f.row().error, null);
    assert.equal(f.controller.view().checking, false);
  } finally { old.resolve(snapshot()); f.controller.dispose(); }
});

test('the total budget also cancels a slow source capture without starting any history reads', async () => {
  const source = deferred<{ namespace: string; isCurrent: () => boolean }>();
  const f = controllerFixture({ captureSource: async () => source.promise }, { budgetMs: 20 });
  try {
    await f.controller.check();
    assert.equal(f.controller.view().checking, false); assert.equal(f.reads.length, 0);
    assert.match(f.controller.view().feedback, /时间上限/);
    source.resolve({ namespace: 'too-late', isCurrent: () => true }); await setImmediate();
    assert.equal(f.reads.length, 0); assert.equal(f.controller.view().rows.length, 0);
  } finally { source.resolve({ namespace: 'cleanup', isCurrent: () => false }); f.controller.dispose(); }
});

test('a timed-out batch continues at unattempted links instead of repeatedly starving later sessions', async () => {
  const late = deferred<ReplySnapshot>(), requested: string[] = [];
  const f = controllerFixture({ readSnapshot: async target => {
    requested.push(target.chatId); if (requested.length === 1) return late.promise; return snapshot(messages, target);
  } }, { concurrency: 1, maxTargets: 5, budgetMs: 20 });
  f.setTargets(Array.from({ length: 5 }, (_, index) => ({ ...link, chatId: `chat-${index}`, storedSessionId: `session-${index}` })));
  try {
    await f.controller.check();
    assert.deepEqual(requested, ['chat-0']); assert.equal(f.controller.view().remainingCount, 4);
    await f.controller.check(); assert.equal(requested[1], 'chat-1');
  } finally { late.resolve(snapshot()); f.controller.dispose(); }
});

test('automatic checking is explicit, session-only and stops when disabled or disposed', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = controllerFixture();
  try {
    t.mock.timers.tick(120000); await setImmediate(); assert.equal(f.reads.length, 0);
    f.controller.setAutoCheck(true); await f.controller.check(); assert.equal(f.reads.length, 1);
    t.mock.timers.tick(60000); await f.controller.check(); assert.equal(f.reads.length, 2);
    f.controller.setAutoCheck(false); t.mock.timers.tick(120000); await setImmediate(); assert.equal(f.reads.length, 2);
    assert.equal(f.data.writes.length, 0);
    f.controller.setAutoCheck(true); await f.controller.check(); assert.equal(f.reads.length, 3);
    f.controller.dispose(); t.mock.timers.tick(120000); await setImmediate(); assert.equal(f.reads.length, 3);
  } finally { f.controller.dispose(); t.mock.timers.reset(); }
});
