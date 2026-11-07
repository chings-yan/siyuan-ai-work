import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createChatShell } from '../src/ui.ts';
import { EkkoRoomUI, type EkkoRoomUIOptions } from '../src/ekko/ui.ts';
import { PendingRoomSendStore } from '../src/ekko/pending.ts';
import { BridgeError } from '../src/bridge.ts';
import type { RoomLink } from '../src/work/room-store.ts';

const A = '20260928123456-abc1234';
const B = '20260928123457-abc1234';
const DOC = '20260928123458-abc1234';
const connection = { id: 'connection-one', deviceId: 'device-one', accountUserId: 7, accountName: '测试用户', state: 'connected' };
const room = { id: 'room-one', name: '测试房间' };
const secondRoom = { id: 'room-two', name: '另一房间' };
const message = (id: string, content: string, roomId = room.id) => ({ id, roomId, senderName: '测试用户', content, timestamp: '2026-09-28T00:00:00Z' });
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function fixture() {
  const dom = new JSDOM(`<!doctype html><html><body>${createChatShell()}</body></html>`, { url: 'http://localhost' });
  const root = dom.window.document.querySelector<HTMLElement>('.sac')!;
  let workId = A;
  let documentId = DOC;
  let currentConnection = { ...connection };
  let offline = false;
  let sendResult: 'sent' | 'unknown' = 'sent';
  let sendError: Error | null = null;
  let sendGate: Promise<void> | null = null;
  const sent: Array<{ roomId: string; payload: any; documentRootId: string }> = [];
  const pairInputs: Array<{ baseUrl: string; username: string; password: string }> = [];
  const links: RoomLink[] = [];
  const pendingData = new Map<string, unknown>();
  const pendingStore = new PendingRoomSendStore({ loadData: key => pendingData.get(key), saveData: (key, value) => { pendingData.set(key, value); } });
  const history: Record<string, ReturnType<typeof message>[]> = { [room.id]: [message('m-1', '<script>alert(1)</script>')], [secondRoom.id]: [message('m-2', '只属于另一房间', secondRoom.id)] };
  const eventCallbacks = new Map<string, (event: any) => void>();
  const eventEnds = new Map<string, () => void>();
  const client = {
    connection: async () => { if (offline) throw new Error('连接断开'); return { connection: currentConnection }; },
    pair: async (input: { baseUrl: string; username: string; password: string }) => { pairInputs.push({ ...input }); return { connection: currentConnection }; },
    rooms: async () => { if (offline) throw new Error('连接断开'); return { rooms: [room, secondRoom], total: 2, hasMore: false }; },
    room: async (id: string) => ({ room: [room, secondRoom].find(item => item.id === id)!, messages: history[id], agents: [{ roomId: id, agentId: 'agent-one', name: '助手' }], hasMore: false }),
    events: async (id: string, onEvent: (event: any) => void, signal?: AbortSignal) => new Promise<void>(resolve => {
      eventCallbacks.set(id, onEvent); eventEnds.set(id, resolve);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    }),
    send: async (roomId: string, payload: any, expectedIdentity: any, documentRootId: string) => { sent.push({ roomId, payload, documentRootId }); if (sendGate) await sendGate; if (sendError) throw sendError; return { state: sendResult, messageId: sendResult === 'sent' ? 'm-new' : undefined }; },
    sendStatus: async (): Promise<{ state: 'sent' | 'unknown' }> => ({ state: 'unknown' }),
  };
  const store = {
    listForWork: async (id: string) => links.filter(link => link.workId === id).map(link => ({ ...link })),
    linkRoom: async (link: RoomLink) => { if (!links.some(x => x.workId === link.workId && x.connectionId === link.connectionId && x.roomId === link.roomId)) links.push({ ...link }); },
    unlinkRoom: async (link: RoomLink) => { const index = links.findIndex(x => x.workId === link.workId && x.connectionId === link.connectionId && x.deviceId === link.deviceId && x.accountUserId === link.accountUserId && x.roomId === link.roomId); if (index >= 0) links.splice(index, 1); },
    assertLinked: async (id: string, identity: any, roomId: string) => {
      const link = links.find(x => x.workId === id && x.roomId === roomId && x.connectionId === identity.connectionId && x.deviceId === identity.deviceId && x.accountUserId === identity.accountUserId);
      if (!link) throw new Error('房间未关联');
      return { ...link };
    },
  };
  const options: EkkoRoomUIOptions = {
    client: () => client,
    getBridgeIdentity: () => 'fictional-bridge-one',
    store,
    pendingStore,
    getWorkId: () => workId,
    getDocumentRootId: () => documentId,
    availableSources: async () => [{ label: '当前文档全文', source: { kind: 'document', documentId: DOC } as const }],
    loadSource: async () => ({ kind: 'document' as const, documentId: DOC, title: '测试文档', text: '只在勾选时发送' }),
  };
  const ui = new EkkoRoomUI(root, options);
  return { dom, root, ui, options, client, links, history, sent, pairInputs, pendingData,
    setWork: (value: string) => { workId = value; }, setDocument: (value: string) => { documentId = value; },
    setConnection: (value: typeof connection) => { currentConnection = { ...value }; },
    setOffline: (value: boolean) => { offline = value; }, setSendResult: (value: 'sent' | 'unknown') => { sendResult = value; },
    setSendGate: (value: Promise<void> | null) => { sendGate = value; },
    setSendError: (value: Error | null) => { sendError = value; },
    emitEvent: (id: string, event: any) => eventCallbacks.get(id)?.(event),
    endEvents: (id: string) => eventEnds.get(id)?.(),
  };
}

async function linked(f: ReturnType<typeof fixture>) {
  await f.ui.enter();
  await f.ui.linkRoom(room.id);
  await f.ui.openRoom(room.id);
}

function delayPersistedClaim(f: ReturnType<typeof fixture>) {
  const remember = f.options.pendingStore.remember.bind(f.options.pendingStore);
  let reached!: () => void;
  let release!: () => void;
  const persisted = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.options.pendingStore.remember = async (link, id) => { await remember(link, id); reached(); await gate; };
  return { persisted, release };
}

test('EKKO 房间入口和独立发送框与 Hermes Chat 分离', async () => {
  const f = fixture();
  assert.ok(f.root.querySelector('[data-thread-selector]'));assert.ok(f.root.querySelector('[data-action="associate-ekko"]'));
  assert.ok(f.root.querySelector('[data-composer]'));
  await f.ui.enter();
  await f.ui.linkRoom(room.id);
  await f.ui.openRoom(room.id);
  assert.equal(f.root.dataset.surface, 'ekko');
  assert.ok(f.root.querySelector('[data-ekko-composer]'));
  assert.notEqual(f.root.querySelector('[data-ekko-composer]'), f.root.querySelector('[data-composer]'));
  f.ui.leave();
  assert.equal(f.root.dataset.surface, 'chat');
  f.ui.dispose();
});

test('配对表单仅提交一次凭据并立即清空密码输入', async () => {
  const f = fixture();
  await f.ui.enter();
  f.setOffline(true);
  await f.ui.refresh();
  const form = f.root.querySelector<HTMLFormElement>('[data-ekko-pair-form]')!;
  form.querySelector<HTMLInputElement>('[name="baseUrl"]')!.value = 'http://127.0.0.1:8748';
  form.querySelector<HTMLInputElement>('[name="username"]')!.value = '测试用户';
  const password = form.querySelector<HTMLInputElement>('[name="password"]')!;
  password.value = '仅此轮输入';
  form.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  assert.equal(password.value, '');
  assert.equal(f.pairInputs.length, 1);
  assert.equal(f.pairInputs[0].password, '仅此轮输入');
  f.ui.dispose();
});

test('同一房间可手动关联两个 Work，失联保留已有关系', async () => {
  const f = fixture();
  await f.ui.enter();
  await f.ui.linkRoom(room.id);
  f.setWork(B);
  await f.ui.workChanged();
  await f.ui.linkRoom(room.id);
  assert.deepEqual(f.links.map(x => x.workId), [A, B]);
  f.setOffline(true);
  await f.ui.refresh();
  assert.equal(f.root.querySelectorAll('[data-ekko-linked-room]').length, 1);
  assert.equal(f.links.length, 2);
  f.ui.dispose();
});

test('房间列表分页可继续加载并明确关联后续房间', async () => {
  const f = fixture();
  f.client.rooms = async (options?: { offset?: number }) => options?.offset ?
    { rooms: [secondRoom], total: 2, hasMore: false } : { rooms: [room], total: 2, hasMore: true };
  await f.ui.enter();
  assert.ok(f.root.querySelector('[data-ekko-action="more-rooms"]'));
  await f.ui.loadMoreRooms();
  await f.ui.linkRoom(secondRoom.id);
  assert.deepEqual(f.links.map(link => link.roomId), [secondRoom.id]);
  f.ui.dispose();
});

test('默认仅发送输入文字；勾选资料时才附带且界面预览范围', async () => {
  const f = fixture();
  await linked(f);
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '请回复';
  await f.ui.sendCurrent();
  assert.equal(f.sent[0].payload.content, '请回复');
  composer.value = '第二轮';
  const checkbox = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  assert.match(f.root.querySelector('[data-ekko-preview]')!.textContent!, /当前文档全文/);
  await f.ui.sendCurrent();
  assert.match(f.sent[1].payload.content, /只在勾选时发送/);
  f.ui.dispose();
});

for (const state of ['draft', 'sending', 'unknown'] as const) test(`引用文章入口打开现有资料区且保留 ${state} 状态`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  let availableReads = 0, sourceReads = 0;
  const availableSources = f.options.availableSources;
  f.options.availableSources = async id => { availableReads++; return availableSources(id); };
  f.options.loadSource = async () => { sourceReads++; throw new Error('打开入口不应读取正文'); };
  await linked(f);
  const composer = roomInput(f, '保留正文与光标', 2);
  const agent = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
  agent.checked = true; agent.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
  let release!: () => void, sending: Promise<void> | undefined;
  if (state === 'unknown') { f.setSendResult('unknown'); await f.ui.sendCurrent(); }
  if (state === 'sending') {
    f.setSendResult('unknown'); f.setSendGate(new Promise<void>(resolve => { release = resolve; }));
    sending = f.ui.sendCurrent(); await tick();
  }
  try {
    const details = f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!;
    const history = f.root.querySelector('[data-ekko-messages]');
    const reply = f.root.querySelector('[data-ekko-reply-preview]');
    const pending = JSON.stringify([...f.pendingData]);
    const unknownId = f.ui.unknownMessageId();
    const before = { availableReads, sourceReads, sends: f.sent.length };
    const caret = [composer.selectionStart, composer.selectionEnd];
    assert.equal(details.open, false);
    assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked').length, 0);
    const entry = f.root.querySelector<HTMLButtonElement>('[data-ekko-send-form] [data-ekko-action="open-sources"]');
    assert.ok(entry, '默认折叠且未选资料时，输入框旁有常显引用文章入口');
    assert.equal(entry.textContent, '引用文章'); assert.equal(entry.type, 'button');
    assert.equal(entry.closest('details'), null); assert.equal(entry.hidden, false);
    entry.click(); entry.click();
    assert.equal(details.open, true, '重复点击仍打开同一个原生资料区');
    assert.equal(f.root.querySelector('[data-ekko-source-details]'), details);
    assert.equal(f.root.querySelector('[data-ekko-composer]'), composer);
    assert.equal(f.root.querySelector('[data-ekko-messages]'), history);
    assert.equal(f.root.querySelector('[data-ekko-reply-preview]'), reply);
    assert.equal(composer.value, '保留正文与光标'); assert.deepEqual([composer.selectionStart, composer.selectionEnd], caret);
    assert.equal(agent.checked, true); assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked').length, 0);
    assert.deepEqual({ availableReads, sourceReads, sends: f.sent.length }, before);
    assert.equal(JSON.stringify([...f.pendingData]), pending); assert.equal(f.ui.unknownMessageId(), unknownId);
  } finally { if (sending) { release(); await sending; } }
});

for (const expanded of [true, false]) test(`刷新资料保留完成时展开状态 ${expanded}，新选区不自动勾选`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  source.checked = true; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  const agent = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
  agent.checked = true; agent.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
  const details = f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!;
  details.open = !expanded;
  let resolve!: (sources: Awaited<ReturnType<EkkoRoomUIOptions['availableSources']>>) => void;
  f.options.availableSources = () => new Promise(done => { resolve = done; });
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="refresh-sources"]')!.click();
  roomInput(f, '读取等待期间编辑的草稿'); details.open = expanded;
  resolve([
    { label: '当前文档全文', source: { kind: 'document', documentId: DOC } },
    { label: '当前选区 · <img src=x onerror=alert(1)>', source: { kind: 'selection', documentId: DOC, blockId: 'fictional-block', selectedText: '明确选区', originalBlock: '前 明确选区 后' } },
  ]);
  await tick();
  assert.equal(f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!.open, expanded);
  const choices = [...f.root.querySelectorAll<HTMLInputElement>('[data-ekko-source]')];
  assert.equal(choices.length, 2); assert.equal(choices[0].checked, true); assert.equal(choices[1].checked, false);
  assert.match(choices[1].parentElement!.textContent!, /<img src=x onerror=alert\(1\)>/);
  assert.equal(f.root.querySelector('[data-ekko-source-details] img,[data-ekko-source-details] [onerror]'), null);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '读取等待期间编辑的草稿');
  assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!.checked, true);
  assert.ok(f.root.querySelector('[data-ekko-reply-preview]')); assert.equal(f.sent.length, 0);
  assert.equal(f.ui.unknownMessageId(), undefined); assert.equal(f.pendingData.size, 0);
});

test('刷新资料失败保留展开区、选择和等待期间草稿，不读取正文或发送', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  const details = f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!; details.open = true;
  const composer = roomInput(f, '刷新前草稿');
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  source.checked = true; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  let fail!: (error: Error) => void, sourceReads = 0;
  f.options.loadSource = async () => { sourceReads++; throw new Error('不应读取正文'); };
  f.options.availableSources = () => new Promise((_done, reject) => { fail = reject; });
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="refresh-sources"]')!.click();
  roomInput(f, '等待期间新草稿'); fail(new Error('虚构资料读取失败')); await tick();
  assert.equal(f.root.querySelector('[data-ekko-source-details]'), details); assert.equal(details.open, true);
  assert.equal(f.root.querySelector('[data-ekko-composer]'), composer); assert.equal(composer.value, '等待期间新草稿');
  assert.equal(source.checked, true); assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!, /刷新资料失败.*虚构资料读取失败/);
  assert.equal(sourceReads, 0); assert.equal(f.sent.length, 0); assert.equal(f.pendingData.size, 0);
});

for (const change of ['room', 'document', 'work'] as const) for (const failed of [false, true]) test(`切换 ${change} 后丢弃迟到资料刷新 ${failed ? '失败' : '成功'}`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  await f.ui.linkRoom(secondRoom.id);
  roomInput(f, '原场景草稿');
  const availableSources = f.options.availableSources;
  let resolve!: (sources: Awaited<ReturnType<EkkoRoomUIOptions['availableSources']>>) => void, reject!: (error: Error) => void;
  f.options.availableSources = () => new Promise((done, fail) => { resolve = done; reject = fail; });
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="refresh-sources"]')!.click();
  f.options.availableSources = availableSources;
  if (change === 'room') await f.ui.openRoom(secondRoom.id);
  else if (change === 'document') { f.setDocument(B); await f.ui.documentChanged(); await f.ui.openRoom(room.id); }
  else { f.setWork(B); await f.ui.workChanged(); await f.ui.linkRoom(room.id); await f.ui.openRoom(room.id); }
  const composer = roomInput(f, '新场景草稿');
  const details = f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!;
  const status = f.root.querySelector('[data-ekko-status]')!.textContent;
  if (failed) reject(new Error('旧场景失败不覆盖新场景'));
  else resolve([{ label: '旧场景迟到选项', source: { kind: 'document', documentId: DOC } }]);
  await tick();
  assert.equal(f.root.querySelector('[data-ekko-composer]'), composer); assert.equal(composer.value, '新场景草稿');
  assert.equal(f.root.querySelector('[data-ekko-source-details]'), details); assert.equal(details.open, false);
  assert.equal(f.root.querySelector('[data-ekko-status]')!.textContent, status);
  assert.doesNotMatch(details.textContent!, /旧场景/); assert.equal(f.sent.length, 0);
});

for (const mode of ['plain', 'document', 'selection', 'cancelled'] as const) test(`引用文章入口后 ${mode} 仍按明确勾选范围发送`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const originalBlock = '选区之前\n明确选中正文\n选区之后';
  f.options.availableSources = async () => [
    { label: '当前文档全文', source: { kind: 'document', documentId: DOC } },
    { label: '当前选区', source: { kind: 'selection', documentId: DOC, blockId: 'fictional-block', selectedText: '明确选中正文', originalBlock } },
  ];
  const reads: string[] = [];
  f.options.loadSource = async source => {
    reads.push(source.kind);
    return source.kind === 'document' ? { kind: 'document', documentId: DOC, title: '虚构文档', text: '文档开头\n全文独有段落\n文档结尾' } :
      { kind: 'block', documentId: DOC, blockId: 'fictional-block', title: '虚构文档', text: originalBlock };
  };
  await linked(f);
  const entry = f.root.querySelector<HTMLButtonElement>('[data-ekko-action="open-sources"]'); assert.ok(entry); entry.click();
  assert.deepEqual(reads, []); assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked').length, 0);
  const choices = [...f.root.querySelectorAll<HTMLInputElement>('[data-ekko-source]')];
  if (mode !== 'plain') {
    const choice = choices[mode === 'selection' ? 1 : 0];
    choice.checked = true; choice.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    assert.match(f.root.querySelector('[data-ekko-preview]')!.textContent!, mode === 'selection' ? /当前选区/ : /当前文档全文/);
    if (mode === 'cancelled') { choice.checked = false; choice.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); }
  }
  roomInput(f, '本轮消息'); await f.ui.sendCurrent(); assert.equal(f.sent.length, 1);
  const content = f.sent[0].payload.content;
  if (mode === 'plain' || mode === 'cancelled') { assert.equal(content, '本轮消息'); assert.deepEqual(reads, []); }
  else if (mode === 'document') { assert.match(content, /文档开头\n全文独有段落\n文档结尾/); assert.doesNotMatch(content, /明确选中正文/); assert.deepEqual(reads, ['document', 'document']); }
  else { assert.match(content, /明确选中正文/); assert.doesNotMatch(content, /选区之前|选区之后|全文独有段落/); assert.deepEqual(reads, ['selection', 'selection']); }
  assert.deepEqual(f.sent[0].payload.mentions, []);
});

test('读取资料期间切换 Work 或文档时阻止发送并保留原草稿', async () => {
  const f = fixture();
  await linked(f);
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '不要误发';
  const checkbox = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  checkbox.checked = true;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.ui.options.loadSource;
  f.ui.options.loadSource = async source => { await gate; return original(source); };
  const pending = f.ui.sendCurrent();
  f.setDocument(B);
  release();
  await pending;
  assert.equal(f.sent.length, 0);
  assert.equal(composer.value, '不要误发');
  f.ui.dispose();
});
test('资料异步读取期间另一窗口换账号时发送前拒绝并保留草稿', async t => {
  const f=fixture();t.after(()=>f.ui.dispose());await linked(f);
  const composer=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;composer.value='保留原账号草稿';
  f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!.checked=true;
  let entered!:()=>void,release!:()=>void;const enteredSource=new Promise<void>(resolve=>{entered=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  const original=f.options.loadSource;f.options.loadSource=async source=>{entered();await gate;return original(source);};
  let received:any;f.client.send=async(_room,_payload,expected)=>{received=expected;throw new BridgeError('身份已变化',403,'identity_changed');};
  const pending=f.ui.sendCurrent();await enteredSource;
  f.client.connection=async()=>({connection:{...connection,id:'connection-two',accountUserId:8}});release();await pending;
  assert.equal(received, undefined);
  assert.equal(composer.value,'保留原账号草稿');assert.equal(f.ui.unknownMessageId(),undefined);
  assert.deepEqual((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items, []);
});
test('旧未决状态查询携带原关联身份，换账号拒绝后保留未决 ID', async t => {
  const f=fixture();t.after(()=>f.ui.dispose());await linked(f);f.setSendResult('unknown');
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value='结果待核对';await f.ui.sendCurrent();const id=f.ui.unknownMessageId();
  let received:any;f.client.sendStatus=async(...args:any[])=>{received=args[2];throw new BridgeError('身份已变化',403,'identity_changed');};
  f.client.connection=async()=>({connection:{...connection,id:'connection-two',accountUserId:8}});await f.ui.checkUnknown();
  assert.deepEqual(received,{connectionId:'connection-one',deviceId:'device-one',accountUserId:7});assert.equal(f.ui.unknownMessageId(),id);
});

test('未知发送保留草稿和消息 ID，不自动重发；HTML 历史仅显示文字', async () => {
  const f = fixture();
  await linked(f);
  assert.match(f.root.querySelector('[data-ekko-messages]')!.textContent!, /<script>alert/);
  assert.equal(f.root.querySelector('[data-ekko-messages] script'), null);
  f.setSendResult('unknown');
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '结果待查';
  await f.ui.sendCurrent();
  assert.equal(composer.value, '结果待查');
  const id = f.sent[0].payload.clientMessageId;
  await f.ui.checkUnknown();
  assert.equal(f.sent.length, 1);
  assert.equal(f.ui.unknownMessageId(), id);
  f.ui.dispose();
});

test('未知发送 ID 只作元数据持久化，重启后可继续核对且不伪造旧草稿', async () => {
  const f = fixture();
  await linked(f);
  f.setSendResult('unknown');
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '不能持久化的正文';
  await f.ui.sendCurrent();
  const id = f.ui.unknownMessageId();
  assert.ok(id);
  const saved = JSON.stringify([...f.pendingData.values()]);
  assert.match(saved, new RegExp(id!));
  assert.doesNotMatch(saved, /不能持久化的正文/);
  f.ui.dispose();
  const reopened = new EkkoRoomUI(f.root, { ...f.options, pendingStore: new PendingRoomSendStore({ loadData: key => f.pendingData.get(key), saveData: (key, value) => { f.pendingData.set(key, value); } }) });
  await reopened.enter();
  await reopened.openRoom(room.id);
  assert.equal(reopened.unknownMessageId(), id);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '');
  assert.ok(f.root.querySelector<HTMLButtonElement>('[data-ekko-action="check-unknown"]:not([hidden])'));
  reopened.dispose();
});

test('未决记录损坏时停止进入发送界面且不覆盖原值', async () => {
  const f = fixture();
  await f.ui.enter();
  await f.ui.linkRoom(room.id);
  const damaged = { schema: 3, items: [{ secret: '保留原值' }] };
  f.pendingData.set('ekko-send-pending-v1', damaged);
  await f.ui.openRoom(room.id);
  assert.equal(f.root.querySelector('[data-ekko-composer]'), null);
  assert.deepEqual(f.pendingData.get('ekko-send-pending-v1'), damaged);
  assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!, /损坏|版本/);
  f.ui.dispose();
});

test('未决标识写盘失败不改原数据对象，也不把正文写入存储', async () => {
  const original = { schema: 1, items: [] as unknown[] };
  const store = new PendingRoomSendStore({ loadData: () => original, saveData: () => { throw new Error('模拟写盘失败'); } });
  const link: RoomLink = { workId: A, connectionId: connection.id, deviceId: connection.deviceId,
    accountUserId: connection.accountUserId, roomId: room.id, roomNameAtLink: room.name };
  await assert.rejects(() => store.remember(link, 'client-one'), /写盘失败/);
  assert.deepEqual(original, { schema: 1, items: [] });
});

test('未决标识保存失败时不提交房间消息，草稿保留且重试仍不发送', async () => {
  const f = fixture();
  await linked(f);
  f.setSendResult('unknown');
  f.options.pendingStore.remember = async () => { throw new Error('模拟保存失败'); };
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '请先核对';
  await f.ui.sendCurrent();
  assert.equal(f.sent.length, 0);
  assert.equal(composer.value, '请先核对');
  assert.equal(f.ui.unknownMessageId(), undefined);
  assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!, /未发送.*模拟保存失败/);
  await f.ui.sendCurrent();
  assert.equal(f.sent.length, 0);
  f.ui.dispose();
});

test('Bridge 明确拒绝房间发言时显示拒绝并保留草稿，不误记为结果未知', async () => {
  const f = fixture();
  await linked(f);
  f.setSendError(new BridgeError('当前账号无房间权限', 403, 'access_denied'));
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '被拒绝的文字';
  await f.ui.sendCurrent();
  assert.equal(composer.value, '被拒绝的文字');
  assert.equal(f.ui.unknownMessageId(), undefined);
  assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!, /发送被拒绝|房间权限/);
  f.ui.dispose();
});

test('人工核对后才可清除未决标识，原草稿清空且后续发送使用新 ID', async () => {
  const f = fixture();
  await linked(f);
  f.setSendResult('unknown');
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '结果未明';
  await f.ui.sendCurrent();
  const oldId = f.ui.unknownMessageId();
  f.dom.window.confirm = () => false;
  await f.ui.discardUnknownAfterReview();
  assert.equal(f.ui.unknownMessageId(), oldId);
  f.dom.window.confirm = () => true;
  await f.ui.discardUnknownAfterReview();
  assert.equal(f.ui.unknownMessageId(), undefined);
  assert.equal(composer.value, '');
  f.setSendResult('sent');
  composer.value = '下一条';
  await f.ui.sendCurrent();
  assert.notEqual(f.sent[1].payload.clientMessageId, oldId);
  f.ui.dispose();
});

test('提交后切换 Work 不串显示，裸 @Agent 不产生结构化唤醒，选择的 Agent 才产生', async () => {
  const f = fixture();
  await linked(f);
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '@助手 你好';
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setSendGate(gate);
  const pending = f.ui.sendCurrent();
  await tick();
  assert.deepEqual(f.sent[0].payload.mentions, []);
  f.setWork(B);
  await f.ui.workChanged();
  release();
  await pending;
  assert.doesNotMatch(f.root.querySelector('[data-ekko-panel]')!.textContent!, /已发送至测试房间/);
  f.setWork(A);
  await f.ui.workChanged();
  await f.ui.openRoom(room.id);
  f.setSendGate(null);
  composer.value = '请检查';
  const agent = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
  agent.checked = true;
  await f.ui.sendCurrent();
  assert.deepEqual(f.sent[1].payload.mentions, [{ type: 'agent', participantId: 'agent-one', displayName: '助手' }]);
  f.ui.dispose();
});

test('两个不同房间的历史和迟到事件隔离，首房间已提交结果不进入第二房间', async () => {
  const f = fixture();
  await f.ui.enter();
  await f.ui.linkRoom(room.id);
  await f.ui.linkRoom(secondRoom.id);
  await f.ui.openRoom(room.id);
  const firstComposer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  firstComposer.value = '发往第一房间';
  let release!: () => void;
  f.setSendGate(new Promise<void>(resolve => { release = resolve; }));
  const pending = f.ui.sendCurrent();
  await tick();
  assert.equal(f.sent[0].roomId, room.id);
  await f.ui.openRoom(secondRoom.id);
  f.emitEvent(room.id, { event: 'room.message', data: message('m-late', '迟到的第一房间消息') });
  release();
  await pending;
  const secondMessages = f.root.querySelector('[data-ekko-messages]')!.textContent!;
  assert.match(secondMessages, /只属于另一房间/);
  assert.doesNotMatch(secondMessages, /迟到的第一房间消息|<script>|发往第一房间/);
  assert.doesNotMatch(f.root.querySelector('[data-ekko-status]')!.textContent!, /已发送至测试房间/);
  f.ui.dispose();
});

test('事件流结束后补读历史，重复消息 ID 只显示一次', async () => {
  const f = fixture();
  await linked(f);
  f.history[room.id].push(message('m-new', '断线期间的新消息'), message('m-new', '断线期间的新消息'));
  f.endEvents(room.id);
  await new Promise(resolve => setTimeout(resolve, 1650));
  const messages = f.root.querySelector('[data-ekko-messages]')!.textContent!;
  assert.equal(messages.match(/断线期间的新消息/g)?.length, 1);
  f.ui.dispose();
});

test('已确认发送后清除本轮资料和 Agent，下一轮默认只发新文字', async () => {
  const f = fixture();
  await linked(f);
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  const agent = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
  source.checked = true; agent.checked = true; composer.value = '第一轮';
  await f.ui.sendCurrent();
  assert.equal(source.checked, false);
  assert.equal(agent.checked, false);
  assert.match(f.root.querySelector('[data-ekko-preview]')!.textContent!, /仅发送消息文字/);
  composer.value = '第二轮';
  await f.ui.sendCurrent();
  assert.equal(f.sent[1].payload.content, '第二轮');
  assert.deepEqual(f.sent[1].payload.mentions, []);
  f.ui.dispose();
});

test('同一 Work 的同名房间在新旧连接下共存时，取消关联只删除所点连接', async () => {
  const f = fixture();
  await f.ui.enter(); await f.ui.linkRoom(room.id);
  const replacement = { ...connection, id: 'connection-two', deviceId: 'device-two', accountUserId: 8, accountName: '第二账号' };
  f.setConnection(replacement); await f.ui.refresh(); await f.ui.linkRoom(room.id);
  assert.equal(f.links.length, 2);
  const rows = f.root.querySelectorAll<HTMLElement>('[data-ekko-linked-room]');
  rows[1].querySelector<HTMLButtonElement>('[data-ekko-action="unlink"]')!.click();
  await tick(); await tick();
  assert.deepEqual(f.links.map(link => link.connectionId), [connection.id]);
  f.ui.dispose();
});

test('刷新发现账号或设备变化时关闭旧房间视图和订阅，关系仍在', async () => {
  const f = fixture();
  await linked(f);
  f.setConnection({ ...connection, id: 'connection-two', accountUserId: 8, accountName: '第二账号' });
  await f.ui.refresh();
  assert.equal(f.root.querySelector('[data-ekko-composer]'), null);
  assert.equal(f.root.querySelector('[data-ekko-messages]'), null);
  assert.equal(f.links.length, 1);
  f.emitEvent(room.id, { event: 'room.message', data: message('old-late', '旧账号迟到消息') });
  assert.doesNotMatch(f.root.querySelector('[data-ekko-panel]')!.textContent!, /旧账号迟到消息/);
  f.ui.dispose();
});

test('房间 POST 前先保存同一个客户端消息 ID；明确成功后清除标识', async () => {
  const f = fixture();
  await linked(f);
  let observed: unknown;
  const originalSend = f.client.send;
  f.client.send = async (...args: Parameters<typeof originalSend>) => {
    observed = f.pendingData.get('ekko-send-pending-v1');
    return originalSend(...args);
  };
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '先落 ID';
  await f.ui.sendCurrent();
  assert.match(JSON.stringify(observed), new RegExp(f.sent[0].payload.clientMessageId));
  assert.equal(f.ui.unknownMessageId(), undefined);
  assert.deepEqual((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items, []);
  f.ui.dispose();
});

test('落未决 ID 失败时不得调用网络 POST，保留草稿和勾选', async () => {
  const f = fixture(); await linked(f);
  f.options.pendingStore.remember = async () => { throw new Error('模拟写盘失败'); };
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  composer.value = '不能冒险外发'; source.checked = true;
  await f.ui.sendCurrent();
  assert.equal(f.sent.length, 0);
  assert.equal(composer.value, '不能冒险外发');
  assert.equal(source.checked, true);
  assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!, /未发送|保存失败/);
  f.ui.dispose();
});

test('网络 POST 等待回执期间重启仍可从已落盘 ID 核对', async () => {
  const f = fixture(); await linked(f);
  let release!: () => void;
  f.setSendGate(new Promise<void>(resolve => { release = resolve; }));
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '模拟崩溃间隙';
  const pending = f.ui.sendCurrent();
  await tick();
  try {
    assert.equal(f.sent.length, 1);
    const id = f.sent[0].payload.clientMessageId;
    f.ui.dispose();
    const restarted = new EkkoRoomUI(f.root, f.options);
    await restarted.enter(); await restarted.openRoom(room.id);
    assert.equal(restarted.unknownMessageId(), id);
    restarted.dispose();
  } finally { release(); await pending; }
});

test('两个面板同房间并发发送只允许一个落盘 claim 进入网络', async () => {
  const f = fixture(); await linked(f);
  const secondRoot = f.dom.window.document.createElement('div');
  secondRoot.innerHTML = createChatShell();
  f.dom.window.document.body.append(secondRoot);
  const second = new EkkoRoomUI(secondRoot.querySelector<HTMLElement>('.sac')!, f.options);
  await second.enter(); await second.openRoom(room.id);
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '第一面板';
  secondRoot.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '第二面板';
  let release!: () => void;
  f.setSendGate(new Promise<void>(resolve => { release = resolve; }));
  const firstSend = f.ui.sendCurrent();
  const secondSend = second.sendCurrent();
  await tick();
  const count = f.sent.length;
  release(); await Promise.all([firstSend, secondSend]);
  assert.equal(count, 1);
  assert.equal(f.sent.length, 1);
  second.dispose(); f.ui.dispose();
});

test('明确拒绝后释放预存 ID；清理失败仍保留草稿和 ID 并阻止重发', async () => {
  const f = fixture(); await linked(f);
  f.setSendError(new BridgeError('无房间权限', 403, 'access_denied'));
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '被拒绝'; await f.ui.sendCurrent();
  assert.equal(f.ui.unknownMessageId(), undefined);
  assert.deepEqual((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items, []);
  f.options.pendingStore.clear = async () => { throw new Error('模拟清理失败'); };
  composer.value = '第二次被拒绝'; await f.ui.sendCurrent();
  assert.ok(f.ui.unknownMessageId());
  assert.equal(composer.value, '第二次被拒绝');
  const sent = f.sent.length;
  await f.ui.sendCurrent(); assert.equal(f.sent.length, sent);
  f.ui.dispose();
});

test('确认发送后若本地标识清理失败，保留草稿与勾选并阻止再次提交', async () => {
  const f = fixture();
  await linked(f);
  f.options.pendingStore.clear = async () => { throw new Error('模拟清理失败'); };
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  composer.value = '需人工核对'; source.checked = true;
  await f.ui.sendCurrent();
  assert.equal(f.sent.length, 1);
  assert.equal(composer.value, '需人工核对');
  assert.equal(source.checked, true);
  assert.ok(f.ui.unknownMessageId());
  assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!, /发送已确认.*清理失败/);
  await f.ui.sendCurrent();
  assert.equal(f.sent.length, 1);
  f.ui.dispose();
});

test('核对旧消息等待补读时切房间，旧结果不得覆盖新房间状态', async () => {
  const f = fixture(); await f.ui.enter(); await f.ui.linkRoom(room.id); await f.ui.linkRoom(secondRoom.id); await f.ui.openRoom(room.id);
  f.setSendResult('unknown');
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '待核对'; await f.ui.sendCurrent();
  f.client.sendStatus = async () => ({ state: 'sent' as const });
  const oldRoom = f.client.room;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.client.room = async (id: string) => { if (id === room.id) await gate; return oldRoom(id); };
  const checking = f.ui.checkUnknown();
  await tick();
  await f.ui.openRoom(secondRoom.id);
  release(); await checking;
  assert.doesNotMatch(f.root.querySelector('[data-ekko-status]')!.textContent!, /已在房间历史核对到上一条消息/);
  f.ui.dispose();
});

test('已确认发送但补读历史失败时明确显示历史失败，不覆盖为全成功', async () => {
  const f = fixture(); await linked(f);
  f.client.room = async () => { throw new Error('补读失败'); };
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '消息已提交';
  await f.ui.sendCurrent();
  assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!, /补读历史失败|补读失败/);
  f.ui.dispose();
});

test('未决 ID 已落盘但回调延迟时切换房间，不提交旧房间消息并清除未发送标识', async () => {
  const f = fixture();
  await f.ui.enter(); await f.ui.linkRoom(room.id); await f.ui.linkRoom(secondRoom.id); await f.ui.openRoom(room.id);
  const claim = delayPersistedClaim(f);
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '仍在旧房间的草稿';
  const sending = f.ui.sendCurrent();
  await claim.persisted;
  assert.equal((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items.length, 1);
  await f.ui.openRoom(secondRoom.id);
  claim.release(); await sending;
  assert.equal(f.sent.length, 0);
  assert.deepEqual((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items, []);
  await f.ui.openRoom(room.id);
  assert.equal(f.ui.unknownMessageId(), undefined);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '仍在旧房间的草稿');
  f.ui.dispose();
});

for (const changed of ['Work', 'document'] as const) {
  test(`未决 ID 落盘等待期间切换 ${changed}，不提交且安全释放预存标识`, async () => {
    const f = fixture(); await linked(f);
    const claim = delayPersistedClaim(f);
    f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = `切换 ${changed} 前的草稿`;
    const sending = f.ui.sendCurrent(); await claim.persisted;
    if (changed === 'Work') { f.setWork(B); await f.ui.workChanged(); }
    else { f.setDocument(B); await f.ui.documentChanged(); }
    claim.release(); await sending;
    assert.equal(f.sent.length, 0);
    assert.deepEqual((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items, []);
    if (changed === 'Work') { f.setWork(A); await f.ui.workChanged(); }
    else { f.setDocument(DOC); await f.ui.documentChanged(); }
    await f.ui.openRoom(room.id);
    assert.equal(f.ui.unknownMessageId(), undefined);
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, `切换 ${changed} 前的草稿`);
    f.ui.dispose();
  });
}

test('落盘等待期间勾选资料或资料正文改变，发送前重读并取消未发送标识', async () => {
  for (const change of ['selection', 'source-text'] as const) {
    const f = fixture(); await linked(f);
    let sourceText = '原始资料';
    f.options.loadSource = async () => ({ kind: 'document', documentId: DOC, title: '测试文档', text: sourceText });
    const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
    source.checked = true;
    const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
    composer.value = '资料只发送当前版';
    const claim = delayPersistedClaim(f);
    const sending = f.ui.sendCurrent(); await claim.persisted;
    if (change === 'selection') { source.checked = false; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); }
    else sourceText = '后来修改的资料';
    claim.release(); await sending;
    assert.equal(f.sent.length, 0, change);
    assert.deepEqual((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items, [], change);
    assert.equal(f.ui.unknownMessageId(), undefined, change);
    assert.equal(composer.value, '资料只发送当前版', change);
    f.ui.dispose();
  }
});

test('连接或关联核对延迟时资料改变，最后重读拒绝旧正文且不 POST', async () => {
  for (const delayed of ['connection', 'link'] as const) {
    const f = fixture(); await linked(f);
    let sourceText = '最初文档正文';
    f.options.loadSource = async () => ({ kind: 'document', documentId: DOC, title: '测试文档', text: sourceText });
    const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
    const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
    source.checked = true; composer.value = '只发送最新资料';
    let reached!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let probes = 0;
    if (delayed === 'connection') {
      const original = f.client.connection;
      f.client.connection = async () => { if (++probes === 2) { reached(); await gate; } return original(); };
    } else {
      const original = f.options.store.assertLinked;
      f.options.store.assertLinked = async (...args) => { if (++probes === 2) { reached(); await gate; } return original(...args); };
    }
    const sending = f.ui.sendCurrent();
    await waiting;
    assert.equal((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items.length, 1, delayed);
    sourceText = '连接检查期间修改的文档正文';
    release(); await sending;
    assert.equal(f.sent.length, 0, delayed);
    assert.deepEqual((f.pendingData.get('ekko-send-pending-v1') as { items: unknown[] }).items, [], delayed);
    assert.equal(f.ui.unknownMessageId(), undefined, delayed);
    assert.equal(composer.value, '只发送最新资料', delayed);
    assert.equal(source.checked, true, delayed);
    f.ui.dispose();
  }
});

test('发送前校验失败且预存标识无法清理时不 POST，保留阻止标识和明确提示', async () => {
  const f = fixture(); await linked(f);
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '校验期间被修改';
  const claim = delayPersistedClaim(f);
  const sending = f.ui.sendCurrent(); await claim.persisted;
  f.options.pendingStore.clear = async () => { throw new Error('模拟清理失败'); };
  composer.value = '新的草稿'; composer.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  claim.release(); await sending;
  assert.equal(f.sent.length, 0);
  assert.equal(composer.value, '新的草稿');
  assert.ok(f.ui.unknownMessageId());
  assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!, /未发送.*清理失败/);
  await f.ui.sendCurrent(); assert.equal(f.sent.length, 0);
  f.ui.dispose();
});

test('旧消息核对为已发送时即使切房间，也清除旧草稿与勾选并避免重发', async () => {
  const f = fixture(); await f.ui.enter(); await f.ui.linkRoom(room.id); await f.ui.linkRoom(secondRoom.id); await f.ui.openRoom(room.id);
  f.setSendResult('unknown');
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  const agent = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
  composer.value = '已发但尚未核对'; source.checked = true; agent.checked = true;
  await f.ui.sendCurrent();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.client.sendStatus = async () => { await gate; return { state: 'sent' }; };
  const checking = f.ui.checkUnknown();
  await f.ui.openRoom(secondRoom.id);
  release(); await checking;
  await f.ui.openRoom(room.id);
  assert.equal(f.ui.unknownMessageId(), undefined);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '');
  assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!.checked, false);
  assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!.checked, false);
  f.ui.dispose();
});

test('核对等待期间新编辑的文字、资料和 Agent 勾选保留', async () => {
  const f = fixture(); await linked(f);
  f.setSendResult('unknown');
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  composer.value = '上一条'; await f.ui.sendCurrent();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.client.sendStatus = async () => { await gate; return { state: 'sent' }; };
  const checking = f.ui.checkUnknown();
  composer.value = '核对时新写的草稿'; composer.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  const agent = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
  source.checked = true; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  agent.checked = true; agent.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  release(); await checking;
  assert.equal(f.ui.unknownMessageId(), undefined);
  assert.equal(composer.value, '核对时新写的草稿');
  assert.equal(source.checked, true);
  assert.equal(agent.checked, true);
  f.ui.dispose();
});

test('核对期间仅编辑一部分草稿时，只保留新编辑部分而清除已确认旧内容', async () => {
  for (const changed of ['text', 'source'] as const) {
    const f = fixture(); await linked(f);
    f.setSendResult('unknown');
    const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
    const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
    const agent = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
    composer.value = '已发送的旧文字';
    if (changed === 'text') { source.checked = true; agent.checked = true; }
    await f.ui.sendCurrent();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.client.sendStatus = async () => { await gate; return { state: 'sent' }; };
    const checking = f.ui.checkUnknown();
    if (changed === 'text') {
      composer.value = '新写的文字'; composer.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    } else {
      source.checked = true; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    }
    release(); await checking;
    assert.equal(composer.value, changed === 'text' ? '新写的文字' : '', changed);
    assert.equal(source.checked, changed === 'source', changed);
    assert.equal(agent.checked, false, changed);
    f.ui.dispose();
  }
});

test('人工放弃未决后清空该轮资料和 Agent，下一条仅发送新文字', async () => {
  const f = fixture(); await linked(f);
  f.setSendResult('unknown');
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
  const agent = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
  composer.value = '放弃的旧草稿'; source.checked = true; agent.checked = true;
  await f.ui.sendCurrent();
  f.dom.window.confirm = () => true;
  await f.ui.discardUnknownAfterReview();
  assert.equal(composer.value, '');
  assert.equal(source.checked, false);
  assert.equal(agent.checked, false);
  assert.match(f.root.querySelector('[data-ekko-preview]')!.textContent!, /仅发送消息文字/);
  f.setSendResult('sent'); composer.value = '新一轮'; await f.ui.sendCurrent();
  assert.equal(f.sent[1].payload.content, '新一轮');
  assert.deepEqual(f.sent[1].payload.mentions, []);
  f.ui.dispose();
});
for(const operation of ['older','reload','events'])test(`identity rejection isolates active view for ${operation}`,async()=>{
 const f=fixture();try{await linked(f);const state=f.ui as any;state.active.hasMore=true;
 if(operation==='events')f.emitEvent(room.id,{event:'room.disconnected',data:{reason:'identity_changed',state:'denied'}});
 else {f.client.room=async()=>{throw new BridgeError('changed',403,'identity_changed');};if(operation==='older')await f.ui.loadOlder();else await state.reloadHistory(state.active,state.version);}
 await tick();assert.equal(f.root.querySelector('[data-ekko-composer]'),null);assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/身份|账号/);
 }finally{f.ui.dispose();}
});
for(const mutation of ['reorder','remove','rename'])test(`Agent selection stays explicit after ${mutation}`,async()=>{
 const f=fixture();try{
 const agents=[{agentId:'a',name:'A',roomId:room.id},{agentId:'b',name:'B',roomId:room.id}];
 f.client.room=async()=>({room,messages:[],agents,hasMore:false});await linked(f);
 const box=f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;box.checked=true;box.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
 f.client.room=async()=>({room,messages:[],agents:mutation==='reorder'?[agents[1],agents[0]]:mutation==='remove'?[agents[1]]:[{...agents[0],name:'Renamed'},agents[1]],hasMore:false});
 const state=f.ui as any;await state.reloadHistory(state.active,state.version);
 assert.deepEqual(state.selectedAgents().map((a:any)=>a.agentId),mutation==='reorder'?['a']:[]);
 if(mutation!=='reorder')assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/重新选择|核对/);
 }finally{f.ui.dispose();}
});
test('rebuilt composer edited during prepare does not send detached old draft',async()=>{
 const f=fixture();try{await linked(f);f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value='old draft';
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const original=f.client.connection;
 f.client.connection=async()=>{entered();await gate;return original();};const sending=f.ui.sendCurrent();await started;
 (f.ui as any).saveVisibleDraft();(f.ui as any).render();f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value='new draft';release();await sending;
 assert.equal(f.sent.length,0);assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value,'new draft');
 }finally{f.ui.dispose();}
});
test('reconnect backfill reads beyond latest hundred to known anchor',async()=>{
 const f=fixture();try{await linked(f);const calls:any[]=[];
 (f.client.room as any)=async(_id:string,options:any,expected:any)=>{calls.push({options,expected});return {room,agents:[],hasMore:!options.before,messages:options.before?[message('m-1','anchor'),message('middle','middle')]:Array.from({length:100},(_,i)=>message(`new-${i}`,`new-${i}`))};};
 const state=f.ui as any;await state.reloadHistory(state.active,state.version);
 assert.equal(calls.length,2);assert.equal(calls[1].options.before,'new-0');assert.equal(calls[1].expected.connectionId,connection.id);assert.match(f.root.querySelector('[data-ekko-messages]')!.textContent!,/middle/);
 }finally{f.ui.dispose();}
});
test('reconnect with missing anchor reports incomplete history',async()=>{
 const f=fixture();try{await linked(f);f.client.room=async()=>({room,agents:[],hasMore:false,messages:[message('new','new')]});const state=f.ui as any;
 await state.reloadHistory(state.active,state.version);assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/未补齐/);
 }finally{f.ui.dispose();}
});
test('failed backfill retains original anchor on later reload',async()=>{
 const f=fixture();try{await linked(f);let round=0;const calls:any[]=[];(f.client.room as any)=async(_id:string,options:any)=>{calls.push(options);return {room,agents:[],hasMore:round>0&&!options.before,messages:options.before?[message('m-1','anchor'),message('middle','middle')]:[message('new','new')]};};
 const state=f.ui as any;await state.reloadHistory(state.active,state.version);round++;await state.reloadHistory(state.active,state.version);
 assert.equal(calls.length,3);assert.match(f.root.querySelector('[data-ekko-messages]')!.textContent!,/middle/);
 }finally{f.ui.dispose();}
});
test('identity rejection during pending check stops subscription and isolates pending draft',async()=>{
 const f=fixture();try{await linked(f);f.setSendResult('unknown');f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value='pending';await f.ui.sendCurrent();const id=f.ui.unknownMessageId();
 f.client.sendStatus=async()=>{throw new BridgeError('changed',403,'identity_changed');};await f.ui.checkUnknown();
 assert.equal(f.ui.unknownMessageId(),id);assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.disabled,true);
 f.emitEvent(room.id,{event:'room.message',data:message('foreign','foreign')});assert.doesNotMatch(f.root.querySelector('[data-ekko-messages]')!.textContent!,/foreign/);
 }finally{f.ui.dispose();}
});
test('late forbidden response from old stream cannot stop current room subscription',async()=>{
 const f=fixture();try{let rejectOld!:(error:Error)=>void;let currentSignal:AbortSignal|undefined;
 f.client.events=async(id,onEvent,signal)=>{if(id===room.id)return new Promise<void>((_resolve,reject)=>{rejectOld=reject;});currentSignal=signal;return new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve()));};
 await linked(f);await f.ui.linkRoom(secondRoom.id);await f.ui.openRoom(secondRoom.id);rejectOld(new BridgeError('denied',403,'access_denied'));await tick();
 assert.equal(currentSignal?.aborted,false);assert.ok(f.root.querySelector('[data-ekko-composer]'));
 }finally{f.ui.dispose();}
});
for(const scenario of ['complete','budget','failure'])test(`empty initial room backfills new history: ${scenario}`,async()=>{
 const f=fixture();try{
 f.history[room.id]=[];await linked(f);const state=f.ui as any;
 const total=scenario==='budget'?2050:250;
 const messages=Array.from({length:total},(_,i)=>({...message(`m${i}`,`item ${i}`),timestamp:new Date(1790553600000+i*1000).toISOString()}));
 const calls:any[]=[];let failed=false;
 (f.client.room as any)=async(_id:string,options:any,expected:any)=>{
  calls.push({options,expected});if(scenario==='failure'&&options.before&&!failed){failed=true;throw new Error('temporary history failure');}
  const end=options.before?messages.findIndex(item=>item.id===options.before):messages.length;
  const start=Math.max(0,end-options.limit);return {room,messages:messages.slice(start,end),agents:[],hasMore:start>0};
 };
 await state.reloadHistory(state.active,state.version);
 const shown=()=>f.root.querySelectorAll('[data-ekko-messages] article').length;
 if(scenario==='complete'){
  assert.equal(calls.length,3);assert.equal(shown(),250);assert.equal(state.active.historyAnchor,'m249');assert.equal(state.active.hasMore,false);assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/历史已补齐/);
 }else{
  assert.equal(calls.length,scenario==='budget'?20:2);assert.equal(shown(),scenario==='budget'?2000:100);
  assert.equal(state.active.historyAnchor,null);assert.equal(state.active.hasMore,true);assert.ok(f.root.querySelector('[data-ekko-action="older"]'));assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/未补齐/);
  await f.ui.loadOlder();assert.equal(shown(),scenario==='budget'?2050:200);
  if(scenario==='failure'){await state.reloadHistory(state.active,state.version);assert.equal(shown(),250);assert.equal(state.active.historyAnchor,'m249');}
 }
 for(const {expected} of calls)assert.equal(expected.connectionId,connection.id);
 }finally{f.ui.dispose();}
});
function numberedHistory(last: number) {
 return Array.from({length:last+1},(_,i)=>({...message(`m${i}`,`number ${i}`),timestamp:new Date(1790553600000+i*1000).toISOString()}));
}
function servePagedHistory(f: ReturnType<typeof fixture>, messages: ReturnType<typeof numberedHistory>) {
 const calls:Array<{before?:string;expected:any}>=[];
 (f.client.room as any)=async(_id:string,options:any,expected:any)=>{
  calls.push({before:options.before,expected});const end=options.before?messages.findIndex(item=>item.id===options.before):messages.length;
  assert.ok(end>=0,'requested cursor exists in independent fixture');const start=Math.max(0,end-options.limit);
  return {room,messages:messages.slice(start,end),agents:[],hasMore:start>0};
 };
 return calls;
}
test('manual backfill resumes the unresolved gap before old cached anchor',async()=>{
 const f=fixture();try{f.history[room.id]=numberedHistory(0);await linked(f);const calls=servePagedHistory(f,numberedHistory(2050));const state=f.ui as any;
 await state.reloadHistory(state.active,state.version);assert.equal(calls.length,20);assert.equal(state.active.historyAnchor,'m0');assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/未补齐/);
 f.emitEvent(room.id,{event:'room.message',data:numberedHistory(2051).at(-1)});
 await f.ui.loadOlder();assert.equal(calls.at(-2)!.before,'m51');assert.equal(calls.at(-1)!.before,undefined,'check latest after closing the gap');assert.equal(f.root.querySelectorAll('[data-ekko-messages] article').length,2052);
 assert.equal(state.active.historyAnchor,'m2050','live arrival must not advance the backfill success boundary');assert.equal(state.active.hasMore,false);assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/历史已补齐/);
 for(const call of calls)assert.equal(call.expected.connectionId,connection.id);
 }finally{f.ui.dispose();}
});
test('reopening same Work identity room preserves anchor and fills missing middle',async()=>{
 const f=fixture();try{f.history[room.id]=numberedHistory(0);await linked(f);f.ui.leave();const calls=servePagedHistory(f,numberedHistory(250));await f.ui.enter();const state=f.ui as any;
 assert.equal(f.root.querySelectorAll('[data-ekko-messages] article').length,251);assert.equal(state.active.historyAnchor,'m250');assert.ok(calls.some(call=>call.before==='m151'));assert.equal(state.active.hasMore,false);assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/历史已补齐/);
 }finally{f.ui.dispose();}
});
test('manual gap failure retains its cursor and successful anchor for retry',async()=>{
 const f=fixture();try{f.history[room.id]=numberedHistory(0);await linked(f);servePagedHistory(f,numberedHistory(2050));const state=f.ui as any;await state.reloadHistory(state.active,state.version);
 f.client.room=async()=>{throw new Error('offline');};await f.ui.loadOlder();assert.equal(state.active.historyAnchor,'m0');assert.ok(f.root.querySelector('[data-ekko-action="older"]'));
 const calls=servePagedHistory(f,numberedHistory(2050));await f.ui.loadOlder();assert.equal(calls[0].before,'m51');assert.equal(state.active.historyAnchor,'m2050');assert.equal(f.root.querySelectorAll('[data-ekko-messages] article').length,2051);
 }finally{f.ui.dispose();}
});
test('normal older paging and reopen preserve loaded old history without filling to beginning',async()=>{
 const f=fixture();try{const calls=servePagedHistory(f,numberedHistory(250));await linked(f);const state=f.ui as any;
 assert.equal(calls.length,1);assert.equal(f.root.querySelectorAll('[data-ekko-messages] article').length,100);await f.ui.loadOlder();assert.equal(calls.at(-1)!.before,'m151');assert.equal(state.active.historyAnchor,'m250');assert.equal(state.active.hasMore,true);
 f.ui.leave();await f.ui.enter();assert.equal(f.root.querySelectorAll('[data-ekko-messages] article').length,200);assert.equal(state.active.hasMore,true);await f.ui.loadOlder();assert.equal(calls.at(-1)!.before,'m51');assert.equal(f.root.querySelectorAll('[data-ekko-messages] article').length,251);assert.equal(state.active.hasMore,false);
 }finally{f.ui.dispose();}
});
for(const changed of ['work','identity'])test(`history progress remains isolated after changing ${changed}`,async()=>{
 const f=fixture();try{f.history[room.id]=numberedHistory(0);await linked(f);
 if(changed==='work'){f.setWork(B);await f.ui.workChanged();}else{f.setConnection({...connection,id:'connection-two',accountUserId:8});await f.ui.refresh();}
 const calls=servePagedHistory(f,numberedHistory(250));await f.ui.linkRoom(room.id);await f.ui.openRoom(room.id);
 assert.equal(calls.length,1,'a new Work or identity must not inherit the old m0 anchor');assert.equal(f.root.querySelectorAll('[data-ekko-messages] article').length,100);
 assert.equal(calls[0].expected.connectionId,changed==='identity'?'connection-two':connection.id);
 }finally{f.ui.dispose();}
});
test('manual history read waits while automatic backfill owns the cursor',async()=>{
 const f=fixture();try{f.history[room.id]=numberedHistory(0);await linked(f);servePagedHistory(f,numberedHistory(2050));const state=f.ui as any;await state.reloadHistory(state.active,state.version);
 const original=f.client.room;let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let calls=0;
 (f.client.room as any)=async(...args:any[])=>{calls++;entered();await gate;return (original as any)(...args);};
 const manual=f.ui.loadOlder();await started;await state.reloadHistory(state.active,state.version);assert.equal(calls,1);release();await manual;assert.equal(state.active.historyAnchor,'m2050');assert.equal(state.active.hasMore,false);
 }finally{f.ui.dispose();}
});
test('automatic manual automatic manual backfill keeps moving toward old anchor',async()=>{
 const f=fixture();try{f.history[room.id]=numberedHistory(0);await linked(f);const calls=servePagedHistory(f,numberedHistory(5000));const state=f.ui as any;
 await state.reloadHistory(state.active,state.version);assert.equal(state.active.gap.before,'m3001');
 await f.ui.loadOlder();assert.equal(state.active.gap.before,'m2901');const next=calls.length;
 await state.reloadHistory(state.active,state.version);assert.equal(calls[next].before,'m2901');assert.equal(state.active.gap.before,'m901');
 await f.ui.loadOlder();assert.equal(calls.at(-1)!.before,'m901');assert.equal(state.active.gap.before,'m801');assert.equal(state.active.historyAnchor,'m0');assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/未补齐/);
 }finally{f.ui.dispose();}
});
test('new upper gap waits for old gap completion and is never marked complete early',async()=>{
 const f=fixture();try{f.history[room.id]=numberedHistory(0);await linked(f);servePagedHistory(f,numberedHistory(2050));const state=f.ui as any;await state.reloadHistory(state.active,state.version);assert.equal(state.active.gap.before,'m51');
 const calls=servePagedHistory(f,numberedHistory(5000));
 await f.ui.loadOlder();assert.equal(calls[0].before,'m51');assert.ok(calls.length>=2,'must recheck latest history after closing the old gap');assert.equal(calls[1].before,undefined,'verify latest only after old gap closes');
 assert.equal(state.active.historyAnchor,'m2050');assert.equal(state.active.gap.before,'m3001');assert.equal(state.active.gap.newestAnchor,'m5000');assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/未补齐/);
 await state.reloadHistory(state.active,state.version);assert.equal(state.active.historyAnchor,'m5000');assert.equal(state.active.gap,undefined);assert.equal(f.root.querySelectorAll('[data-ekko-messages] article').length,5001);assert.match(f.root.querySelector('[data-ekko-status]')!.textContent!,/历史已补齐/);
 }finally{f.ui.dispose();}
});

test('房间输入区可从顶部拖高，刷新及切换房间后保留高度和草稿', async () => {
  const f = fixture();
  try {
    await linked(f);
    const textarea = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
    textarea.value = '保留房间草稿';
    textarea.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    const history = f.root.querySelector<HTMLElement>('[data-ekko-messages]')!;
    Object.defineProperty(history, 'clientHeight', { value: 180 });
    textarea.getBoundingClientRect = () => ({ height: parseFloat(textarea.style.height) || 38 }) as DOMRect;
    const grip = f.root.querySelector<HTMLElement>('[data-ekko-send-form] [data-composer-resize]');
    assert.ok(grip, '房间需要与 AI 对话相同的可聚焦顶部拖动条');
    const pointer = (type: string, y: number) => {
      const event = new f.dom.window.MouseEvent(type, { bubbles: true, button: 0, clientY: y });
      Object.defineProperty(event, 'pointerId', { value: 7 });
      return event;
    };
    grip.dispatchEvent(pointer('pointerdown', 200));
    f.dom.window.dispatchEvent(pointer('pointermove', 130));
    f.dom.window.dispatchEvent(pointer('pointerup', 130));
    assert.equal(textarea.style.height, '108px');
    assert.equal(textarea.value, '保留房间草稿');
    // JSDOM has no layout; each newly rendered message pane needs the same synthetic free space.
    Object.defineProperty(f.dom.window.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return (this as HTMLElement).matches('[data-ekko-messages]')?180:0;}});
    await f.ui.refresh();
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.style.height, '108px');
    await f.ui.linkRoom(secondRoom.id);
    await f.ui.openRoom(secondRoom.id);
    assert.notEqual(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.style.height, '108px');
    await f.ui.openRoom(room.id);
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.style.height, '108px');
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '保留房间草稿');
  } finally { f.ui.dispose(); f.dom.window.close(); }
});

test('离开房间时停止正在拖动的输入区，避免影响隐藏房间或 AI 对话', async () => {
  const f = fixture();
  try {
    await linked(f);
    const textarea = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
    const history = f.root.querySelector<HTMLElement>('[data-ekko-messages]')!;
    Object.defineProperty(history, 'clientHeight', { value: 180 });
    textarea.getBoundingClientRect = () => ({ height: parseFloat(textarea.style.height) || 38 }) as DOMRect;
    const grip = f.root.querySelector<HTMLElement>('[data-ekko-send-form] [data-composer-resize]');
    assert.ok(grip);
    grip.dispatchEvent(new f.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientY: 200 }));
    f.ui.leave();
    f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointermove', { bubbles: true, clientY: 100 }));
    assert.equal(textarea.style.height, '');
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-composer]')!.style.height, '');
  } finally { f.ui.dispose(); f.dom.window.close(); }
});

test('房间历史与资料确认成功后清除读取提示，保留未决发送核对入口', async () => {
  const f=fixture();
  try {
    await f.ui.enter();await f.ui.linkRoom(room.id);
    const link=f.links.find(item=>item.roomId===room.id)!;
    await f.options.pendingStore.remember(link,'fictional-pending-loading');
    await f.ui.openRoom(room.id);
    assert.equal(f.root.querySelector('[data-ekko-status]')!.textContent,'');
    assert.equal(f.ui.unknownMessageId(),'fictional-pending-loading');
    assert.ok(f.root.querySelector('[data-ekko-action="check-unknown"]:not([hidden])'));
    assert.equal((await f.options.pendingStore.get(link))?.clientMessageId,'fictional-pending-loading');
  } finally {f.ui.dispose();f.dom.window.close();}
});

for(const stage of ['history','sources','pending'] as const)test(`房间${stage}尚未确认时保留读取提示，失败时保留错误`,async()=>{
  const f=fixture();
  try {
    await f.ui.enter();await f.ui.linkRoom(room.id);
    let reached!:()=>void,reject!:(error:Error)=>void;
    const entered=new Promise<void>(resolve=>reached=resolve);
    const gate=()=>{reached();return new Promise<never>((_resolve,fail)=>reject=fail);};
    if(stage==='history')f.client.room=gate;
    else if(stage==='sources')f.options.availableSources=gate;
    else f.options.pendingStore.get=gate;
    const opening=f.ui.openRoom(room.id);await entered;
    assert.match(f.root.querySelector('[data-ekko-status]')!.textContent||'',/正在读取房间历史和可选资料/);
    reject(Error('fictional room read failed'));await opening;
    assert.match(f.root.querySelector('[data-ekko-status]')!.textContent||'',/无法进入房间.*fictional room read failed/);
  } finally {f.ui.dispose();f.dom.window.close();}
});

test('迟到房间成功不能清除新页面读取提示或身份失败',async()=>{
  const f=fixture();
  try {
    await f.ui.enter();await f.ui.linkRoom(room.id);await f.ui.linkRoom(secondRoom.id);
    const roomRead=f.client.room.bind(f.client);let release!:(value:any)=>void,reached!:()=>void;
    const entered=new Promise<void>(resolve=>reached=resolve);
    f.client.room=async(id,...args)=>id===room.id?(reached(),await new Promise<any>(resolve=>release=resolve)):roomRead(id,...args);
    const oldOpening=f.ui.openRoom(room.id);await entered;
    let releaseNew!:(value:any)=>void,newReached!:()=>void;
    const newEntered=new Promise<void>(resolve=>newReached=resolve);
    f.options.availableSources=()=>{newReached();return new Promise(resolve=>releaseNew=resolve);};
    const newOpening=f.ui.openRoom(secondRoom.id);await newEntered;
    release(await roomRead(room.id));await oldOpening;
    assert.match(f.root.querySelector('[data-ekko-status]')!.textContent||'',/正在读取房间历史和可选资料/);
    (f.ui as any).rejectIdentity({code:'identity_changed'});
    releaseNew([]);await newOpening;
    assert.match(f.root.querySelector('[data-ekko-status]')!.textContent||'',/账号身份已变化/);
  } finally {f.ui.dispose();f.dom.window.close();}
});

test('房间读取成功只移除本次读取提示，不覆盖期间新增的未知状态提示',async()=>{
  const f=fixture();
  try {
    await f.ui.enter();await f.ui.linkRoom(room.id);
    f.options.availableSources=async()=>{(f.ui as any).setStatus('fictional unknown operation requires review');return [];};
    await f.ui.openRoom(room.id);
    assert.equal(f.root.querySelector('[data-ekko-status]')!.textContent,'fictional unknown operation requires review');
  } finally {f.ui.dispose();f.dom.window.close();}
});

// Real room controller, synthetic identities and transport only.
function roomInput(f: ReturnType<typeof fixture>, value: string, caret = value.length) {
  const input = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
  input.value = value; input.focus(); input.setSelectionRange(caret, caret);
  input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  return input;
}
function roomKey(f: ReturnType<typeof fixture>, key: string, isComposing = false) {
  const event = new f.dom.window.KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true });
  f.root.querySelector('[data-ekko-composer]')!.dispatchEvent(event);
  return event;
}
function robotOptions(f: ReturnType<typeof fixture>) {
  return [...f.root.querySelectorAll<HTMLButtonElement>('[data-ekko-mention-list] [role="option"]')];
}
function openRobotButton(f: ReturnType<typeof fixture>) {
  const button = f.root.querySelector<HTMLButtonElement>('[data-ekko-action="mention-agents"]');
  assert.ok(button, 'visible robot selection button exists'); button.click();
}

test('room @ mouse choice consumes only caret query and produces exactly one structured mention', async () => {
  const f = fixture(); try {
    await linked(f);
    const input = roomInput(f, '前文 @助 后文', 5);
    assert.equal(f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!.open, false);
    assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')?.hidden, false, '@ opens robot menu');
    assert.equal(robotOptions(f)[0]?.textContent, '助手'); robotOptions(f)[0].click();
    assert.equal(input.value, '前文  后文'); assert.equal(input.selectionStart, 3);
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!.checked, true);
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.textContent, '@助手×');
    assert.equal(f.sent.length, 0, 'choosing never submits'); await f.ui.sendCurrent();
    assert.equal(f.sent[0].payload.content, '@助手 前文  后文');
    assert.deepEqual(f.sent[0].payload.mentions, [{ type: 'agent', participantId: 'agent-one', displayName: '助手' }]);
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, 0);
  } finally { f.ui.dispose(); }
});

test('room robot button preserves literal text and caret, dedupes with checkbox and chip removal', async () => {
  const f = fixture(); try {
    await linked(f); const input = roomInput(f, 'email@test 与 @未选择 后文', 4);
    openRobotButton(f); robotOptions(f)[0].click();
    assert.equal(input.value, 'email@test 与 @未选择 后文'); assert.equal(input.selectionStart, 4);
    openRobotButton(f); robotOptions(f)[0].click();
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, 1);
    const checkbox = f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;
    checkbox.checked = false; checkbox.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, 0);
    checkbox.checked = true; checkbox.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    f.root.querySelector<HTMLButtonElement>('[data-ekko-remove-agent]')!.click();
    assert.equal(checkbox.checked, false); await f.ui.sendCurrent();
    assert.equal(f.sent[0].payload.content, 'email@test 与 @未选择 后文'); assert.deepEqual(f.sent[0].payload.mentions, []);
  } finally { f.ui.dispose(); }
});

for (const key of ['Enter', 'Tab']) test(`room robot keyboard ${key} chooses active candidate without submitting`, async () => {
  const f = fixture(); try {
    f.client.room = async () => ({ room, messages: [], agents: [{roomId:room.id,agentId:'one',name:'一号'}, {roomId:room.id,agentId:'two',name:'二号'}], hasMore:false });
    await linked(f); roomInput(f, '@');
    assert.equal(robotOptions(f).length, 2); assert.equal(roomKey(f, 'ArrowUp').defaultPrevented, true);
    assert.equal(robotOptions(f)[1].getAttribute('aria-selected'), 'true');
    roomKey(f, 'ArrowDown'); roomKey(f, 'ArrowDown');
    assert.equal(roomKey(f, key).defaultPrevented, true); assert.equal(f.sent.length, 0);
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-agent][value="two"]')!.checked, true);
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '');
  } finally { f.ui.dispose(); }
});

test('room robot IME Enter ignores choice, Escape closes and empty matches never submit', async () => {
  const f = fixture(); try {
    await linked(f); const input = roomInput(f, '@');
    assert.equal(robotOptions(f).length, 1); roomKey(f, 'Enter', true);
    assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!.checked, false);
    assert.equal(input.value, '@'); roomKey(f, 'Escape');
    assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!.hidden, true);
    roomInput(f, '@不匹配'); assert.equal(robotOptions(f).length, 0);
    assert.match(f.root.querySelector('[data-ekko-mention-list]')!.textContent!, /没有匹配/);
    assert.equal(roomKey(f, 'Enter').defaultPrevented, true); assert.equal(f.sent.length, 0);
    roomInput(f, 'email@test'); assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!.hidden, true);
  } finally { f.ui.dispose(); }
});

test('room robot candidates require exact room, valid identity/name and unique agent IDs', async () => {
  const f = fixture(); try {
    (f.client.room as any) = async () => ({room,messages:[],hasMore:false,agents:[
      {agentId:'ok',name:'助手',roomId:room.id}, {agentId:'ok',name:'助手',roomId:room.id},
      {agentId:'foreign',name:'外房',roomId:secondRoom.id}, {agentId:'missing',name:'同房间'},
      {agentId:'bad id',name:'非法',roomId:room.id},{agentId:'name',name:'@非法',roomId:room.id},
      {agentId:'conflict',name:'甲',roomId:room.id},{agentId:'conflict',name:'乙',roomId:room.id}]});
    await linked(f); roomInput(f, '@'); assert.deepEqual(robotOptions(f).map(x=>x.textContent), ['助手', '同房间']);
    robotOptions(f)[0].click(); await f.ui.sendCurrent(); assert.equal(f.sent[0].payload.mentions.length, 1);
  } finally { f.ui.dispose(); }
});

test('room without verified robots shows a non-selectable explanation', async () => {
  const f = fixture(); try {
    f.client.room = async () => ({ room, messages: [], agents: [], hasMore: false });
    await linked(f); openRobotButton(f);
    assert.equal(robotOptions(f).length, 0); assert.match(f.root.querySelector('[data-ekko-mention-list]')!.textContent!, /暂无.*机器人/);
    assert.equal(roomKey(f, 'Tab').defaultPrevented, true); assert.equal(f.sent.length, 0);
  } finally { f.ui.dispose(); }
});

for (const mutation of ['rename', 'remove']) test(`room picker and chips reconcile member ${mutation} and reject old option`, async () => {
  const f = fixture(); try {
    await linked(f); roomInput(f, '@'); assert.equal(robotOptions(f).length, 1); robotOptions(f)[0].click();
    openRobotButton(f); const old = robotOptions(f)[0];
    f.client.room = async () => ({room,messages:[],agents:mutation==='rename'?[{roomId:room.id,agentId:'agent-one',name:'新名'}]:[],hasMore:false});
    const state = f.ui as any; await state.reloadHistory(state.active, state.version);
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, 0);
    assert.deepEqual(robotOptions(f).map(x=>x.textContent), mutation==='rename'?['新名']:[]);
    old.click(); assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0);
    assert.equal(f.sent.length, 0);
  } finally { f.ui.dispose(); }
});

for (const change of ['scene', 'view', 'document', 'work', 'connection', 'leave', 'render', 'room', 'dispose']) test(`room picker callbacks are invalid after ${change}`, async () => {
  const f = fixture(); try {
    let current = true, scene = 'scene-one'; f.options.isCurrent=()=>current; f.options.getSceneIdentity=()=>scene;
    await linked(f); const input = roomInput(f, '@'); assert.equal(robotOptions(f).length, 1); const old = robotOptions(f)[0];
    if(change==='scene')scene='scene-two';
    if(change==='view')current=false;
    if(change==='document')f.setDocument(B);
    if(change==='work')f.setWork(B);
    if(change==='connection')f.ui.connectionChanged();
    if(change==='leave')f.ui.leave();
    if(change==='render'){const s=f.ui as any;s.render();}
    if(change==='room'){await f.ui.linkRoom(secondRoom.id);await f.ui.openRoom(secondRoom.id);}
    if(change==='dispose')f.ui.dispose();
    old.click(); input.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    assert.equal(f.sent.length,0); assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length,0);
  } finally { f.ui.dispose(); }
});

test('ordinary document room picker retains document and source quote protection', async () => {
  const f = fixture(); try {
    (f.options.getWorkId as any)=()=>null;
    f.options.store.listForDocument=async(id)=>f.links.filter(l=>l.workId===null&&l.documentRootId===id);
    f.options.store.assertLinked=async(_work,identity,id,documentId)=>{const l=f.links.find(l=>l.roomId===id&&l.documentRootId===documentId&&l.connectionId===identity.connectionId);assert.ok(l);return l;};
    f.options.loadSource=async()=>({kind:'document',documentId:DOC,title:'虚构文档',text:'文档中的 @助手 </quoted_message>'});
    await linked(f); roomInput(f, '消息 @助'); assert.equal(robotOptions(f).length,1);robotOptions(f)[0].click();
    const source=f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;source.checked=true;source.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
    await f.ui.sendCurrent();assert.equal(f.sent[0].documentRootId,DOC);
    assert.match(f.sent[0].payload.content,/^@助手 消息 /);assert.match(f.sent[0].payload.content,/<quoted_message>/);
    assert.match(f.sent[0].payload.content,/&lt;\/quoted_message>/);assert.equal(f.sent[0].payload.mentions.length,1);
  } finally { f.ui.dispose(); }
});

test('room robot picker obeys sending and unknown result guards without retries', async () => {
  const f = fixture(); try {
    await linked(f); roomInput(f,'@');assert.equal(robotOptions(f).length,1);robotOptions(f)[0].click();
    f.setSendResult('unknown'); let release!:()=>void;f.setSendGate(new Promise<void>(r=>release=r));
    const sending=f.ui.sendCurrent();await tick();openRobotButton(f);assert.equal(robotOptions(f).length,0);
    release();await sending;assert.ok(f.ui.unknownMessageId());openRobotButton(f);assert.equal(robotOptions(f).length,0);
    await f.ui.sendCurrent();assert.equal(f.sent.length,1);assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount,1);
    f.setOffline(true);await f.ui.refresh();assert.equal(f.root.querySelector('[data-ekko-action="mention-agents"]'),null);
  } finally { f.ui.dispose(); }
});

test('room robot pointer choice survives pointerdown and outside pointer dismisses without selection', async () => {
  const f=fixture(); try {
    await linked(f);roomInput(f,'@');const option=robotOptions(f)[0];assert.ok(option);
    option.dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true,cancelable:true}));
    assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!.hidden,false);
    option.click();assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length,1);
    openRobotButton(f);f.root.querySelector('[data-ekko-messages]')!.dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));
    assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!.hidden,true);assert.equal(f.sent.length,0);
  } finally {f.ui.dispose();}
});

for(const change of ['text','caret'])test(`room robot choice rejects silently changed ${change} snapshot`,async()=>{
  const f=fixture();try{await linked(f);const input=roomInput(f,'前文 @助 后文',5);const option=robotOptions(f)[0];assert.ok(option);
    if(change==='text')input.value='新草稿';else input.setSelectionRange(1,1);
    option.click();assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length,0);
    assert.equal(input.value,change==='text'?'新草稿':'前文 @助 后文');assert.equal(f.sent.length,0);
  }finally{f.ui.dispose();}
});

for (const scope of ['work', 'document']) test(`room-scoped omitted member roomId can choose and structured send in ${scope}`, async () => {
  const f=fixture();try {
    (f.client.room as any)=async()=>({room,messages:[],agents:[{agentId:'agent-one',name:'助手'}],hasMore:false});
    if(scope==='document'){
      f.options.getWorkId=()=>null;f.options.store.listForDocument=async id=>f.links.filter(l=>l.workId===null&&l.documentRootId===id);
      f.options.store.assertLinked=async(_work,identity,id,documentId)=>{const l=f.links.find(l=>l.roomId===id&&l.documentRootId===documentId&&l.connectionId===identity.connectionId);assert.ok(l);return l;};
    }
    await linked(f);assert.equal(f.root.querySelectorAll('[data-ekko-agent]').length,1);
    const input=roomInput(f,'请求 @助');assert.deepEqual(robotOptions(f).map(x=>x.textContent),['助手']);robotOptions(f)[0].click();
    assert.equal(input.value,'请求 ');await f.ui.sendCurrent();assert.equal(f.sent[0].payload.content,'@助手 请求 ');
    assert.deepEqual(f.sent[0].payload.mentions,[{type:'agent',participantId:'agent-one',displayName:'助手'}]);
  }finally{f.ui.dispose();}
});

test('room-scoped present and omitted identities dedupe while mixed names and foreign rooms are refused', async()=>{
  const f=fixture();try{
    (f.client.room as any)=async()=>({room,messages:[],hasMore:false,agents:[
      {agentId:'ok',name:'助手'}, {agentId:'ok',name:'助手',roomId:room.id},
      {agentId:'conflict',name:'甲',roomId:room.id},{agentId:'conflict',name:'乙'},
      {agentId:'foreign',name:'外房',roomId:secondRoom.id}, {agentId:'empty',name:'空房',roomId:''},
      {agentId:'bad id',name:'非法'}, {agentId:'badname',name:'@非法'}]});
    await linked(f);roomInput(f,'@');assert.deepEqual(robotOptions(f).map(x=>x.textContent),['助手']);
    assert.deepEqual([...f.root.querySelectorAll<HTMLInputElement>('[data-ekko-agent]')].map(x=>x.value),['ok']);
    robotOptions(f)[0].click();openRobotButton(f);robotOptions(f)[0].click();await f.ui.sendCurrent();
    assert.deepEqual(f.sent[0].payload.mentions,[{type:'agent',participantId:'ok',displayName:'助手'}]);
  }finally{f.ui.dispose();}
});

for (const format of ['omit','present']) test(`room member reload ${format} roomId retains exact ID/name selection and invalidates old option`,async()=>{
  const f=fixture();try{
    if(format==='present')(f.client.room as any)=async()=>({room,messages:[],agents:[{agentId:'agent-one',name:'助手'}],hasMore:false});
    await linked(f);roomInput(f,'消息 @助');assert.equal(robotOptions(f).length,1);robotOptions(f)[0].click();
    openRobotButton(f);const old=robotOptions(f)[0];
    (f.client.room as any)=async()=>({room,messages:[],agents:[{agentId:'agent-one',name:'助手',...(format==='present'?{roomId:room.id}:{})}],hasMore:false});
    const state=f.ui as any;await state.reloadHistory(state.active,state.version);
    assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length,1);
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount,1);
    assert.deepEqual(robotOptions(f).map(x=>x.textContent),['助手']);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-remove-agent]')!.click();old.click();
    assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length,0);
    robotOptions(f)[0].click();await f.ui.sendCurrent();assert.deepEqual(f.sent[0].payload.mentions,[{type:'agent',participantId:'agent-one',displayName:'助手'}]);
  }finally{f.ui.dispose();}
});

// Presentation regressions use the real room UI with synthetic history and transport.
const technicalTools = '  {"tools":{"fictional_lookup":{"description":"<img src=x onerror=alert(1)>","parameters":{"type":"object","properties":{"query":{"type":"string"}}}}}}\n';
const technicalStats = '{"runId":"fictional-run","assistantMessageId":"fictional-message","part":2,"inputTokens":18,"outputTokens":4}';
function presentationMessage(id: string, content: string, extra: Partial<import('../src/ekko/bridge.ts').EkkoMessage> = {}) {
  return { ...message(id, content), senderId: 'agent-one', role: 'assistant', ...extra };
}
function presentationHistory(f: ReturnType<typeof fixture>, messages: ReturnType<typeof presentationMessage>[]) {
  (f.client.room as any) = async () => ({ room, messages, agents: [{ agentId: 'agent-one', name: '助手' }], hasMore: false });
}
function presentationRow(f: ReturnType<typeof fixture>, id: string) {
  return [...f.root.querySelectorAll<HTMLElement>('[data-ekko-messages] [data-message-id]')].find(row => row.dataset.messageId === id);
}
function roomMessage(f: ReturnType<typeof fixture>, id: string, content: string, extra: Partial<import('../src/ekko/bridge.ts').EkkoMessage> = {}) {
  f.emitEvent(room.id, { event: 'room.message', data: presentationMessage(id, content, extra) });
}
for (const [kind, content] of [['tools', technicalTools], ['stats', technicalStats]] as const) {
  for (const transport of ['history', 'event'] as const) test(`room ${transport} folds complete bot ${kind} and preserves exact inspectable original`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
    presentationHistory(f, transport === 'history' ? [presentationMessage('technical', content)] : []);
    await linked(f); if (transport === 'event') roomMessage(f, 'technical', content);
    const row = presentationRow(f, 'technical')!;
    const detail = row.querySelector<HTMLDetailsElement>('[data-ekko-technical]');
    assert.ok(detail, 'technical JSON must have an explicit collapsed inspection control');
    assert.equal(detail.open, false); assert.equal(detail.querySelector('pre')!.textContent, content);
    assert.equal(row.querySelector('.sac-ekko-message-content'), null);
    assert.equal(row.querySelector('[data-copy-reply]'), null);
    assert.equal(row.querySelector('img,script'), null);
    detail.open = true; assert.equal(detail.querySelector('pre')!.textContent, content);
  });
}

test('room presentation preserves human, unknown, ordinary JSON, fenced schema and prose', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const cases = [
    presentationMessage('user', technicalTools, { role: 'user' }),
    presentationMessage('auth', technicalTools, { senderId: 'auth:7' }),
    presentationMessage('unknown', technicalTools, { role: undefined, senderId: undefined, senderName: '助手' }),
    presentationMessage('foreign', technicalTools, { role: undefined, senderId: 'foreign' }),
    presentationMessage('ordinary', '{"tools":{"hammer":3}}'),
    presentationMessage('empty-tools', '{"tools":{}}'),
    presentationMessage('bad-properties', '{"tools":{"x":{"description":"x","parameters":{"type":"object","properties":[]}}}}'),
    presentationMessage('explained', technicalTools.trim() + '\n这是代码解释'),
    presentationMessage('extra-key', '{"tools":{"x":{"description":"x","parameters":{"type":"object","properties":{}}}},"answer":"保留"}'),
    presentationMessage('fenced', '```json\n' + technicalTools + '```'),
    presentationMessage('stats-body', '{"runId":"r","assistantMessageId":"m","part":2,"inputTokens":1,"outputTokens":2,"content":"正常答案"}'),
    presentationMessage('stats-no-id', '{"tokens":1,"parts":2}'),
    presentationMessage('stats-invalid', '{"runId":"r","assistantMessageId":"m","part":2,"inputTokens":"1","outputTokens":2}'),
    presentationMessage('text', '使用 tools 和 mcp 的说明'),
    presentationMessage('html', '<script>alert(1)</script>'),
  ];
  presentationHistory(f, cases); await linked(f);
  for (const item of cases) {
    const row = presentationRow(f, item.id)!;
    assert.ok(row.querySelector('.sac-ekko-message-content'), item.id);
    assert.equal(row.querySelector('[data-ekko-technical]'), null, item.id);
    assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, item.content, item.id);
    assert.ok(row.querySelector('[data-copy-reply]'), item.id);
  }
  assert.equal(f.root.querySelector('[data-ekko-messages] script'), null);
});

test('room verified bot identity folds without assistant role while user sources take precedence', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  presentationHistory(f, [presentationMessage('roster-bot', technicalTools, { role: undefined })]); await linked(f);
  assert.ok(presentationRow(f, 'roster-bot')!.querySelector('[data-ekko-technical]'));
  roomMessage(f, 'roster-bot', technicalTools, { role: 'user' });
  assert.ok(presentationRow(f, 'roster-bot')!.querySelector('[data-copy-reply]'));
});

test('room empty completed records have no bubbles and bot JSON in progress has only a waiting notice', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  presentationHistory(f, [presentationMessage('blank', ' \n\t'), presentationMessage('json', '{"tools":', { isStreaming: true }),
    presentationMessage('ordinary-stream', '正在整理答案', { isStreaming: true }),
    presentationMessage('human-stream', '{"tools":', { isStreaming: true, role: 'user' })]); await linked(f);
  assert.equal(presentationRow(f, 'blank'), undefined);
  const waiting = presentationRow(f, 'json')!;
  assert.match(waiting.textContent!, /正在回复…/); assert.doesNotMatch(waiting.textContent!, /tools/);
  assert.equal(waiting.querySelector('[data-copy-reply]'), null);
  assert.match(presentationRow(f, 'ordinary-stream')!.textContent!, /正在整理答案/);
  assert.match(presentationRow(f, 'human-stream')!.textContent!, /tools/);
});

test('room same-ID updates replace waiting, technical, blank and reply controls and copy current exact text', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  presentationHistory(f, []); await linked(f);
  const copied: string[] = [];
  Object.defineProperty(f.dom.window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied.push(value); } } });
  roomMessage(f, 'update', '{"tools":', { isStreaming: true });
  assert.equal(presentationRow(f, 'update')!.querySelector('[data-copy-reply]'), null);
  roomMessage(f, 'update', technicalTools);
  assert.ok(presentationRow(f, 'update')!.querySelector('[data-ekko-technical]'));
  const exact = '  **正常答复**\n第二行\n'; roomMessage(f, 'update', exact);
  let row = presentationRow(f, 'update')!;
  assert.equal(row.querySelector('[data-ekko-technical]'), null); assert.doesNotMatch(row.textContent!, /正在回复/);
  row.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click(); await tick(); assert.deepEqual(copied, [exact]);
  roomMessage(f, 'update', '  '); assert.equal(presentationRow(f, 'update'), undefined);
  roomMessage(f, 'update', '恢复正文'); row = presentationRow(f, 'update')!;
  assert.equal(f.root.querySelectorAll('[data-message-id="update"]').length, 1);
  row.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click(); await tick(); assert.deepEqual(copied, [exact, '恢复正文']);
});

test('room raw transport reasoning, end and snapshot never render content or delta', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  presentationHistory(f, []); await linked(f);
  for (const type of ['message_reasoning_delta', 'message_stream_end', 'message_stream_snapshot']) {
    f.emitEvent(room.id, { event: 'room.stream', data: { roomId: room.id, id: 'stream-raw', type, content: 'RAW-CONTENT-' + type, delta: 'RAW-DELTA-' + type } });
    assert.doesNotMatch(f.root.querySelector('[data-ekko-panel]')!.textContent!, /RAW-/);
  }
  roomMessage(f, 'complete', '完整正式答复'); assert.match(presentationRow(f, 'complete')!.textContent!, /完整正式答复/);
});

test('room pages containing only technical and blank records keep original older cursor and history anchors', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const pages = [presentationMessage('oldest-raw', ' \t', { timestamp: '2026-09-28T00:00:00Z' }),
    presentationMessage('latest-raw', technicalStats, { timestamp: '2026-09-28T00:00:01Z' })];
  const cursors: Array<string | undefined> = [];
  (f.client.room as any) = async (_id: string, options: { before?: string }) => {
    cursors.push(options.before);
    return { room, agents: [], messages: options.before ? [presentationMessage('older-answer', '更早正常答复')] : pages, hasMore: !options.before };
  };
  await linked(f); assert.ok(f.root.querySelector('[data-ekko-action="older"]'));
  assert.equal(presentationRow(f, 'oldest-raw'), undefined);
  assert.equal((f.ui as any).active.historyAnchor, 'latest-raw');
  await f.ui.loadOlder(); assert.deepEqual(cursors, [undefined, 'oldest-raw']);
  assert.match(presentationRow(f, 'older-answer')!.textContent!, /更早正常答复/);
  assert.equal((f.ui as any).active.historyAnchor, 'latest-raw');
});

test('room late complete and raw events after scene change cannot update the visible room', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  let scene = 'one'; f.options.getSceneIdentity = () => scene;
  presentationHistory(f, [presentationMessage('existing', '原房间答案')]); await linked(f);
  scene = 'two'; roomMessage(f, 'late', '迟到正式消息');
  f.emitEvent(room.id, { event: 'room.stream', data: { roomId: room.id, content: '迟到原始事件' } });
  assert.doesNotMatch(f.root.querySelector('[data-ekko-panel]')!.textContent!, /迟到/);
  assert.match(presentationRow(f, 'existing')!.textContent!, /原房间答案/);
});

function roomStream(f: ReturnType<typeof fixture>, id: unknown, type: string, extra: Record<string, unknown> = {}) {
  f.emitEvent(room.id, { event: 'room.stream', data: { roomId: room.id, id, type, content: '禁止直接展示', delta: '禁止拼接', ...extra } });
}
test('room stream activity supports concurrent IDs, matching end and matching complete without raw text', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); presentationHistory(f, []); await linked(f);
  const stream = () => f.root.querySelector('[data-ekko-stream]')!.textContent;
  roomStream(f, 'one', 'message_stream_start'); assert.equal(stream(), '机器人正在回复…');
  roomStream(f, 'two', 'message_stream_delta'); roomStream(f, 'one', 'message_stream_end'); assert.equal(stream(), '机器人正在回复…');
  roomStream(f, 'two', 'message_reasoning_delta'); assert.equal(stream(), '机器人正在回复…');
  roomMessage(f, 'unrelated', '另一个完整答复'); assert.equal(stream(), '机器人正在回复…');
  roomMessage(f, 'two', technicalStats); assert.equal(stream(), '');
  roomStream(f, 'three', 'message_stream_snapshot'); assert.equal(stream(), '机器人正在回复…');
  roomStream(f, 'three', 'message_stream_end'); assert.equal(stream(), '');
  assert.doesNotMatch(f.root.querySelector('[data-ekko-panel]')!.textContent!, /禁止/);
});
test('room stream invalid and foreign IDs and reasoning cannot start activity', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); presentationHistory(f, []); await linked(f);
  for (const id of [undefined, '', 'invalid id', 7]) roomStream(f, id, 'message_stream_start');
  roomStream(f, 'reason', 'message_reasoning_delta'); roomStream(f, 'end', 'message_stream_end');
  roomStream(f, 'foreign', 'message_stream_start', { roomId: secondRoom.id }); roomStream(f, 'unknown', 'other-event');
  assert.equal(f.root.querySelector('[data-ekko-stream]')!.textContent, '');
});
for (const stop of ['disconnect', 'leave', 'identity', 'scene'] as const) test(`room stream activity clears on ${stop} and late events cannot reappear`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  let scene = 'one'; f.options.getSceneIdentity = () => scene; presentationHistory(f, []); await linked(f);
  roomStream(f, 'active', 'message_stream_start'); assert.equal(f.root.querySelector('[data-ekko-stream]')!.textContent, '机器人正在回复…');
  if (stop === 'disconnect') { f.emitEvent(room.id, { event: 'room.disconnected', data: { state: 'denied' } }); }
  if (stop === 'leave') f.ui.leave();
  if (stop === 'identity') f.ui.connectionChanged();
  if (stop === 'scene') { scene = 'two'; await f.ui.workChanged(); }
  roomStream(f, 'late', 'message_stream_delta');
  assert.doesNotMatch(f.root.querySelector('[data-ekko-panel]')!.textContent!, /机器人正在回复|禁止/);
});

test('room collapsed technical original preserves leading LF and CRLF bytes as text', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const exact = '\n\r\n' + technicalTools.replace(/\n/g, '\r\n');
  presentationHistory(f, [presentationMessage('line-endings', exact)]); await linked(f);
  const original = presentationRow(f, 'line-endings')!.querySelector('pre')!;
  assert.equal(original.textContent, exact);
});

// 0.3.13: omitted part is a valid statistics envelope; malformed/personal JSON stays readable.
for (const transport of ['history', 'event'] as const) test(`room ${transport} folds complete bot statistics without part`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const exact = ' \n{"runId":"fictional-run","assistantMessageId":"fictional-message","inputTokens":18,"outputTokens":4,"cacheReadTokens":0,"cacheHitRate":0,"costUsd":0,"tokensPerSecond":2,"speedSource":"measured","isEstimated":false}\r\n';
  presentationHistory(f, transport === 'history' ? [presentationMessage('no-part', exact)] : []);
  await linked(f); if (transport === 'event') roomMessage(f, 'no-part', exact);
  const row = presentationRow(f, 'no-part')!;
  const detail = row.querySelector<HTMLDetailsElement>('[data-ekko-technical]');
  assert.ok(detail, 'complete statistics do not require part');
  assert.equal(detail.open, false); assert.equal(detail.querySelector('pre')!.textContent, exact);
  assert.equal(row.querySelector('.sac-ekko-message-content,[data-copy-reply]'), null);
});

test('room optional statistics part never relaxes source and complete-field validation', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const base = { runId: 'r', assistantMessageId: 'm', inputTokens: 0, outputTokens: 2 };
  const cases = [
    ...[null, -1, 0.5, '2', false, {}, [], Number.MAX_SAFE_INTEGER + 1].map((part, i) => presentationMessage('bad-part-' + i, JSON.stringify({ ...base, part }))),
    ...['runId', 'assistantMessageId', 'inputTokens', 'outputTokens'].map(key => {
      const fields: Record<string, unknown> = { ...base }; delete fields[key];
      return presentationMessage('missing-' + key, JSON.stringify(fields));
    }),
    ...[{ inputTokens: '1' }, { outputTokens: -1 }, { runId: '' }, { assistantMessageId: ' ' },
      { cacheReadTokens: 0.5 }, { cacheHitRate: -1 }, { costUsd: '0' }, { tokensPerSecond: null },
      { speedSource: '' }, { isEstimated: 1 }, { content: '普通正文' }].map((extra, i) => presentationMessage('bad-field-' + i, JSON.stringify({ ...base, ...extra }))),
    presentationMessage('user-no-part', JSON.stringify(base), { role: 'user' }),
    presentationMessage('auth-no-part', JSON.stringify(base), { senderId: 'auth:7' }),
    presentationMessage('unknown-no-part', JSON.stringify(base), { role: undefined, senderId: undefined }),
    presentationMessage('foreign-no-part', JSON.stringify(base), { role: undefined, senderId: 'foreign' }),
  ];
  presentationHistory(f, [...cases, presentationMessage('zero-part', JSON.stringify({ ...base, part: 0 })),
    presentationMessage('roster-no-part', JSON.stringify(base), { role: undefined })]);
  await linked(f);
  for (const item of cases) {
    const row = presentationRow(f, item.id)!;
    assert.equal(row.querySelector('[data-ekko-technical]'), null, item.id);
    assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, item.content, item.id);
    assert.ok(row.querySelector('[data-copy-reply]'), item.id);
  }
  for (const id of ['zero-part', 'roster-no-part']) assert.ok(presentationRow(f, id)!.querySelector('[data-ekko-technical]'), id);
});

test('room body overrides host selection ban and visible copy preserves original and selection on arrival', async t => {
  const { CSS } = await import('../src/styles.ts');
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const style = f.dom.window.document.createElement('style');
  style.textContent = 'body{user-select:none;-webkit-user-select:none}' + CSS;
  f.dom.window.document.head.append(style);
  const exact = '  **可选择的正文**\n<script>不执行</script>\n';
  presentationHistory(f, [presentationMessage('selectable', exact)]); await linked(f);
  const row = presentationRow(f, 'selectable')!;
  const body = row.querySelector<HTMLElement>('.sac-ekko-message-content')!;
  assert.equal(f.dom.window.getComputedStyle(body).userSelect, 'text');
  const rule = [...style.sheet!.cssRules].find(rule => (rule as CSSStyleRule).selectorText === '.sac-ekko-message-content') as CSSStyleRule;
  assert.equal(rule.style.getPropertyValue('-webkit-user-select'), 'text');
  const copy = row.querySelector<HTMLButtonElement>('[data-copy-reply]')!;
  assert.equal(copy.textContent, '复制'); assert.equal(copy.hidden, false);
  assert.notEqual(f.dom.window.getComputedStyle(copy).display, 'none');
  const selected = f.dom.window.getSelection()!;
  const range = f.dom.window.document.createRange(); range.selectNodeContents(body); selected.addRange(range);
  const selectedText = selected.toString(); const anchor = selected.anchorNode;
  roomMessage(f, 'arriving', '另一条新消息');
  assert.equal(presentationRow(f, 'selectable')!.querySelector('.sac-ekko-message-content'), body);
  assert.equal(selected.toString(), selectedText); assert.equal(selected.anchorNode, anchor);
  const copied: string[] = [];
  Object.defineProperty(f.dom.window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied.push(value); } } });
  copy.click(); await tick(); assert.deepEqual(copied, [exact]);
  assert.equal(row.querySelector('script'), null);
});

test('引用回复保留正文，可取消、恢复并按引用协议发送', async () => {
 const f=fixture();await linked(f);
 const composer=()=>f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;
 composer().value='回复正文';composer().dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
 const quote=()=>[...f.root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='引用回复')!;
 assert.ok(quote());quote().click();
 assert.match(f.root.querySelector('[data-ekko-reply-preview]')!.textContent!,/测试用户/);
 assert.equal(composer().value,'回复正文');
 f.root.querySelector<HTMLButtonElement>('[data-ekko-action="cancel-reply"]')!.click();
 assert.equal(f.root.querySelector('[data-ekko-reply-preview]'),null);assert.equal(composer().value,'回复正文');
 quote().click();f.ui.leave();await f.ui.enter();await f.ui.openRoom(room.id);
 assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));
 await f.ui.sendCurrent();assert.match(f.sent[0].payload.content,/<quoted_message>/);assert.equal(f.root.querySelector('[data-ekko-reply-preview]'),null);
 f.ui.dispose();
});

test('技术、空白、未完成消息不可引用，引用中 @ 不激活机器人', async () => {
 const f=fixture();f.history[room.id]=[
 {...message('stats', JSON.stringify({runId:'r',assistantMessageId:'a',inputTokens:1,outputTokens:2})),role:'assistant'} as any,
 {...message('stream','尚未完成'),isStreaming:true} as any,message('blank','  '),message('plain','@助手 原文')];
 await linked(f);const buttons=f.root.querySelectorAll<HTMLButtonElement>('[data-ekko-action="reply"]');assert.equal(buttons.length,1);buttons[0].click();
 const textarea=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;textarea.value='回答';await f.ui.sendCurrent();
 assert.deepEqual(f.sent[0].payload.mentions,[]);assert.match(f.sent[0].payload.content,/@助手 原文/);f.ui.dispose();
});

test('引用准备期间原文变化或被删除停止发送并保留草稿', async () => {
 for(const change of ['edit','remove','stream']) {
 const f=fixture();await linked(f);f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
 const textarea=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;textarea.value='仍保留';
 const original=f.options.pendingStore.remember.bind(f.options.pendingStore);
 f.options.pendingStore.remember=async (...args)=>{await original(...args); if(change==='remove') (f.ui as any).histories.set((f.ui as any).currentKey(),[]); else f.emitEvent(room.id,{event:'room.message',data:{...message('m-1',change==='edit'?'已修改':'<script>alert(1)</script>'),isStreaming:change==='stream'}});};
 await f.ui.sendCurrent();assert.equal(f.sent.length,0);assert.equal(textarea.value,'仍保留');assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));f.ui.dispose();
 }
});

test('引用在未知结果锁定，失败保留，核对成功清理', async () => {
 const f=fixture();await linked(f);f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
 f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value='回复';f.setSendResult('unknown');await f.ui.sendCurrent();
 const cancel=f.root.querySelector<HTMLButtonElement>('[data-ekko-action="cancel-reply"]')!;assert.equal(cancel.disabled,true);cancel.click();assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));
 f.client.sendStatus=async()=>({state:'sent'});await f.ui.checkUnknown();assert.equal(f.root.querySelector('[data-ekko-reply-preview]'),null);f.ui.dispose();
});

test('引用草稿按房间隔离，旧消息按钮不可跨场景引用', async () => {
 const f=fixture();await linked(f);const old=f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!;old.click();
 await f.ui.linkRoom(secondRoom.id);await f.ui.openRoom(secondRoom.id);assert.equal(f.root.querySelector('[data-ekko-reply-preview]'),null);old.click();assert.equal(f.root.querySelector('[data-ekko-reply-preview]'),null);
 await f.ui.openRoom(room.id);assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));f.ui.dispose();
});

// Room readability: acknowledged transport receipts remain distinct from canonical history.
const receiptRow = (f: ReturnType<typeof fixture>) => f.root.querySelector<HTMLElement>('[data-ekko-pending-history]');
async function sendReadability(f: ReturnType<typeof fixture>, content = '已确认但历史尚未回传') {
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = content;
  await f.ui.sendCurrent();
  return f.sent.at(-1)?.payload;
}
test('readability sent response stays visible with stale history and exact original copy, never replyable', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  const payload = await sendReadability(f);
  const row = receiptRow(f); assert.ok(row); assert.equal(row.dataset.author, 'self');
  assert.match(row.textContent!, /已发送，等待历史同步/); assert.match(row.textContent!, /已确认但历史尚未回传/);
  assert.equal(row.querySelector('[data-ekko-action="reply"]'), null);
  assert.equal((f.ui as any).histories.get((f.ui as any).currentKey()).length, 1);
  assert.equal((f.ui as any).active.historyAnchor, 'm-1');
  const copied: string[] = []; Object.defineProperty(f.dom.window.navigator, 'clipboard', { value: { writeText: async (s: string) => { copied.push(s); } } });
  row.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click(); await tick(); assert.deepEqual(copied, [payload.content]);
  f.ui.leave(); await f.ui.enter(); await f.ui.openRoom(room.id); assert.ok(receiptRow(f));
});
for (const wrong of ['sender', 'room', 'content', 'id', 'role-only', 'streaming'] as const) test(`readability receipt does not reconcile ${wrong} history proof`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f); const payload = await sendReadability(f);
  const proof: any = { ...message('m-new', payload.content), senderId: 'auth:7', role: 'user' };
  if (wrong === 'sender') proof.senderId = 'auth:8';
  if (wrong === 'room') proof.roomId = secondRoom.id;
  if (wrong === 'content') proof.content += '修改';
  if (wrong === 'id') proof.id = 'unrelated';
  if (wrong === 'role-only') delete proof.senderId;
  if (wrong === 'streaming') proof.isStreaming = true;
  f.emitEvent(room.id, { event: 'room.message', data: proof }); assert.ok(receiptRow(f));
});
for (const useClientId of [false, true]) test(`readability exact ${useClientId ? 'client' : 'returned'} ID proof replaces receipt once`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f); const payload = await sendReadability(f);
  assert.ok(receiptRow(f)); const proof = { ...message(useClientId ? payload.clientMessageId : 'm-new', payload.content), senderId: 'auth:7' };
  for (let i = 0; i < 2; i++) f.emitEvent(room.id, { event: 'room.message', data: proof });
  assert.equal(receiptRow(f), null); assert.equal(f.root.querySelectorAll('[data-message-id="' + proof.id + '"]').length, 1);
});
test('readability invalid returned ID cannot reconcile and acknowledgement survives pending cleanup failure', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  f.client.send = async (roomId, payload, _identity, documentRootId) => { f.sent.push({ roomId, payload, documentRootId }); return { state: 'sent', messageId: 'invalid id' }; };
  f.options.pendingStore.clear = async () => { throw new Error('cleanup failed'); };
  const payload = await sendReadability(f); assert.ok(receiptRow(f));
  f.emitEvent(room.id, { event: 'room.message', data: { ...message('invalid id', payload.content), senderId: 'auth:7' } }); assert.ok(receiptRow(f));
});
for (const failure of ['unknown', 'rejected', 'prepare'] as const) test(`readability ${failure} never invents sent receipt`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  if (failure === 'unknown') f.setSendResult('unknown');
  if (failure === 'rejected') f.setSendError(new BridgeError('denied', 403, 'access_denied'));
  if (failure === 'prepare') f.options.pendingStore.remember = async () => { throw new Error('cannot claim'); };
  await sendReadability(f); assert.equal(receiptRow(f), null);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '已确认但历史尚未回传');
});
test('readability receipts isolate room, work and identity and late sent never enters switched scope', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f); await sendReadability(f);
  await f.ui.linkRoom(secondRoom.id); await f.ui.openRoom(secondRoom.id); assert.equal(receiptRow(f), null);
  f.setWork(B); await f.ui.workChanged(); await f.ui.linkRoom(room.id); await f.ui.openRoom(room.id); assert.equal(receiptRow(f), null);
  f.setWork(A); await f.ui.workChanged(); await f.ui.openRoom(room.id); assert.ok(receiptRow(f));
  let release!: () => void; f.setSendGate(new Promise<void>(resolve => { release = resolve; }));
  f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '迟到回执'; const sending = f.ui.sendCurrent();
  while (f.sent.length < 2) await tick();
  await f.ui.openRoom(secondRoom.id); release(); await sending; assert.equal(receiptRow(f), null);
  await f.ui.openRoom(room.id); assert.equal(f.root.querySelectorAll('[data-ekko-pending-history]').length, 2);
  f.setConnection({ ...connection, deviceId: 'different-device', accountUserId: 8 }); f.ui.connectionChanged(); await f.ui.refresh(); assert.equal(receiptRow(f), null);
});
test('readability body and full quote separate, self identity updates same row, expansion and selection survive arrivals', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const interior = '【引用：原作者】\n' + '<script>不执行</script> @助手\n'.repeat(100);
  const exact = '**回答正文**\n\n<quoted_message>\n' + interior + '\n</quoted_message>';
  f.history[room.id] = [{ ...message('quoted', exact), senderId: 'auth:7' } as any]; await linked(f);
  const row = presentationRow(f, 'quoted')!; assert.equal(row.dataset.author, 'self'); assert.match(row.querySelector('.sac-ekko-message-meta')!.textContent!, /你/);
  assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, '**回答正文**');
  const details = row.querySelector<HTMLDetailsElement>('[data-ekko-history-quote]')!; assert.ok(details); assert.equal(details.open, false);
  assert.equal(details.querySelector('pre')!.textContent, interior); assert.ok(details.querySelector('summary')!.textContent!.length < 230);
  assert.equal(row.querySelector('script'), null); details.open = true;
  const selection = f.dom.window.getSelection()!; const range = f.dom.window.document.createRange(); range.selectNodeContents(row.querySelector('.sac-ekko-message-content')!); selection.addRange(range); const anchor = selection.anchorNode;
  f.emitEvent(room.id, { event: 'room.message', data: message('arrival', '新消息') });
  assert.equal(row.querySelector('[data-ekko-history-quote]'), details); assert.equal(details.open, true); assert.equal(selection.anchorNode, anchor);
  f.emitEvent(room.id, { event: 'room.message', data: { ...message('quoted', exact), senderId: 'auth:8' } });
  assert.equal(presentationRow(f, 'quoted'), row); assert.equal(row.dataset.author, 'other');
  f.emitEvent(room.id, { event: 'room.message', data: { ...message('quoted', exact), senderId: 'auth:7' } }); assert.equal(row.dataset.author, 'self');
  const copied: string[] = []; Object.defineProperty(f.dom.window.navigator, 'clipboard', { value: { writeText: async (s: string) => { copied.push(s); } } });
  row.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click(); await tick(); assert.deepEqual(copied, [exact]);
});
test('readability composer quote defaults compact, expands full original and cancellation preserves draft', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); f.history[room.id] = [message('long', '引用原文\n'.repeat(200))]; await linked(f);
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!; composer.value = '保留草稿';
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
  const details = f.root.querySelector<HTMLDetailsElement>('[data-ekko-reply-preview] details'); assert.ok(details); assert.equal(details.open, false);
  assert.equal(details.querySelector('pre')!.textContent, f.history[room.id][0].content); details.open = true;
  f.emitEvent(room.id, { event: 'room.message', data: message('arrival', '新消息') }); assert.equal(details.open, true);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="cancel-reply"]')!.click(); assert.equal(composer.value, '保留草稿');
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); await f.ui.sendCurrent();
  assert.ok(f.sent[0].payload.content.includes(f.history[room.id][0].content));
  const receipt = receiptRow(f)!; assert.ok(receipt.querySelector('[data-ekko-history-quote]')); assert.equal(receipt.querySelector('.sac-ekko-message-content')!.textContent, '保留草稿');
});

test('readability scoped quote budgets survive native pre styles and own rows align clearly', async t => {
  const { CSS } = await import('../src/styles.ts'); const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const style = f.dom.window.document.createElement('style'); style.textContent = 'pre{font-size:30px;max-height:none;white-space:pre}summary{font-size:24px}' + CSS; f.dom.window.document.head.append(style);
  f.history[room.id] = [{ ...message('styled', '正文\n\n<quoted_message>\n【引用：作者】\n' + '很长原文 '.repeat(500) + '\n</quoted_message>'), senderId: 'auth:7' } as any]; await linked(f);
  const row = presentationRow(f, 'styled')!; const computed = (el: Element) => f.dom.window.getComputedStyle(el);
  assert.equal(computed(row).marginLeft, 'auto');
  const pre = row.querySelector('pre')!; assert.notEqual(computed(pre).maxHeight, 'none'); assert.equal(computed(pre).overflow, 'auto'); assert.equal(computed(pre).whiteSpace, 'pre-wrap'); assert.equal(computed(pre).userSelect, 'text');
  assert.equal(computed(row.querySelector('.sac-ekko-message-actions')!).display, 'flex');
});

test('readability ordinary documents A B A retain separate receipts for the same remote room', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); f.options.getWorkId = () => null;
  f.options.store.listForDocument = async id => f.links.filter(link => link.workId === null && link.documentRootId === id);
  f.options.store.linkRoom = async link => { if (!f.links.some(other => other.workId === null && other.documentRootId === link.documentRootId && other.roomId === link.roomId)) f.links.push({ ...link }); };
  f.options.store.assertLinked = async (_workId, identity, id, documentId) => { const link = f.links.find(link => link.workId === null && link.documentRootId === documentId && link.roomId === id && link.connectionId === identity.connectionId); assert.ok(link); return link; };
  await linked(f); await sendReadability(f, '仅文档A回执'); assert.match(receiptRow(f)!.textContent!, /仅文档A/);
  f.setDocument(B); await f.ui.documentChanged(); await f.ui.linkRoom(room.id); await f.ui.openRoom(room.id); assert.equal(receiptRow(f), null);
  await sendReadability(f, '仅文档B回执'); assert.match(receiptRow(f)!.textContent!, /仅文档B/); assert.doesNotMatch(receiptRow(f)!.textContent!, /仅文档A/);
  f.setDocument(DOC); await f.ui.documentChanged(); await f.ui.openRoom(room.id); assert.equal(f.root.querySelectorAll('[data-ekko-pending-history]').length, 1); assert.match(receiptRow(f)!.textContent!, /仅文档A/);
});
test('readability canonical event arriving before sent response never duplicates history or adds receipt', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  f.client.send = async (roomId, payload, _identity, documentRootId) => { f.sent.push({ roomId, payload, documentRootId }); f.emitEvent(roomId, { event: 'room.message', data: { ...message('m-new', payload.content), senderId: 'auth:7' } }); return { state: 'sent', messageId: 'm-new' }; };
  await sendReadability(f); assert.equal(receiptRow(f), null); assert.equal(f.root.querySelectorAll('[data-message-id="m-new"]').length, 1);
});
test('readability full source quote stays expandable in acknowledged receipt and copy', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const exactSource = '完整资料\r\n' + '长文 '.repeat(300); f.options.loadSource = async () => ({ kind: 'document', documentId: DOC, title: '虚构资料', text: exactSource }); await linked(f);
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!; source.checked = true; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  const payload = await sendReadability(f, '结合资料答复'); const row = receiptRow(f)!;
  assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, '结合资料答复'); assert.ok(row.querySelector('pre')!.textContent!.includes(exactSource)); assert.ok(payload.content.includes(exactSource));
  const copied: string[] = []; Object.defineProperty(f.dom.window.navigator, 'clipboard', { value: { writeText: async (s: string) => { copied.push(s); } } }); row.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click(); await tick(); assert.deepEqual(copied, [payload.content]);
});
for (const field of ['id', 'deviceId', 'accountUserId'] as const) test(`readability changed connection ${field} cannot display prior receipt`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f); await sendReadability(f); assert.ok(receiptRow(f));
  f.setConnection({ ...connection, [field]: field === 'accountUserId' ? 8 : 'different-identity' }); await f.ui.refresh(); assert.equal(receiptRow(f), null);
});
test('readability disposed UI releases receipts and ignores late sent acknowledgement', async t => {
  const f = fixture(); t.after(() => f.dom.window.close()); await linked(f); await sendReadability(f);
  let release!: () => void; f.setSendGate(new Promise<void>(resolve => { release = resolve; })); f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '迟到'; const sending = f.ui.sendCurrent();
  while (f.sent.length < 2) await tick(); f.ui.dispose(); release(); await sending;
  assert.equal((f.ui as any).sentReceipts.size, 0); assert.equal(receiptRow(f), null);
});

test('readability composer expansion and selected original survive sending lock redraw', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '回答';
  const details = f.root.querySelector<HTMLDetailsElement>('[data-ekko-reply-preview] details')!; details.open = true;
  const selection = f.dom.window.getSelection()!; const range = f.dom.window.document.createRange(); range.selectNodeContents(details.querySelector('pre')!); selection.addRange(range); const anchor = selection.anchorNode;
  f.setSendResult('unknown'); await f.ui.sendCurrent();
  assert.equal(f.root.querySelector('[data-ekko-reply-preview] details'), details); assert.equal(details.open, true); assert.equal(selection.anchorNode, anchor);
  assert.equal(f.root.querySelector<HTMLButtonElement>('[data-ekko-action="cancel-reply"]')!.disabled, true);
});

test('readability own acknowledged send brings receipt into view while other arrivals preserve reading', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
  const area = f.root.querySelector<HTMLElement>('[data-ekko-messages]')!; Object.defineProperty(area, 'scrollHeight', { configurable: true, value: 1400 }); Object.defineProperty(area, 'clientHeight', { configurable: true, value: 180 }); area.scrollTop = 120;
  f.emitEvent(room.id, { event: 'room.message', data: message('new-other', '别人到达的消息') }); assert.equal(area.scrollTop, 120); assert.equal(f.root.querySelector<HTMLButtonElement>('[data-message-latest]')!.hidden, false);
  f.dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { top: this.matches('[data-ekko-pending-history] .sac-ekko-message-content') ? 900 - area.scrollTop : 0, bottom: 180 } as DOMRect; };
  await sendReadability(f); const body = receiptRow(f)!.querySelector<HTMLElement>('.sac-ekko-message-content')!; assert.equal(area.scrollTop, 900); assert.ok(body.getBoundingClientRect().top >= 0 && body.getBoundingClientRect().top < area.clientHeight); assert.equal(f.root.querySelector<HTMLButtonElement>('[data-message-latest]')!.hidden, true);
  f.emitEvent(room.id, { event: 'room.message', data: message('later-other', 'later incoming message') }); assert.equal(area.scrollTop, 900); assert.equal(f.root.querySelector<HTMLButtonElement>('[data-message-latest]')!.hidden, false);
});
test('readability late sent acknowledgement cannot scroll switched room reading position', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f); await f.ui.linkRoom(secondRoom.id);
  let release!: () => void; f.setSendGate(new Promise<void>(resolve => { release = resolve; })); f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '迟到'; const sending = f.ui.sendCurrent(); while (!f.sent.length) await tick();
  await f.ui.openRoom(secondRoom.id); const area = f.root.querySelector<HTMLElement>('[data-ekko-messages]')!; Object.defineProperty(area, 'scrollHeight', { value: 1400 }); Object.defineProperty(area, 'clientHeight', { value: 180 }); area.scrollTop = 120;
  release(); await sending; assert.equal(area.scrollTop, 120); assert.equal(receiptRow(f), null);
});

test('readability compact summary hides only display protocol lines and repeated leading label, preserving full originals', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const interior = '【引用：原作者】\n开头正常内容\n&lt;quoted_message>\n旧的上下文\n&lt;/quoted_message>\n<quoted_message>\n内层文字\n</quoted_message>\n末尾';
  // Raw nested boundaries are ambiguous to projection, so exercise valid escaped historical wrappers.
  const validInterior = interior.replace(/(?<!&lt;)<(?=\/?quoted_message>)/g, '&lt;');
  const exact = '回答正文\n\n<quoted_message>\n' + validInterior + '\n</quoted_message>';
  f.history[room.id] = [{ ...message('summary-polish', exact), senderId: 'auth:7' } as any]; await linked(f);
  const details = presentationRow(f, 'summary-polish')!.querySelector<HTMLDetailsElement>('[data-ekko-history-quote]')!;
  const excerpt = details.querySelector('.sac-ekko-quote-excerpt')!.textContent!; assert.doesNotMatch(excerpt, /quoted_message|【引用：原作者】/); assert.match(excerpt, /开头正常内容/); assert.equal(details.querySelector('pre')!.textContent, validInterior);
  const composer = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!; composer.value = '新回答';
  presentationRow(f, 'summary-polish')!.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
  const preview = f.root.querySelector('[data-ekko-reply-preview]')!; assert.doesNotMatch(preview.querySelector('.sac-ekko-quote-excerpt')!.textContent!, /quoted_message/); assert.equal(preview.querySelector('pre')!.textContent, exact);
  await f.ui.sendCurrent(); assert.ok(f.sent[0].payload.content.includes(exact.replace(/<(?=\/?quoted_message>)/g, '&lt;')));
});
test('readability summary header and original action share a compact grid row with native details semantics', async t => {
  const { CSS } = await import('../src/styles.ts'); const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); const style = f.dom.window.document.createElement('style'); style.textContent = CSS; f.dom.window.document.head.append(style);
  await linked(f); f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); const summary = f.root.querySelector<HTMLElement>('[data-ekko-reply-preview] summary')!;
  assert.equal(f.dom.window.getComputedStyle(summary).display, 'grid'); assert.equal(summary.querySelector('.sac-ekko-quote-hint')!.textContent, '原文'); assert.match(summary.title, /展开.*收起/);
  assert.equal(f.dom.window.getComputedStyle(summary.querySelector('strong')!).gridRow, '1'); assert.equal(f.dom.window.getComputedStyle(summary.querySelector('.sac-ekko-quote-hint')!).gridRow, '1');
  assert.equal(summary.parentElement!.tagName, 'DETAILS'); assert.equal((summary.parentElement as HTMLDetailsElement).open, false);
});
test('readability message time shows HH:mm with exact full timestamp attributes and no invalid guesses', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  f.history[room.id] = [message('time-valid', '正常时间'), { ...message('time-invalid', '坏时间'), timestamp: 'not-a-date<script>' }]; await linked(f);
  const time = presentationRow(f, 'time-valid')!.querySelector('time')!; assert.match(time.textContent!, /^\d{2}:\d{2}$/); assert.equal(time.dateTime, '2026-09-28T00:00:00.000Z'); assert.equal(time.title, '2026-09-28T00:00:00.000Z');
  assert.equal(presentationRow(f, 'time-invalid')!.querySelector('time'), null); assert.equal(f.root.querySelector('[data-ekko-messages] script'), null);
});

test('readability unchanged message identity avoids attribute churn on unrelated arrivals', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f); const row = presentationRow(f, 'm-1')!;
  const observer = new f.dom.window.MutationObserver(() => {}); observer.observe(row, { attributes: true });
  f.emitEvent(room.id, { event: 'room.message', data: message('unrelated-churn', '新内容') }); assert.deepEqual(observer.takeRecords().map(record => record.attributeName), []); observer.disconnect();
});

// Standalone result regressions: synthetic reproduction, no real service metadata.
const standaloneSearchResult = { total_available: 4, results: [{ query: 'example_tool search', matches: [], available_sources: [
  { name: 'example-reading-readonly', tool_count: 3 }, { name: 'example-reading-write', tool_count: 1 },
], hint: 'Synthetic tool search diagnostic.' }], tools: {} };
const standaloneOutlineResult = { result: 'Document outline (2 headings):\n\n- [1. Fictional chapter] (id: 20990101000000-aaaaaaa, depth: 0)\n - [1.1 Fictional section] (id: 20990101000001-bbbbbbb, depth: 1)\n... (truncated)' };
const standaloneExactResults = [
  ['search', '\n' + JSON.stringify(standaloneSearchResult, null, 2) + '\n'],
  ['outline', '\r\n' + JSON.stringify(standaloneOutlineResult, null, 2).replaceAll('\n', '\r\n') + '\r\n'],
  ['injection', JSON.stringify({ result: 'Document outline (1 headings):\r\n\r\n- [<img src=x onerror=alert(1)><script>unsafe</script>&] (id: 20990101000000-aaaaaaa, depth: 0)' })],
] as const;
for (const transport of ['history', 'event'] as const) for (const [kind, exact] of standaloneExactResults) {
  test(`room standalone result ${transport} ${kind} collapses with safe exact original and no reply actions`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
    presentationHistory(f, transport === 'history' ? [presentationMessage('standalone', exact)] : []);
    await linked(f); if (transport === 'event') roomMessage(f, 'standalone', exact);
    const row = presentationRow(f, 'standalone')!;
    const detail = row.querySelector<HTMLDetailsElement>('[data-ekko-technical]');
    assert.ok(detail, 'a complete standalone result has a collapsed original');
    assert.equal(detail.open, false); assert.equal(detail.querySelector('summary')!.textContent, '工具结果（展开查看原文）');
    assert.equal(row.querySelector('.sac-ekko-message-content,[data-copy-reply],[data-copy-code],[data-ekko-action="reply"]'), null);
    detail.open = true; assert.equal(detail.querySelector('pre code')!.textContent, exact);
    assert.equal(row.querySelector('img,script,[onerror]'), null);
    const original = detail.querySelector('code')!;
    const selection = f.dom.window.getSelection()!; const range = f.dom.window.document.createRange();
    range.selectNodeContents(original); selection.addRange(range); const anchor = selection.anchorNode;
    roomMessage(f, 'unrelated-result-arrival', '另一条普通答复');
    assert.equal(presentationRow(f, 'standalone')!.querySelector('[data-ekko-technical]'), detail);
    assert.equal(detail.open, true); assert.equal(detail.querySelector('code'), original);
    assert.equal(selection.anchorNode, anchor); assert.equal(selection.toString(), exact);
  });
}

test('room standalone result same-ID waiting result reply blank result transitions retain current controls', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  presentationHistory(f, []); await linked(f);
  const exact = standaloneExactResults[0][1];
  roomMessage(f, 'standalone-update', '{"result":', { isStreaming: true });
  assert.match(presentationRow(f, 'standalone-update')!.textContent!, /正在回复…/);
  roomMessage(f, 'standalone-update', exact);
  assert.ok(presentationRow(f, 'standalone-update')!.querySelector('[data-ekko-technical]'));
  assert.equal(presentationRow(f, 'standalone-update')!.querySelector('button'), null);
  roomMessage(f, 'standalone-update', '  正常答复\n');
  const row = presentationRow(f, 'standalone-update')!;
  assert.equal(row.querySelector('[data-ekko-technical],[role="status"]'), null);
  assert.ok(row.querySelector('[data-copy-reply]')); assert.ok(row.querySelector('[data-ekko-action="reply"]'));
  const copied: string[] = [];
  Object.defineProperty(f.dom.window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied.push(value); } } });
  row.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click(); await tick(); assert.deepEqual(copied, ['  正常答复\n']);
  roomMessage(f, 'standalone-update', ' \r\n'); assert.equal(presentationRow(f, 'standalone-update'), undefined);
  roomMessage(f, 'standalone-update', standaloneExactResults[1][1]);
  assert.equal(f.root.querySelectorAll('[data-message-id="standalone-update"]').length, 1);
  assert.equal(presentationRow(f, 'standalone-update')!.querySelector('pre')!.textContent, standaloneExactResults[1][1]);
  assert.equal(presentationRow(f, 'standalone-update')!.querySelector('button'), null);
});

test('room standalone result identity changes preserve human unknown and name-only messages', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const exact = standaloneExactResults[0][1];
  const cases = [
    presentationMessage('result-user', exact, { role: 'user' }), presentationMessage('result-auth', exact, { senderId: 'auth:7' }),
    presentationMessage('result-name', exact, { role: undefined, senderId: undefined, senderName: '助手' }),
    presentationMessage('result-unknown', exact, { role: undefined, senderId: 'unverified', senderName: '助手' }),
    presentationMessage('result-ordinary', '{"result":"正常答案"}'),
    presentationMessage('result-mixed', JSON.stringify({ ...standaloneSearchResult, answer: '正常答案' })),
    presentationMessage('result-fenced', '```json\n' + exact + '```'),
  ];
  presentationHistory(f, cases); await linked(f);
  for (const item of cases) {
    const row = presentationRow(f, item.id)!;
    assert.equal(row.querySelector('[data-ekko-technical]'), null, item.id);
    assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, item.content, item.id);
    assert.ok(row.querySelector('[data-copy-reply]'), item.id);
  }
  roomMessage(f, 'result-name', exact, { role: undefined });
  assert.ok(presentationRow(f, 'result-name')!.querySelector('[data-ekko-technical]'));
  roomMessage(f, 'result-name', exact, { role: 'user' });
  assert.equal(presentationRow(f, 'result-name')!.querySelector('[data-ekko-technical]'), null);
  roomMessage(f, 'result-name', exact, { senderId: 'auth:7' });
  assert.equal(presentationRow(f, 'result-name')!.querySelector('[data-ekko-technical]'), null);
  roomMessage(f, 'result-name', exact);
  assert.ok(presentationRow(f, 'result-name')!.querySelector('[data-ekko-technical]'));
});

for (const transport of ['history', 'event'] as const) test(`room standalone result ${transport} keeps invalid outline IDs readable as normal replies`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const messages = ['fictional-root', '20990101000000-aaaaaaa extra', '(20990101000000-aaaaaaa)'].map((id, index) =>
    presentationMessage('bad-outline-id-' + index, JSON.stringify({ result: `Document outline (1 headings):\n\n- [Fictional] (id: ${id}, depth: 0)` })));
  presentationHistory(f, transport === 'history' ? messages : []); await linked(f);
  if (transport === 'event') for (const item of messages) roomMessage(f, item.id, item.content);
  for (const item of messages) {
    const row = presentationRow(f, item.id)!;
    assert.equal(row.querySelector('[data-ekko-technical]'), null, item.content);
    assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, item.content);
    assert.ok(row.querySelector('[data-copy-reply]')); assert.ok(row.querySelector('[data-ekko-action="reply"]'));
  }
});

// Observed role metadata is modeled synthetically; these tests do not access a real room.
const explicitRoomToolContents = [
  ['canonical-search', standaloneExactResults[0][1]], ['canonical-outline', standaloneExactResults[1][1]],
  ['sql-text', ' \r\nfictional_id | count\r\nrow-one | 2\r\n'],
  ['arbitrary-result', '{"result":"arbitrary fictional return","extra":"complete"}'],
  ['json-scalar', '42'], ['json-string', '"fictional scalar"'], ['json-array', '["fictional",2]'],
  ['code', '```sql\nSELECT 1 AS fictional_count;\n```'],
  ['html', '<img src=x onerror=alert(1)><script>fictional unsafe text</script>'],
] as const;
for (const transport of ['history', 'event'] as const) for (const [kind, exact] of explicitRoomToolContents) {
  test(`room explicit tool ${transport} ${kind} preserves collapsed exact original without normal actions`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
    presentationHistory(f, transport === 'history' ? [presentationMessage('explicit-tool', exact, { role: 'tool', isStreaming: false })] : []);
    await linked(f); if (transport === 'event') roomMessage(f, 'explicit-tool', exact, { role: 'tool', isStreaming: false });
    const row = presentationRow(f, 'explicit-tool')!;
    const detail = row.querySelector<HTMLDetailsElement>('[data-ekko-technical]');
    assert.ok(detail); assert.equal(detail.open, false);
    assert.equal(detail.querySelector('summary')!.textContent, '工具结果（展开查看原文）');
    assert.equal(detail.querySelector('pre code')!.textContent, exact);
    assert.equal(row.querySelector('button,.sac-ekko-message-content,img,script,[onerror]'), null);
    detail.open = true; const original = detail.querySelector('code')!;
    roomMessage(f, 'explicit-unrelated', '另一条普通消息');
    assert.equal(presentationRow(f, 'explicit-tool')!.querySelector('[data-ekko-technical]'), detail);
    assert.equal(detail.open, true); assert.equal(detail.querySelector('code'), original);
  });
}
for (const transport of ['history', 'event'] as const) test(`room explicit tool ${transport} streaming hides plain and structured partial outputs`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const messages = explicitRoomToolContents.map(([kind, content]) => presentationMessage('stream-' + kind, content, { role: 'tool', isStreaming: true }));
  presentationHistory(f, transport === 'history' ? messages : []); await linked(f);
  if (transport === 'event') for (const item of messages) roomMessage(f, item.id, item.content, { role: 'tool', isStreaming: true });
  for (const item of messages) {
    const row = presentationRow(f, item.id)!;
    assert.equal(row.querySelector('[role="status"]')!.textContent, '正在回复…');
    assert.equal(row.querySelector('button,pre,[data-ekko-technical],.sac-ekko-message-content,img,script'), null);
    assert.doesNotMatch(row.textContent!, /total_available|Document outline|fictional|SELECT|arbitrary/);
  }
});

test('room explicit tool same-ID role completion streaming and source transitions replace stale controls', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  presentationHistory(f, []); await linked(f);
  const exact = ' \r\nfictional SQL result\r\n'; const id = 'explicit-update';
  const copied: string[] = [];
  Object.defineProperty(f.dom.window.navigator, 'clipboard', { value: { writeText: async (value: string) => { copied.push(value); } } });
  const normal = () => {
    const row = presentationRow(f, id)!;
    assert.equal(row.querySelector('[data-ekko-technical],[role="status"]'), null);
    assert.ok(row.querySelector('[data-copy-reply]')); assert.ok(row.querySelector('[data-ekko-action="reply"]'));
  };
  roomMessage(f, id, '正常 assistant 答复'); normal();
  roomMessage(f, id, exact, { role: 'tool', isStreaming: false });
  assert.equal(presentationRow(f, id)!.querySelector('pre')!.textContent, exact);
  assert.equal(presentationRow(f, id)!.querySelector('button'), null);
  roomMessage(f, id, exact, { role: 'tool', isStreaming: true });
  assert.equal(presentationRow(f, id)!.querySelector('[role="status"]')!.textContent, '正在回复…');
  assert.equal(presentationRow(f, id)!.querySelector('pre,button'), null);
  roomMessage(f, id, exact, { role: 'tool', isStreaming: false });
  assert.equal(presentationRow(f, id)!.querySelector('pre')!.textContent, exact);
  for (const extra of [{ role: 'user' }, { role: 'tool', senderId: 'auth:7' }, { role: 'tool', senderId: 'unknown' }, { role: 'assistant' }]) {
    roomMessage(f, id, exact, { isStreaming: false, ...extra }); normal();
    // The ordinary HTML body normalizes line endings; copying must still use the current raw record.
    assert.equal(presentationRow(f, id)!.querySelector('.sac-ekko-message-content')!.textContent, ' \nfictional SQL result\n');
    presentationRow(f, id)!.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click(); await tick();
    assert.equal(copied.at(-1), exact);
  }
  roomMessage(f, id, ' \r\n', { role: 'tool', isStreaming: false }); assert.equal(presentationRow(f, id), undefined);
});

test('room explicit tool refuses unknown source and present undefined or malformed completion proof while assistant stays readable', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const exact = '{"result":"fictional arbitrary return"}';
  const messages = [
    presentationMessage('role-name-only', exact, { role: 'tool', senderId: undefined, senderName: '助手', isStreaming: false }),
    presentationMessage('role-foreign', exact, { role: 'tool', senderId: 'foreign', isStreaming: false }),
    presentationMessage('role-auth', exact, { role: 'tool', senderId: 'auth:7', isStreaming: false }),
    presentationMessage('role-user', exact, { role: 'user', isStreaming: false }),
    presentationMessage('role-undefined-flag', exact, { role: 'tool', isStreaming: undefined }),
    ...[null, 0, 'false', 'true'].map((isStreaming, i) => presentationMessage('role-bad-flag-' + i, exact,
      { role: 'tool', isStreaming: isStreaming as unknown as boolean })),
    presentationMessage('role-normal-assistant', exact, { isStreaming: false }),
    presentationMessage('role-assistant-prose', '解释 ' + JSON.stringify(standaloneOutlineResult), { isStreaming: false }),
    presentationMessage('role-assistant-fence', '```json\n' + JSON.stringify(standaloneOutlineResult) + '\n```', { isStreaming: false }),
  ];
  presentationHistory(f, messages); await linked(f);
  for (const item of messages) {
    const row = presentationRow(f, item.id)!;
    assert.equal(row.querySelector('[data-ekko-technical],[role="status"]'), null, item.id);
    assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, item.content, item.id);
    assert.ok(row.querySelector('[data-copy-reply]'), item.id);
  }
});

for (const transport of ['history', 'event'] as const) for (const [kind, exact] of explicitRoomToolContents) {
  test(`room omitted tool ${transport} ${kind} is complete only on the full-message channel`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
    const item = presentationMessage('omitted-tool', exact, { preservesStreamingFlagPresence: true, role: 'tool' });
    assert.equal(Object.hasOwn(item, 'isStreaming'), false);
    presentationHistory(f, transport === 'history' ? [item] : []); await linked(f);
    if (transport === 'event') roomMessage(f, item.id, exact, { preservesStreamingFlagPresence: true, role: 'tool' });
    const row = presentationRow(f, item.id)!;
    const detail = row.querySelector<HTMLDetailsElement>('[data-ekko-technical]');
    assert.ok(detail); assert.equal(detail.open, false); assert.equal(detail.querySelector('pre code')!.textContent, exact);
    assert.equal(row.querySelector('button,.sac-ekko-message-content,img,script,[onerror]'), null);
    detail.open = true;
    roomMessage(f, 'omitted-unrelated', '普通答复');
    assert.equal(presentationRow(f, item.id)!.querySelector('[data-ekko-technical]'), detail); assert.equal(detail.open, true);
    const history = [...(f.ui as any).histories.values()].flat() as Array<import('../src/ekko/bridge.ts').EkkoMessage>;
    const raw = history.find(message => message.id === item.id)!;
    assert.equal(raw.content, exact); assert.equal(Object.hasOwn(raw, 'isStreaming'), false);
  });
}

test('room omitted tool raw stream without flags never becomes durable body and omitted final replaces same-ID waiting', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  presentationHistory(f, []); await linked(f);
  const id = 'omitted-final'; const content = 'fictional private partial SQL';
  for (const type of ['message_stream_start', 'message_stream_delta', 'message_stream_snapshot', 'message_reasoning_delta', 'message_stream_end']) {
    f.emitEvent(room.id, { event: 'room.stream', data: { id, roomId: room.id, senderId: 'agent-one', role: 'tool', preservesStreamingFlagPresence: true, type, content, delta: content } });
    assert.equal(presentationRow(f, id), undefined); assert.doesNotMatch(f.root.querySelector('[data-ekko-messages]')!.textContent!, /fictional private partial/);
    assert.equal([...(f.ui as any).histories.values()].flat().some((message: any) => message.id === id), false);
  }
  roomMessage(f, id, content, { preservesStreamingFlagPresence: true, role: 'tool', isStreaming: true });
  assert.equal(presentationRow(f, id)!.querySelector('[role="status"]')!.textContent, '正在回复…');
  assert.equal(presentationRow(f, id)!.querySelector('button,pre'), null);
  const complete = ' \r\nfictional final SQL rows\r\n';
  roomMessage(f, id, complete, { preservesStreamingFlagPresence: true, role: 'tool' });
  assert.equal(presentationRow(f, id)!.querySelector('pre')!.textContent, complete);
  assert.equal(presentationRow(f, id)!.querySelector('button,[role="status"]'), null);
  assert.equal(f.root.querySelectorAll('[data-message-id="omitted-final"]').length, 1);
  roomMessage(f, id, ' \r\n', { preservesStreamingFlagPresence: true, role: 'tool' }); assert.equal(presentationRow(f, id), undefined);
});

for (const roster of ['foreign-room', 'conflicting-names'] as const) test(`room omitted tool rejects ${roster} roster proof and foreign full-message events`, async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const item = presentationMessage('omitted-untrusted', '{"result":"arbitrary fictional text"}', { preservesStreamingFlagPresence: true, role: 'tool' });
  (f.client.room as any) = async () => ({ room, messages: [item], hasMore: false,
    agents: roster === 'foreign-room' ? [{ roomId: secondRoom.id, agentId: 'agent-one', name: '助手' }] :
      [{ roomId: room.id, agentId: 'agent-one', name: '助手' }, { roomId: room.id, agentId: 'agent-one', name: '冲突姓名' }] });
  await linked(f);
  assert.equal(presentationRow(f, item.id)!.querySelector('[data-ekko-technical]'), null);
  assert.equal(presentationRow(f, item.id)!.querySelector('.sac-ekko-message-content')!.textContent, item.content);
  assert.ok(presentationRow(f, item.id)!.querySelector('[data-copy-reply]'));
  f.emitEvent(room.id, { event: 'room.message', data: { ...item, id: 'omitted-foreign', roomId: secondRoom.id } });
  assert.equal(presentationRow(f, 'omitted-foreign'), undefined);
});

test('room omitted tool full-message identity and present invalid flags stay readable unless provenance is exact', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
  const content = '{"result":"fictional arbitrary return"}';
  const messages = [
    presentationMessage('omitted-name', content, { preservesStreamingFlagPresence: true, role: 'tool', senderId: undefined, senderName: '助手' }),
    presentationMessage('omitted-unknown', content, { preservesStreamingFlagPresence: true, role: 'tool', senderId: 'foreign' }),
    presentationMessage('omitted-auth', content, { preservesStreamingFlagPresence: true, role: 'tool', senderId: 'auth:7' }),
    presentationMessage('omitted-user', content, { preservesStreamingFlagPresence: true, role: 'user' }),
    ...[undefined, null, 0, 'false', 'true'].map((isStreaming, i) => presentationMessage('omitted-invalid-' + i, content,
      { preservesStreamingFlagPresence: true, role: 'tool', isStreaming: isStreaming as unknown as boolean })),
  ];
  presentationHistory(f, messages); await linked(f);
  for (const item of messages) {
    const row = presentationRow(f, item.id)!;
    assert.equal(row.querySelector('[data-ekko-technical],[role="status"]'), null, item.id);
    assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, item.content, item.id);
    assert.ok(row.querySelector('[data-copy-reply]'), item.id);
  }
});

const bridgeCapabilityFixtures = [
  { name: 'absent', extra: {} }, { name: 'false', extra: { preservesStreamingFlagPresence: false } },
  { name: 'undefined', extra: { preservesStreamingFlagPresence: undefined } },
  { name: 'null', extra: { preservesStreamingFlagPresence: null } },
  { name: 'wrong-string', extra: { preservesStreamingFlagPresence: 'true' } },
] as const;
for (const transport of ['history', 'event'] as const) for (const scenario of bridgeCapabilityFixtures) {
  test(`room capability boundary ${transport} ${scenario.name} missing flag stays readable for legacy projection`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
    const item = { ...presentationMessage('legacy-capability', 'fictional generic SQL rows', { role: 'tool' }), ...scenario.extra } as unknown as ReturnType<typeof presentationMessage>;
    presentationHistory(f, transport === 'history' ? [item] : []); await linked(f);
    if (transport === 'event') f.emitEvent(room.id, { event: 'room.message', data: item });
    const row = presentationRow(f, item.id)!;
    assert.equal(row.querySelector('[data-ekko-technical]'), null);
    assert.equal(row.querySelector('.sac-ekko-message-content')!.textContent, item.content);
    assert.ok(row.querySelector('[data-copy-reply]')); assert.ok(row.querySelector('[data-ekko-action="reply"]'));
  });
}
test('room capability boundary same-ID legacy view upgrades locally without changing raw streaming field presence', async t => {
  const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); presentationHistory(f, []); await linked(f);
  const item = presentationMessage('capability-upgrade', ' \r\nfictional SQL rows\r\n', { role: 'tool' });
  f.emitEvent(room.id, { event: 'room.message', data: item });
  assert.ok(presentationRow(f, item.id)!.querySelector('[data-copy-reply]'));
  f.emitEvent(room.id, { event: 'room.message', data: { ...item, preservesStreamingFlagPresence: true } });
  const detail = presentationRow(f, item.id)!.querySelector<HTMLDetailsElement>('[data-ekko-technical]')!;
  assert.ok(detail); assert.equal(detail.querySelector('pre')!.textContent, item.content); assert.equal(detail.open, false);
  assert.equal(presentationRow(f, item.id)!.querySelector('button'), null);
  detail.open = true; roomMessage(f, 'capability-unrelated', '普通答复');
  assert.equal(presentationRow(f, item.id)!.querySelector('[data-ekko-technical]'), detail); assert.equal(detail.open, true);
  assert.equal(Object.hasOwn(item, 'preservesStreamingFlagPresence'), false); assert.equal(Object.hasOwn(item, 'isStreaming'), false);
});


// Removing scene revalidation must break these public component interaction regressions.
test('same-document room scene refresh preserves quote draft agent and explicit submit', async t => {
  const f = fixture(); t.after(() => f.ui.dispose());
  let scene = 'navigation-one'; f.options.getSceneIdentity = () => scene;
  await linked(f);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
  roomInput(f, '虚构回复'); openRobotButton(f); robotOptions(f)[0].click();
  const original = f.ui.activeLink;
  let assertions = 0; const assertLinked = f.options.store.assertLinked;
  f.options.store.assertLinked = async (...args) => { assertions++; return assertLinked(...args); };
  scene = 'navigation-two'; await f.ui.documentChanged();
  assert.deepEqual(f.ui.activeLink, original); assert.ok(assertions > 0, 'recovery rechecks the exact saved room link');
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '虚构回复');
  assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));
  assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 1);
  openRobotButton(f); assert.equal(robotOptions(f).length, 1); roomKey(f, 'Escape');
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="cancel-reply"]')!.click();
  assert.equal(f.root.querySelector('[data-ekko-reply-preview]'), null);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="open-sources"]')!.click();
  assert.equal(f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!.open, true);
  assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked').length, 0);
  assert.equal(f.sent.length, 0, 'recovery and browsing never send');
  f.root.querySelector<HTMLButtonElement>('[data-ekko-send-form] button[type="submit"]')!.click();
  await tick(); assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0].payload.mentions, [{ type: 'agent', participantId: 'agent-one', displayName: '助手' }]);
  assert.equal(f.sent[0].payload.content, '@助手 虚构回复\n\n<quoted_message>\n【引用：测试用户】\n<script>alert(1)</script>\n</quoted_message>');
});

for (const action of ['mention-agents', 'cancel-reply', 'open-sources', 'submit'] as const)
  test(`stale room ${action} explains readonly recovery without sending`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose());
    let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '原草稿');
    scene = 'two';
    if (action === 'submit') f.root.querySelector<HTMLButtonElement>('[data-ekko-send-form] button[type="submit"]')!.click();
    else f.root.querySelector<HTMLButtonElement>(`[data-ekko-action="${action}"]`)!.click();
    assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /页面.*变化|页面.*过期/);
    assert.ok(f.root.querySelector('[data-ekko-send-form] [data-ekko-action="refresh"]:not([hidden])'));
    assert.equal(f.sent.length, 0); assert.equal(f.ui.unknownMessageId(), undefined);
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '原草稿');
    assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));
  });

test('room composer shows real preparation submission and unknown guards', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); await linked(f); roomInput(f, '发送草稿');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.client.connection;
  f.client.connection = async () => { entered(); await gate; return original(); };
  f.setSendResult('unknown'); let finish!: () => void; f.setSendGate(new Promise<void>(resolve => { finish = resolve; }));
  const sending = f.ui.sendCurrent(); await started;
  try {
    assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /准备.*发送|核对.*发送/);
    await f.ui.sendCurrent(); openRobotButton(f); assert.equal(robotOptions(f).length, 0); assert.equal(f.sent.length, 0);
    release(); await tick(); assert.equal(f.sent.length, 1);
    assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /正在提交|等待.*结果/);
    await f.ui.sendCurrent(); assert.equal(f.sent.length, 1);
  } finally { release(); finish(); await sending; }
  assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /待核对|结果未知/);
  assert.ok(f.root.querySelector('[data-ekko-action="check-unknown"]:not([hidden])'));
});


test('readonly room refresh blocks duplicate actions until verified and never replaces an active send', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); await linked(f); roomInput(f, '刷新中草稿');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.client.connection;
  let reads = 0; f.client.connection = async () => { reads++; entered(); await gate; return original(); };
  const refreshing = f.ui.refresh(); await started;
  try {
    openRobotButton(f); assert.equal(robotOptions(f).length, 0);
    await f.ui.sendCurrent(); await f.ui.refresh();
    assert.equal(f.sent.length, 0); assert.equal(reads, 1, 'repeated readonly recovery is coalesced');
    assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /正在刷新/);
  } finally { release(); await refreshing; }
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '刷新中草稿');
});

for (const stage of ['preparing', 'submitting'] as const) test(`same-document navigation during ${stage} retains frozen input and late outcome`, async t => {
  const f = fixture(); t.after(() => f.ui.dispose());
  let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); const input = roomInput(f, '活动发送');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  if (stage === 'preparing') { const original = f.client.connection; f.client.connection = async () => { entered(); await gate; return original(); }; }
  else { f.setSendGate(gate); const original = f.client.send; f.client.send = async (...args) => { entered(); return original(...args); }; f.setSendResult('unknown'); }
  const sending = f.ui.sendCurrent(); await started;
  const pending = JSON.stringify([...f.pendingData]);
  try {
    scene = 'two'; await f.ui.documentChanged(); await f.ui.refresh();
    assert.equal(f.root.querySelector('[data-ekko-composer]'), input, 'active send DOM must stay attached');
    assert.equal(input.value, '活动发送'); assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));
    assert.equal(JSON.stringify([...f.pendingData]), pending);
    assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /页面.*变化/);
    await f.ui.sendCurrent();
  } finally { release(); await sending; }
  assert.equal(f.sent.length, stage === 'preparing' ? 0 : 1);
  if (stage === 'submitting') assert.ok(f.ui.unknownMessageId());
  else assert.equal(f.ui.unknownMessageId(), undefined);
  await f.ui.refresh();
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '活动发送');
  assert.ok(f.root.querySelector('[data-ekko-reply-preview]'));
  assert.equal(f.sent.length, stage === 'preparing' ? 0 : 1, 'refresh never retries an outcome');
});

test('failed same-document readonly recovery retains quote selection and pending without adopting the scene', async t => {
  const f = fixture(); t.after(() => f.ui.dispose());
  let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '待核对草稿');
  openRobotButton(f); robotOptions(f)[0].click(); f.setSendResult('unknown'); await f.ui.sendCurrent();
  const id = f.ui.unknownMessageId(), pending = JSON.stringify([...f.pendingData]);
  scene = 'two'; f.setOffline(true); await f.ui.documentChanged();
  assert.match(f.root.querySelector('[data-ekko-status]')?.textContent ?? '', /刷新.*失败/);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '待核对草稿');
  assert.ok(f.root.querySelector('[data-ekko-reply-preview]')); assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 1);
  assert.equal(f.ui.unknownMessageId(), id); assert.equal(JSON.stringify([...f.pendingData]), pending);
  openRobotButton(f); assert.equal(robotOptions(f).length, 0); await f.ui.sendCurrent(); assert.equal(f.sent.length, 1);
  f.setOffline(false); await f.ui.refresh(); assert.equal(f.ui.unknownMessageId(), id);
  assert.equal(JSON.stringify([...f.pendingData]), pending); assert.equal(f.sent.length, 1);
  assert.ok(f.root.querySelector('[data-ekko-action="check-unknown"]:not([hidden])'));
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="open-sources"]')!.click();
  assert.equal(f.root.querySelector<HTMLDetailsElement>('[data-ekko-source-details]')!.open, true);
});

for (const change of ['scene', 'view', 'document', 'work', 'connection', 'leave', 'dispose'] as const)
  test(`late same-document readonly recovery cannot overwrite changed ${change}`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one', current = true;
    f.options.getSceneIdentity = () => scene; f.options.isCurrent = () => current; await linked(f); roomInput(f, '原场景草稿');
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const original = f.client.connection; f.client.connection = async () => { entered(); await gate; return original(); };
    scene = 'two'; const recovery = f.ui.documentChanged(); await started; f.client.connection = original;
    if (change === 'scene') { scene = 'three'; await f.ui.documentChanged(); }
    if (change === 'view') current = false;
    if (change === 'document') { f.setDocument(B); await f.ui.documentChanged(); }
    if (change === 'work') { f.setWork(B); await f.ui.workChanged(); }
    if (change === 'connection') f.ui.connectionChanged();
    if (change === 'leave') f.ui.leave();
    if (change === 'dispose') f.ui.dispose();
    const html = f.root.innerHTML, active = f.ui.activeLink, pending = JSON.stringify([...f.pendingData]);
    release(); await recovery;
    assert.equal(f.root.innerHTML, html); assert.equal(f.ui.activeLink, active);
    assert.equal(JSON.stringify([...f.pendingData]), pending); assert.equal(f.sent.length, 0);
  });

for (const change of ['link', 'account', 'device', 'connection'] as const)
  test(`same-document recovery rejects changed exact ${change} and retains origin draft`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
    const original = { ...f.links[0] }; f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '原身份草稿');
    openRobotButton(f); robotOptions(f)[0].click();
    if (change === 'link') f.links.splice(0);
    else f.setConnection({ ...connection, ...(change === 'account' ? { accountUserId: 8 } : change === 'device' ? { deviceId: 'other-device' } : { id: 'other-connection' }) });
    scene = 'two'; await f.ui.documentChanged(); assert.equal(f.ui.activeLink, null); assert.equal(f.sent.length, 0);
    assert.match(f.root.querySelector('[data-ekko-status]')?.textContent ?? '', /关联|身份/);
    f.setConnection(connection); if (change === 'link') f.links.push(original);
    await f.ui.refresh(); await f.ui.openRoom(room.id);
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '原身份草稿');
    assert.ok(f.root.querySelector('[data-ekko-reply-preview]')); assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 1);
  });


for (const bridge of ['missing', 'changed'] as const) test(`same-document scene does not auto-adopt ${bridge} stable Bridge identity`, async t => {
  const f = fixture(); t.after(() => f.ui.dispose());
  let scene = 'one', key = 'fictional-bridge-one';
  f.options.getSceneIdentity = () => scene;
  f.options.getBridgeIdentity = bridge === 'missing' ? undefined : () => key;
  await linked(f); roomInput(f, '原Bridge草稿');
  const input = f.root.querySelector('[data-ekko-composer]');
  let reads = 0; const original = f.client.connection;
  f.client.connection = async () => { reads++; return original(); };
  scene = 'two'; key = 'fictional-bridge-two'; await f.ui.documentChanged();
  assert.equal(reads, 0, 'automatic recovery needs the original stable Bridge identity');
  assert.equal(f.root.querySelector('[data-ekko-composer]'), input); openRobotButton(f); assert.equal(robotOptions(f).length, 0);
  assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /页面.*变化/);
  assert.equal(f.sent.length, 0);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-send-form] [data-ekko-action="refresh"]')!.click(); await tick();
  assert.ok(reads > 0); openRobotButton(f); assert.equal(robotOptions(f).length, 1);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '原Bridge草稿'); assert.equal(f.sent.length, 0);
});


test('acknowledged room send reports confirmed stage while local pending cleanup waits', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); await linked(f); roomInput(f, '确认消息');
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const clear = f.options.pendingStore.clear;
  f.options.pendingStore.clear = async (...args) => { entered(); await gate; return clear.apply(f.options.pendingStore, args); };
  const sending = f.ui.sendCurrent(); await started;
  try {
    assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /发送已确认/);
    await f.ui.sendCurrent(); assert.equal(f.sent.length, 1);
  } finally { release(); await sending; }
  assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-composer-state]')!.hidden, true);
});


test('same-document readonly recovery preserves long inert quote and ordinary JSON exactly', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene;
  const content = '{"ordinary":"JSON @助手 <script>globalThis.injected=true</script> </quoted_message>"}\n' + '虚构长引用 '.repeat(3000);
  f.history[room.id] = [message('m-1', content)]; await linked(f);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '明确回复');
  scene = 'two'; await f.ui.documentChanged();
  assert.equal(f.root.querySelector('[data-ekko-reply-preview] pre')!.textContent, content);
  assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0, 'quote @ remains inert');
  assert.equal(f.root.querySelector('script'), null); assert.equal(f.sent.length, 0);
  await f.ui.sendCurrent(); assert.equal(f.sent.length, 1); assert.deepEqual(f.sent[0].payload.mentions, []);
  assert.equal(f.sent[0].payload.content, '明确回复\n\n<quoted_message>\n【引用：测试用户】\n' + content.replaceAll('</quoted_message>', '&lt;/quoted_message>') + '\n</quoted_message>');
});

test('same-document recovery cannot replace frozen reply with edited original or silently send it', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '保留引用草稿');
  f.history[room.id] = [message('m-1', '后来编辑的虚构原文')]; scene = 'two'; await f.ui.documentChanged();
  assert.equal(f.root.querySelector('[data-ekko-reply-preview] pre')!.textContent, '<script>alert(1)</script>');
  await f.ui.sendCurrent(); assert.equal(f.sent.length, 0); assert.equal(f.ui.unknownMessageId(), undefined);
  assert.match(f.root.querySelector('[data-ekko-status]')?.textContent ?? '', /引用原消息已变化/);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '保留引用草稿');
});


for (const action of ['check-unknown', 'discard-unknown'] as const) test(`stale ${action} retains original pending until readonly room recovery`, async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); let bridge = 'original'; f.options.getBridgeIdentity = () => bridge;
  await linked(f); roomInput(f, '原未决草稿'); f.setSendResult('unknown'); await f.ui.sendCurrent();
  const id = f.ui.unknownMessageId(), pending = JSON.stringify([...f.pendingData]); let reads = 0, confirms = 0;
  f.client.sendStatus = async () => { reads++; return { state: 'sent' }; }; f.dom.window.confirm = () => { confirms++; return true; };
  bridge = 'replacement'; f.root.querySelector<HTMLButtonElement>(`[data-ekko-action="${action}"]`)!.click(); await tick();
  assert.equal(reads, 0); assert.equal(confirms, 0); assert.equal(f.ui.unknownMessageId(), id);
  assert.equal(JSON.stringify([...f.pendingData]), pending); assert.equal(f.sent.length, 1);
  assert.match(f.root.querySelector('[data-ekko-composer-state]')?.textContent ?? '', /页面.*变化/);
});


function holdRoomRecovery(f: ReturnType<typeof fixture>, stage: 'connection' | 'room' | 'sources' | 'pending', error?: Error) {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const wait = async () => { entered(); await gate; if (error) throw error; };
  let restore: () => void;
  if (stage === 'connection') { const original = f.client.connection; f.client.connection = async () => { await wait(); return original(); }; restore = () => { f.client.connection = original; }; }
  else if (stage === 'room') { const original = f.client.room; f.client.room = async (...args) => { await wait(); return original(...args); }; restore = () => { f.client.room = original; }; }
  else if (stage === 'sources') { const original = f.options.availableSources; f.options.availableSources = async (...args) => { await wait(); return original(...args); }; restore = () => { f.options.availableSources = original; }; }
  else { const original = f.options.pendingStore.get.bind(f.options.pendingStore); f.options.pendingStore.get = async (...args) => { await wait(); return original(...args); }; restore = () => { f.options.pendingStore.get = original; }; }
  return { started, release, restore };
}

for (const stage of ['connection', 'room', 'sources', 'pending'] as const)
  test(`fix1 readonly ${stage} gate retains latest same-room edits before atomic handoff`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '开始刷新前'); openRobotButton(f); robotOptions(f)[0].click();
    const gate = holdRoomRecovery(f, stage); scene = 'two'; const recovery = f.ui.documentChanged(); await gate.started;
    try {
      const input = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]'); assert.ok(input, 'original composer remains visible until all readonly stages succeed');
      roomInput(f, '开始刷新前，等待期间的新文字'); openRobotButton(f); assert.equal(robotOptions(f).length, 0);
      f.root.querySelector<HTMLButtonElement>('[data-ekko-action="cancel-reply"]')!.click();
      assert.ok(f.root.querySelector('[data-ekko-reply-preview]')); await f.ui.sendCurrent(); assert.equal(f.sent.length, 0);
    } finally { gate.restore(); gate.release(); await recovery; }
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '开始刷新前，等待期间的新文字');
    assert.equal(f.root.querySelector('[data-ekko-reply-preview] pre')!.textContent, '<script>alert(1)</script>');
    assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 1); assert.equal(f.sent.length, 0);
  });

for (const stage of ['room', 'sources', 'pending'] as const) for (const unknown of [false, true])
  test(`fix1 failed ${stage} readonly recovery keeps visible ${unknown ? 'unknown' : 'unsent'} draft protected and retryable`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); const input = roomInput(f, '原可见草稿'); openRobotButton(f); robotOptions(f)[0].click();
    if (unknown) { f.setSendResult('unknown'); await f.ui.sendCurrent(); }
    const id = f.ui.unknownMessageId(), pending = JSON.stringify([...f.pendingData]), sent = f.sent.length, link = f.ui.activeLink;
    const gate = holdRoomRecovery(f, stage, Error('虚构后段读取暂时失败')); scene = 'two'; const recovery = f.ui.documentChanged(); await gate.started;
    if (f.root.querySelector('[data-ekko-composer]')) roomInput(f, '原可见草稿，读取中继续编辑');
    gate.restore(); gate.release(); await recovery;
    assert.equal(f.root.querySelector('[data-ekko-composer]'), input); assert.equal(input.value, '原可见草稿，读取中继续编辑');
    assert.equal(f.ui.activeLink, link); assert.equal(f.ui.unknownMessageId(), id); assert.equal(JSON.stringify([...f.pendingData]), pending);
    assert.ok(f.root.querySelector('[data-ekko-reply-preview]')); assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 1);
    assert.match(f.root.querySelector('[data-ekko-status]')?.textContent ?? '', /刷新.*失败/);
    const retry = f.root.querySelector<HTMLButtonElement>('[data-ekko-send-form] [data-ekko-action="refresh"]:not([hidden])'); assert.ok(retry); assert.equal(retry.disabled, false);
    if (unknown) { assert.ok(f.root.querySelector('[data-ekko-action="check-unknown"]:not([hidden])')); assert.ok(f.root.querySelector('[data-ekko-action="discard-unknown"]:not([hidden])')); }
    await f.ui.sendCurrent(); openRobotButton(f); assert.equal(robotOptions(f).length, 0); assert.equal(f.sent.length, sent);
    await f.ui.refresh(); assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '原可见草稿，读取中继续编辑');
    assert.equal(f.ui.unknownMessageId(), id); assert.equal(JSON.stringify([...f.pendingData]), pending); assert.equal(f.sent.length, sent);
    if (!unknown) { openRobotButton(f); assert.equal(robotOptions(f).length, 1); }
  });

for (const stage of ['room', 'sources', 'pending'] as const) for (const change of ['document', 'work', 'bridge', 'view'] as const)
  test(`fix1 late failed ${stage} recovery cannot restore old unknown draft into changed ${change}`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one', bridge = 'original', current = true;
    f.options.getSceneIdentity = () => scene; f.options.getBridgeIdentity = () => bridge; f.options.isCurrent = () => current; await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '原未知草稿'); openRobotButton(f); robotOptions(f)[0].click(); f.setSendResult('unknown'); await f.ui.sendCurrent();
    const pending = JSON.stringify([...f.pendingData]); const gate = holdRoomRecovery(f, stage, Error('迟到旧读取失败'));
    scene = 'two'; const recovery = f.ui.documentChanged(); await gate.started; gate.restore();
    if (change === 'document') { f.setDocument(B); await f.ui.documentChanged(); }
    if (change === 'work') { f.setWork(B); await f.ui.workChanged(); }
    if (change === 'bridge') bridge = 'replacement';
    if (change === 'view') current = false;
    const html = f.root.innerHTML, active = f.ui.activeLink; gate.release(); await recovery;
    assert.equal(f.root.innerHTML, html); assert.equal(f.ui.activeLink, active); assert.equal(JSON.stringify([...f.pendingData]), pending); assert.equal(f.sent.length, 1);
  });

test('fix1 unchanged-scene room read failure keeps original composer blocked until explicit retry succeeds', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); await linked(f); const input = roomInput(f, '刷新未成功草稿');
  const original = f.client.room; f.client.room = async () => { throw Error('虚构历史读取失败'); }; await f.ui.refresh();
  assert.equal(f.root.querySelector('[data-ekko-composer]'), input); await f.ui.sendCurrent(); openRobotButton(f);
  assert.equal(robotOptions(f).length, 0); assert.equal(f.sent.length, 0);
  assert.ok(f.root.querySelector('[data-ekko-send-form] [data-ekko-action="refresh"]:not([hidden])'));
  f.client.room = original; await f.ui.refresh(); openRobotButton(f); assert.equal(robotOptions(f).length, 1);
});


for (const change of ['identity', 'link'] as const) for (const unknown of [false, true])
  test(`fix1 late ${change} rejection is isolated instead of restoring ${unknown ? 'unknown' : 'unsent'} room`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '原拒绝场景草稿');
    if (unknown) { f.setSendResult('unknown'); await f.ui.sendCurrent(); }
    const id = f.ui.unknownMessageId(), pending = JSON.stringify([...f.pendingData]), sent = f.sent.length;
    const error = change === 'identity' ? new BridgeError('虚构身份变化', 403, 'identity_changed') : Error('虚构读取失败');
    const gate = holdRoomRecovery(f, 'room', error); scene = 'two'; const recovery = f.ui.documentChanged(); await gate.started;
    if (change === 'link') f.links.splice(0); gate.restore(); gate.release(); await recovery;
    if (change === 'link') { assert.equal(f.ui.activeLink, null); assert.match(f.root.querySelector('[data-ekko-status]')?.textContent ?? '', /关联.*变化/); }
    else { assert.match(f.root.querySelector('[data-ekko-status]')?.textContent ?? '', /账号身份已变化/); assert.equal(f.root.querySelectorAll('[data-ekko-composer]:not(:disabled)').length, 0); if (unknown) assert.equal(f.ui.unknownMessageId(), id); }
    assert.equal(JSON.stringify([...f.pendingData]), pending); await f.ui.sendCurrent(); assert.equal(f.sent.length, sent);
  });

test('fix1 scope retention cannot mark a failed readonly recovery ready without rereading room', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); await linked(f); roomInput(f, '仍需只读核对');
  const original = f.client.room; f.client.room = async () => { throw Error('虚构资料读取失败'); }; await f.ui.refresh();
  f.ui.retainActiveRoomAfterScopePreparation(f.ui.activeLink, DOC); openRobotButton(f); assert.equal(robotOptions(f).length, 0);
  await f.ui.sendCurrent(); assert.equal(f.sent.length, 0); f.client.room = original;
  await f.ui.refresh(); openRobotButton(f); assert.equal(robotOptions(f).length, 1);
});


test('fix1 typing preservation does not adopt stale unchecked source or Agent controls', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f); roomInput(f, '只保留自由输入');
  const gate = holdRoomRecovery(f, 'connection'); scene = 'two'; const recovery = f.ui.documentChanged(); await gate.started;
  for (const selector of ['[data-ekko-agent]', '[data-ekko-source]']) { const input = f.root.querySelector<HTMLInputElement>(selector)!; input.checked = true; input.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); }
  roomInput(f, '只保留自由输入，新增正文'); gate.restore(); gate.release(); await recovery;
  assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked, [data-ekko-source]:checked').length, 0);
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '只保留自由输入，新增正文'); assert.equal(f.sent.length, 0);
});


for (const stage of ['sources', 'pending'] as const) for (const destination of ['same', 'document', 'bridge'] as const)
  test(`fix2 active ${stage} recovery cannot be unlocked by retention before ${destination} scene`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one', bridge = 'original';
    f.options.getSceneIdentity = () => scene; f.options.getBridgeIdentity = () => bridge; await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '恢复中保留正文');
    const gate = holdRoomRecovery(f, stage); scene = 'two'; const recovery = f.ui.documentChanged(); await gate.started;
    const pending = JSON.stringify([...f.pendingData]);
    let html = '', active: RoomLink | null = null;
    try {
      f.ui.retainActiveRoomAfterScopePreparation(f.ui.activeLink, DOC); openRobotButton(f);
      assert.equal(robotOptions(f).length, 0, 'retention cannot certify a partially read room');
      await f.ui.sendCurrent(); assert.equal(f.sent.length, 0); assert.equal(JSON.stringify([...f.pendingData]), pending);
      gate.restore();
      if (destination === 'document') { f.setDocument(B); await f.ui.documentChanged(); }
      if (destination === 'bridge') bridge = 'replacement';
      html = f.root.innerHTML; active = f.ui.activeLink;
    } finally { gate.restore(); gate.release(); await recovery; }
    if (destination === 'same') {
      assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '恢复中保留正文');
      assert.ok(f.root.querySelector('[data-ekko-reply-preview]')); openRobotButton(f); assert.equal(robotOptions(f).length, 1);
    } else { assert.equal(f.root.innerHTML, html); assert.equal(f.ui.activeLink, active); }
    assert.equal(f.sent.length, 0); assert.equal(JSON.stringify([...f.pendingData]), pending);
  });

for (const stage of ['room', 'sources', 'pending'] as const) for (const timing of ['during', 'after'] as const) for (const navigation of [false, true])
  test(`fix2 ${stage} failure with ${timing} checkbox changes retains trusted choices on ${navigation ? 'stale' : 'same-scene'} retry`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '仅自由正文');
    const change = () => {
      for (const selector of ['[data-ekko-agent]', '[data-ekko-source]']) { const input = f.root.querySelector<HTMLInputElement>(selector)!; input.checked = true; input.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); }
      roomInput(f, '仅自由正文，等待或失败后新增');
    };
    const gate = holdRoomRecovery(f, stage, Error('虚构重试前读取失败')); if (navigation) scene = 'two';
    const recovery = f.ui.refresh(); await gate.started;
    if (timing === 'during') change(); gate.restore(); gate.release(); await recovery;
    if (timing === 'after') change();
    await f.ui.sendCurrent(); assert.equal(f.sent.length, 0);
    await f.ui.refresh();
    assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked, [data-ekko-agent]:checked').length, 0, 'guard-rejected controls cannot become selected via retry');
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '仅自由正文，等待或失败后新增');
    assert.ok(f.root.querySelector('[data-ekko-reply-preview]')); assert.equal(f.sent.length, 0); assert.equal(f.ui.unknownMessageId(), undefined);
  });


for (const navigation of [false, true]) for (const transition of ['leave', 'work', 'document'] as const)
  test(`fix2 ${transition} during ${navigation ? 'stale' : 'same-scene'} failure cannot revive rejected choices on return`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); roomInput(f, '交接前正文');
    const gate = holdRoomRecovery(f, 'pending', Error('虚构交接前核对失败')); if (navigation) scene = 'two'; const recovery = f.ui.refresh(); await gate.started; gate.restore(); gate.release(); await recovery;
    for (const selector of ['[data-ekko-agent]', '[data-ekko-source]']) { const input = f.root.querySelector<HTMLInputElement>(selector)!; input.checked = true; input.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); }
    // The transition itself must collect this latest text without adopting rejected controls.
    f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value = '交接前正文，保留最新自由文字';
    if (transition === 'leave') { f.ui.leave(); await f.ui.enter(); }
    if (transition === 'work') { f.setWork(B); await f.ui.workChanged(); f.setWork(A); await f.ui.workChanged(); await f.ui.openRoom(room.id); }
    if (transition === 'document') { f.setDocument(B); await f.ui.documentChanged(); f.setDocument(DOC); await f.ui.documentChanged(); await f.ui.openRoom(room.id); }
    assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked, [data-ekko-agent]:checked').length, 0);
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '交接前正文，保留最新自由文字');
    assert.ok(f.root.querySelector('[data-ekko-reply-preview]')); assert.equal(f.sent.length, 0);
  });


async function heldAcknowledgement(f: ReturnType<typeof fixture>) {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.setSendGate(new Promise<void>(resolve => { release = resolve; }));
  const send = f.client.send;
  f.client.send = async (...args) => { entered(); return send(...args); };
  const sending = f.ui.sendCurrent();
  await Promise.race([started, sending.then(() => assert.fail('synthetic send must reach the held POST'))]);
  return { release, sending };
}

for (const edited of [false, true]) test(`final ACK same-document refresh ${edited ? 'preserves newly edited text' : 'consumes matching submitted text without revival'}`, async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click(); const input = roomInput(f, '已经提交的原正文'); openRobotButton(f); robotOptions(f)[0].click();
  const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!; source.checked = true; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  const held = await heldAcknowledgement(f); assert.equal(f.sent.length, 1); assert.ok(f.ui.unknownMessageId());
  scene = 'two'; await f.ui.documentChanged(); assert.equal(f.root.querySelector('[data-ekko-composer]'), input);
  if (edited) roomInput(f, '等待确认时新写的正文'); held.release(); await held.sending;
  assert.equal(f.ui.unknownMessageId(), undefined); assert.equal(await f.options.pendingStore.get(f.ui.activeLink!), null);
  const expected = edited ? '等待确认时新写的正文' : '';
  await f.ui.refresh();
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, expected, 'ACKed original text must not be recollected as a new draft');
  assert.equal(f.root.querySelector('[data-ekko-reply-preview]'), null); assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked, [data-ekko-source]:checked').length, 0);
  await f.ui.refresh(); f.ui.leave(); await f.ui.enter();
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, expected); assert.equal(f.sent.length, 1);
});

for (const edited of [false, true]) test(`final ACK original hidden composer ${edited ? 'retains new text' : 'cannot revive sent text'} on leave and reopen`, async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f); roomInput(f, '隐藏前已提交正文');
  const held = await heldAcknowledgement(f); scene = 'two'; await f.ui.documentChanged(); if (edited) roomInput(f, '隐藏前新增正文'); f.ui.leave();
  held.release(); await held.sending; await f.ui.enter(); await f.ui.refresh();
  assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, edited ? '隐藏前新增正文' : ''); assert.equal(f.ui.unknownMessageId(), undefined); assert.equal(f.sent.length, 1);
});

for (const outcome of ['unknown', 'cleanup-failed'] as const) for (const edited of [false, true])
  test(`final ACK ${outcome} keeps original ID and ${edited ? 'new' : 'original'} text through recovery`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f); roomInput(f, '尚待核对的正文');
    if (outcome === 'unknown') f.setSendResult('unknown'); else f.options.pendingStore.clear = async () => { throw Error('虚构未决清理失败'); };
    const held = await heldAcknowledgement(f); const id = f.ui.unknownMessageId(), pending = JSON.stringify([...f.pendingData]); assert.ok(id);
    scene = 'two'; await f.ui.documentChanged(); if (edited) roomInput(f, '未决等待中新写的正文'); held.release(); await held.sending;
    const expected = edited ? '未决等待中新写的正文' : '尚待核对的正文';
    await f.ui.refresh(); f.ui.leave(); await f.ui.enter();
    assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, expected); assert.equal(f.ui.unknownMessageId(), id);
    assert.equal(JSON.stringify([...f.pendingData]), pending); assert.equal(f.sent.length, 1); assert.ok(f.root.querySelector('[data-ekko-action="check-unknown"]:not([hidden])'));
  });

test('final ACK edits during acknowledged pending cleanup survive same-document recovery', async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; await linked(f); roomInput(f, '确认前正文');
  let entered!: () => void, release!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const clear = f.options.pendingStore.clear.bind(f.options.pendingStore); f.options.pendingStore.clear = async (...args) => { entered(); await gate; return clear(...args); };
  const held = await heldAcknowledgement(f); held.release(); await started;
  try { scene = 'two'; await f.ui.documentChanged(); roomInput(f, '清理等待中新写的正文'); assert.ok(f.ui.unknownMessageId()); }
  finally { release(); await held.sending; }
  await f.ui.refresh(); f.ui.leave(); await f.ui.enter(); assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '清理等待中新写的正文'); assert.equal(f.sent.length, 1);
});

for (const change of ['document', 'work', 'Bridge', 'account', 'view', 'room'] as const)
  test(`final ACK late original response cannot consume a changed ${change} composer`, async t => {
    const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one', bridge = 'original'; f.options.getSceneIdentity = () => scene; f.options.getBridgeIdentity = () => bridge;
    await linked(f); roomInput(f, '匹配原提交但属于新场景的正文'); const held = await heldAcknowledgement(f); let current = f.ui;
    if (change === 'document') { f.setDocument(B); await f.ui.documentChanged(); await f.ui.openRoom(room.id); }
    if (change === 'work') { f.setWork(B); await f.ui.workChanged(); await f.ui.linkRoom(room.id); await f.ui.openRoom(room.id); }
    if (change === 'Bridge') { bridge = 'replacement'; scene = 'two'; await f.ui.documentChanged(); }
    if (change === 'account') { f.setConnection({ ...connection, accountUserId: 8 }); f.ui.connectionChanged(); }
    if (change === 'view') { f.ui.dispose(); current = new EkkoRoomUI(f.root, { ...f.options }); t.after(() => current.dispose()); await current.enter(); await current.openRoom(room.id); }
    if (change === 'room') { await f.ui.linkRoom(secondRoom.id); await f.ui.openRoom(secondRoom.id); }
    const input = f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!; input.value = '匹配原提交但属于新场景的正文'; input.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    held.release(); await held.sending;
    assert.equal(f.root.querySelector('[data-ekko-composer]'), input); assert.equal(input.value, '匹配原提交但属于新场景的正文'); assert.equal(f.sent.length, 1);
    if (change === 'Bridge') { await current.refresh(); assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value, '匹配原提交但属于新场景的正文'); }
  });

for (const mode of ['missing', 'removed'] as const) test(`final ACK ${mode} stable Bridge identity cannot certify stale original input`, async t => {
  const f = fixture(); t.after(() => f.ui.dispose()); let scene = 'one'; f.options.getSceneIdentity = () => scene; if (mode === 'missing') f.options.getBridgeIdentity = undefined;
  await linked(f); const input = roomInput(f, '不能猜测仍属原Bridge的正文'); const held = await heldAcknowledgement(f);
  if (mode === 'removed') f.options.getBridgeIdentity = undefined; scene = 'two'; await f.ui.documentChanged(); held.release(); await held.sending;
  assert.equal(f.root.querySelector('[data-ekko-composer]'), input); assert.equal(input.value, '不能猜测仍属原Bridge的正文'); assert.equal(f.ui.unknownMessageId(), undefined); assert.equal(f.sent.length, 1);
});


// Regression: the room menu is a sibling of the form; real focus must not dismiss it.
for (const entry of ['button', 'typed'] as const) for (const choice of ['click', 'Enter', 'Tab'] as const)
  test(`mention focus boundary ${entry} candidate focus then ${choice} selects explicitly`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
    const input = roomInput(f, entry === 'typed' ? '前文 @助 后文' : '前文与后文', entry === 'typed' ? 5 : 2);
    if (entry === 'button') openRobotButton(f);
    const option = robotOptions(f)[0], list = f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!;
    option.focus();
    assert.equal(list.hidden, false, 'own candidate focus keeps the sibling menu open');
    assert.equal(f.dom.window.document.activeElement, option);
    assert.equal(option.isConnected, true);
    assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0, 'focus alone does not choose');
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, 0);
    assert.equal(f.sent.length, 0);
    if (choice === 'click') option.click();
    else {
      const event = new f.dom.window.KeyboardEvent('keydown', { key: choice, bubbles: true, cancelable: true });
      option.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    }
    assert.equal(list.hidden, true);
    assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 1);
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.textContent, '@助手×');
    assert.equal(input.value, entry === 'typed' ? '前文  后文' : '前文与后文');
    assert.equal(input.selectionStart, entry === 'typed' ? 3 : 2);
    assert.equal(f.dom.window.document.activeElement, input);
    assert.equal(f.sent.length, 0, 'explicit choice must not send');
  });


for (const entry of ['button', 'typed'] as const)
  test(`mention focus boundary ${entry} repeat remove reopen dedupes and preserves reply sources until synthetic send`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
    const input = roomInput(f, '虚构正文 ');
    const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
    source.checked = true; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    const reply = f.root.querySelector('[data-ekko-reply-preview]')!.textContent;
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let duplicate = 0; duplicate < 2; duplicate++) {
        if (entry === 'typed') roomInput(f, input.value + '@助'); else openRobotButton(f);
        const option = robotOptions(f)[0]; option.focus(); option.click();
        assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, 1);
        assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 1);
        assert.equal(input.value, '虚构正文 ');
        assert.equal(source.checked, true);
        assert.equal(f.root.querySelector('[data-ekko-reply-preview]')!.textContent, reply);
        assert.equal(f.sent.length, 0);
      }
      if (cycle < 2) {
        f.root.querySelector<HTMLButtonElement>('[data-ekko-remove-agent]')!.click();
        assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, 0);
        assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0);
      }
    }
    await f.ui.sendCurrent();
    assert.equal(f.sent.length, 1);
    assert.deepEqual(f.sent[0].payload.mentions, [{ type: 'agent', participantId: 'agent-one', displayName: '助手' }]);
    assert.match(f.sent[0].payload.content, /^@助手 虚构正文/);
    assert.match(f.sent[0].payload.content, /<quoted_message>/);
    assert.match(f.sent[0].payload.content, /只在勾选时发送/);
  });

for (const destination of ['outside', 'panel-control', 'null', 'other-form', 'other-list'] as const)
  test(`mention focus boundary closes on ${destination} without choosing`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
    const doc = f.dom.window.document;
    let target: HTMLElement | undefined;
    if (destination.startsWith('other-')) {
      const holder = doc.createElement('div'); holder.innerHTML = createChatShell(); doc.body.append(holder);
      const root = holder.querySelector<HTMLElement>('.sac')!;
      const other = new EkkoRoomUI(root, { ...f.options }); t.after(() => other.dispose());
      await other.enter(); await other.openRoom(room.id);
      if (destination === 'other-form') target = root.querySelector<HTMLElement>('[data-ekko-composer]')!;
      else {
        // A second panel's own menu remains outside the first panel's focus boundary.
        const list = root.querySelector<HTMLElement>('[data-ekko-mention-list]')!;
        list.hidden = false; target = doc.createElement('button'); list.append(target);
      }
    } else if (destination === 'outside') {
      target = doc.createElement('button'); doc.body.append(target);
    } else if (destination === 'panel-control') {
      target = f.root.querySelector<HTMLElement>('[data-ekko-messages]')!; target.tabIndex = 0;
    }
    const input = roomInput(f, '草稿 @助'); const option = robotOptions(f)[0]; option.focus();
    const list = f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!;
    assert.equal(list.hidden, false);
    if (destination === 'null') option.blur(); else target!.focus();
    assert.equal(list.hidden, true);
    assert.equal(robotOptions(f).length, 0);
    option.click();
    assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0);
    assert.equal(input.value, '草稿 @助'); assert.equal(f.sent.length, 0);
  });

for (const change of ['scene', 'text', 'caret', 'document', 'work', 'view', 'bridge', 'member'] as const)
  for (const choice of ['click', 'Enter', 'Tab'] as const)
    test(`mention focus boundary focused candidate rejects stale ${change} on ${choice}`, async t => {
      const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
      let scene = 'one', current = true, bridge = 'fictional-bridge-one';
      f.options.getSceneIdentity = () => scene; f.options.isCurrent = () => current; f.options.getBridgeIdentity = () => bridge;
      await linked(f); const input = roomInput(f, '前文 @助 后文', 5); const option = robotOptions(f)[0]; option.focus();
      assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!.hidden, false);
      if (change === 'scene') scene = 'two';
      if (change === 'text') input.value = '最新虚构草稿';
      if (change === 'caret') input.setSelectionRange(1, 1);
      if (change === 'document') f.setDocument(B);
      if (change === 'work') f.setWork(B);
      if (change === 'view') current = false;
      if (change === 'bridge') bridge = 'fictional-bridge-two';
      if (change === 'member') {
        f.client.room = async () => ({ room, messages: [], agents: [], hasMore: false });
        const state = f.ui as any; await state.reloadHistory(state.active, state.version);
      }
      if (choice === 'click') option.click();
      else option.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: choice, bubbles: true, cancelable: true }));
      assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0);
      assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, 0);
      assert.equal(input.value, change === 'text' ? '最新虚构草稿' : '前文 @助 后文');
      assert.equal(input.selectionStart, change === 'caret' ? 1 : change === 'text' ? input.value.length : 5);
      assert.equal(f.sent.length, 0);
    });


for (const entry of ['button', 'typed'] as const) for (const confirm of ['Enter', 'Tab'] as const)
  for (const navigation of ['none', 'ArrowUp', 'ArrowDown'] as const)
    test(`mention focused identity ${entry} second option ${navigation} then ${confirm} addresses indicated agent`, async t => {
      const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
      f.client.room = async () => ({ room, messages: [], agents: [
        { roomId: room.id, agentId: 'first-agent', name: '首位助手' },
        { roomId: room.id, agentId: 'second-agent', name: '次位助手' },
      ], hasMore: false });
      await linked(f); const input = roomInput(f, entry === 'typed' ? '虚构请求 @' : '虚构请求 ');
      if (entry === 'button') openRobotButton(f);
      const options = robotOptions(f); assert.equal(options.length, 2); options[1].focus();
      assert.equal(f.dom.window.document.activeElement, options[1]);
      assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0, 'focus alone remains inert');
      assert.equal(f.sent.length, 0);
      const pressFocused = (key: string) => {
        const active = f.dom.window.document.activeElement!;
        assert.ok(active.matches('[data-ekko-mention-option]'), 'keyboard continuation retains a real option focus');
        const event = new f.dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        active.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
      };
      if (navigation !== 'none') {
        pressFocused(navigation);
        assert.equal(f.dom.window.document.activeElement, robotOptions(f)[0], 'first arrow moves from second to first, including wrap');
        assert.equal(robotOptions(f)[0].getAttribute('aria-selected'), 'true');
        assert.equal(input.getAttribute('aria-activedescendant'), robotOptions(f)[0].id);
        assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0);
        pressFocused(navigation);
        assert.equal(f.dom.window.document.activeElement, robotOptions(f)[1], 'second arrow returns to second option');
        assert.equal(robotOptions(f)[1].getAttribute('aria-selected'), 'true');
        assert.equal(input.getAttribute('aria-activedescendant'), robotOptions(f)[1].id);
      }
      pressFocused(confirm);
      assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.textContent, '@次位助手×');
      assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 1);
      assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-agent][value="second-agent"]')!.checked, true);
      assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-agent][value="first-agent"]')!.checked, false);
      assert.equal(input.value, '虚构请求 '); assert.equal(f.sent.length, 0);
      await f.ui.sendCurrent(); assert.equal(f.sent.length, 1);
      assert.deepEqual(f.sent[0].payload.mentions, [{ type: 'agent', participantId: 'second-agent', displayName: '次位助手' }]);
      assert.equal(f.sent[0].payload.content, '@次位助手 虚构请求 ');
    });


// Explicit Escape returns editing focus only while the original picker is current.
for (const entry of ['button', 'typed'] as const) for (const selected of [false, true])
  test(`mention Escape continuation ${entry} preserves ${selected ? 'chosen' : 'unchosen'} tags and draft state`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
    f.root.querySelector<HTMLButtonElement>('[data-ekko-action="reply"]')!.click();
    if (selected) { roomInput(f, 'draft'); openRobotButton(f); robotOptions(f)[0].click(); }
    const source = f.root.querySelector<HTMLInputElement>('[data-ekko-source]')!;
    source.checked = true; source.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    const reply = f.root.querySelector('[data-ekko-reply-preview]')!.textContent;
    const input = roomInput(f, entry === 'typed' ? 'draft @' : 'draft text');
    if (entry === 'button') { input.setSelectionRange(2, 5); openRobotButton(f); }
    const before = { value: input.value, start: input.selectionStart, end: input.selectionEnd };
    const option = robotOptions(f)[0]; option.focus();
    assert.equal(f.dom.window.document.activeElement, option);
    const escape = new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    option.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(f.dom.window.document.activeElement, input, 'Escape restores the original current composer for keyboard continuation');
    assert.deepEqual({ value: input.value, start: input.selectionStart, end: input.selectionEnd }, before);
    assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!.hidden, true);
    assert.equal(robotOptions(f).length, 0);
    assert.equal(input.getAttribute('aria-expanded'), 'false');
    assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, selected ? 1 : 0);
    assert.equal(f.root.querySelector('[data-ekko-selected-agents]')!.childElementCount, selected ? 1 : 0);
    assert.equal(source.checked, true);
    assert.equal(f.root.querySelector('[data-ekko-reply-preview]')!.textContent, reply);
    assert.equal(f.sent.length, 0, 'Escape neither chooses nor sends');
  });

for (const change of ['scene', 'document', 'work', 'view', 'bridge', 'text', 'caret', 'connection'] as const)
  test(`mention Escape continuation rejects stale ${change} without reclaiming composer focus`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); });
    let scene = 'one', current = true, bridge = 'fictional-bridge-one';
    f.options.getSceneIdentity = () => scene; f.options.isCurrent = () => current; f.options.getBridgeIdentity = () => bridge;
    await linked(f); const input = roomInput(f, 'draft @'); const option = robotOptions(f)[0]; option.focus();
    if (change === 'scene') scene = 'two';
    if (change === 'document') f.setDocument(B);
    if (change === 'work') f.setWork(B);
    if (change === 'view') current = false;
    if (change === 'bridge') bridge = 'fictional-bridge-two';
    if (change === 'text') input.value = 'new draft';
    if (change === 'caret') input.setSelectionRange(1, 1);
    if (change === 'connection') { f.setConnection({ ...connection, accountUserId: 8 }); f.ui.connectionChanged(); }
    option.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.notEqual(f.dom.window.document.activeElement, input, 'invalidated cancellation must not focus the old composer');
    assert.notEqual(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')?.hidden, false);
    assert.equal(f.root.querySelectorAll('[data-ekko-agent]:checked').length, 0);
    assert.equal(input.value, change === 'text' ? 'new draft' : 'draft @');
    assert.equal(f.sent.length, 0);
  });

for (const destination of ['outside', 'other-composer', 'null'] as const)
  test(`mention Escape continuation generic ${destination} close never steals focus`, async t => {
    const f = fixture(); t.after(() => { f.ui.dispose(); f.dom.window.close(); }); await linked(f);
    const doc = f.dom.window.document;
    const target = doc.createElement(destination === 'other-composer' ? 'textarea' : 'button'); doc.body.append(target);
    if (destination === 'other-composer') target.setAttribute('data-ekko-composer', '');
    const input = roomInput(f, 'draft @'); const option = robotOptions(f)[0]; option.focus();
    if (destination === 'null') option.blur(); else target.focus();
    assert.equal(f.root.querySelector<HTMLElement>('[data-ekko-mention-list]')!.hidden, true);
    assert.equal(doc.activeElement, destination === 'null' ? doc.body : target);
    option.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.equal(doc.activeElement, destination === 'null' ? doc.body : target);
    assert.equal(input.value, 'draft @'); assert.equal(f.sent.length, 0);
  });

test('explicit knowledge reference preserves room draft and agents, survives source refresh, and never sends',async()=>{
 const f=fixture();try{await linked(f);const textarea=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;textarea.value='保留消息';textarea.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  const agent=f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!;agent.checked=true;agent.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));
  const option={label:'虚构检索片段',source:{kind:'selection' as const,documentId:DOC,blockId:A,selectedText:'精确正文',originalBlock:'精确正文'}};
  await (f.ui as any).addReferenceSource(option,()=>true);await (f.ui as any).addReferenceSource(option,()=>true);
  assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked').length,1);assert.equal(textarea.value,'保留消息');assert.equal(f.root.querySelector<HTMLInputElement>('[data-ekko-agent]')!.checked,true);assert.equal(f.sent.length,0);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="refresh-sources"]')!.click();await tick();await tick();
  assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked').length,1);assert.equal(f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!.value,'保留消息');
 }finally{f.ui.dispose();f.dom.window.close();}
});
for(const mode of ['foreign-source','stale','unknown'] as const)test('knowledge reference refuses '+mode+' without changing room selections',async()=>{
 const f=fixture();try{await linked(f);if(mode==='unknown')(f.ui as any).draft().unknownId='pending-original';
  const option={label:'虚构检索',source:{kind:'selection' as const,documentId:mode==='foreign-source'?B:DOC,blockId:A,selectedText:'精确正文',originalBlock:'精确正文'}};
  await assert.rejects((f.ui as any).addReferenceSource(option,()=>mode!=='stale'));assert.equal(f.root.querySelectorAll('[data-ekko-source]:checked').length,0);assert.equal(f.sent.length,0);
 }finally{f.ui.dispose();f.dom.window.close();}
});


test('ordinary room answer workflow freezes exact verified reply and expires on same-ID edits', async () => {
 const f=fixture();const calls:any[]=[];(f.options as any).onAnswerAction=async(action:any,source:any,current:any)=>{calls.push({action,source,current});};
 f.history[room.id]=[{...message('answer-one','完成回答'),senderId:'agent-one',role:'assistant',preservesStreamingFlagPresence:true} as any];
 try{await linked(f);const compose=f.root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;compose.value='保留草稿';compose.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));
  const adopt=f.root.querySelector<HTMLButtonElement>('[data-ekko-action="adopt-answer"]');assert.ok(adopt);adopt.click();await tick();assert.equal(calls.length,1);assert.equal(calls[0].action,'adopt');assert.equal(calls[0].source.messageId,'answer-one');assert.equal(calls[0].source.content,'完成回答');assert.equal(calls[0].source.documentId,DOC);assert.equal(calls[0].source.link.roomId,room.id);assert.equal(calls[0].current(),true);
  f.root.querySelector<HTMLButtonElement>('[data-ekko-action="draft-answer"]')!.click();await tick();assert.equal(calls[1].action,'task-draft');assert.equal(f.sent.length,0);assert.equal(compose.value,'保留草稿');
  f.emitEvent(room.id,{event:'room.message',data:{...f.history[room.id][0],content:'同一消息修订'}});await tick();assert.equal(calls[0].current(),false);assert.equal(calls[1].current(),false);
 }finally{f.ui.dispose();f.dom.window.close();}
});
test('ordinary room answer workflow excludes user tool stranger streaming invalid flags and unproven omitted flags', async()=>{
 const variants=[{role:'user'},{role:'tool'},{senderId:'unknown'},{senderId:'auth:7'},{isStreaming:true},{isStreaming:null},{isStreaming:{}},{preservesStreamingFlagPresence:undefined}];
 for(const variant of variants){const f=fixture();(f.options as any).onAnswerAction=async()=>{assert.fail('ineligible callback');};f.history[room.id]=[{...message('answer-one','完整文字'),senderId:'agent-one',role:'assistant',preservesStreamingFlagPresence:true,...variant} as any];try{await linked(f);assert.equal(f.root.querySelector('[data-ekko-action="adopt-answer"], [data-ekko-action="draft-answer"]'),null,JSON.stringify(variant));}finally{f.ui.dispose();f.dom.window.close();}}
});
test('ordinary room answer workflow rejects changed room ownership and unavailable legacy capability', async()=>{
 const f=fixture();let current:(()=>boolean)|undefined;(f.options as any).onAnswerAction=async(_a:any,_s:any,guard:any)=>{current=guard;};f.history[room.id]=[{...message('answer-one','普通回答'),senderId:'agent-one',role:'assistant',isStreaming:false} as any];
 try{await linked(f);f.root.querySelector<HTMLButtonElement>('[data-ekko-action="adopt-answer"]')!.click();await tick();assert.equal(current?.(),true);f.setDocument(B);assert.equal(current?.(),false);assert.equal(f.sent.length,0);}finally{f.ui.dispose();f.dom.window.close();}
});
