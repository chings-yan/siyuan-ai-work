import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WorkController } from '../src/work/controller.ts';
import { WorkService, type WorkHost } from '../src/work/service.ts';
import { WorkStore } from '../src/work/store.ts';
import type { TaskView } from '../src/task/reader.ts';

const documentId = '20260927120000-abcdef0';
const otherWorkId = '20260927120001-abcdef0';
const openTask: TaskView = { id: 'task-open', title: '继续整理方案', completed: false, documentId: null, projectId: null, createdAt: '2026-09-27T10:00:00Z' };

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('界面未进入预期状态');
}

function fixture(taskResult: { kind: 'found'; value: TaskView[] } | { kind: 'unavailable'; reason: string }, lookup = async (_id: string) => ({ kind: 'found', value: openTask } as const)) {
  const dom = new JSDOM('<!doctype html><html><body><div id="dock"><div class="sac-header"></div></div></body></html>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  dom.window.prompt = () => null;
  dom.window.confirm = () => true;
  const root = dom.window.document.querySelector<HTMLElement>('#dock')!;
  const attrs = new Map<string, Record<string, string>>();
  const children = new Map<string, string[]>();
  const markdown = new Map<string, string>();
  const disk = new Map<string, unknown>();
  let nextBlock = 0;
  let activeDocumentId = documentId;
  const host: WorkHost & { listDescendantDocuments: (id: string) => Promise<string[]>; getDocumentRoot: (id: string) => Promise<string> } = {
    getAttrs: async id => attrs.get(id) || {},
    setAttrs: async (id, value) => { attrs.set(id, { ...(attrs.get(id) || {}), ...value }); },
    getChildren: async id => children.get(id) || [],
    getBlockMarkdown: async id => markdown.get(id) || '',
    appendMarkdown: async (id, text) => {
      const blockId = `block-${++nextBlock}`;
      children.set(id, [...(children.get(id) || []), blockId]);
      markdown.set(blockId, text);
      const role = text.match(/custom-ai-work-role="([^"]+)"/)?.[1];
      attrs.set(blockId, role ? { 'custom-ai-work-role': role } : {});
    },
    prependMarkdown: async (id, text) => {
      const blockId = `block-${++nextBlock}`;
      children.set(id, [blockId, ...(children.get(id) || [])]);
      markdown.set(blockId, text);
      attrs.set(blockId, { 'custom-ai-work-role': 'goal' });
    },
    getDocumentPath: async id => `/${id}.sy`,
    getDocumentTitle: async id => id === documentId ? '测试文档' : '其他 Work',
    listDescendantDocuments: async () => [],
    getDocumentRoot: async id => id,
  };
  const store = new WorkStore({ loadData: async key => disk.get(key), saveData: async (key, value) => { disk.set(key, structuredClone(value)); } });
  const service = new WorkService(host, store);
  const statuses: string[] = [];
  const opened: string[] = [];
  const taskReader = { listRecent: async () => taskResult, getTask: lookup };
  const controller = new WorkController({ host: host as any, store, service, taskReader: taskReader as any,
    currentDocumentId: () => activeDocumentId, currentFocusBlockId: () => null, currentChatId: () => null,
    isBusy: () => false, hasPendingWrite: () => false, openDocument: id => { opened.push(id); }, onWorkChanged: async () => {}, onLinkCurrentChat: async () => {}, status: message => { statuses.push(message); },
  });
  controller.attach(root);
  return { dom, root, attrs, host, store, controller, statuses, opened, setActiveDocument: (id: string) => { activeDocumentId = id; } };
}

test('从主页进入未关联任务只打开任务文档，不弹窗或建立关系', async () => {
  const task = { ...openTask, documentId: otherWorkId };
  const f = fixture({ kind: 'found', value: [task] }, async () => ({ kind: 'found', value: task } as const));
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="create"]')));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="create"]')!.click();
  await waitFor(() => Boolean(f.root.querySelector('[data-work-goal]')));
  const goal = f.root.querySelector<HTMLTextAreaElement>('[data-work-goal]')!;
  goal.value = '整理方案'; goal.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="confirm-create"]')!.click();
  await waitFor(() => f.controller.currentWorkId === documentId);
  f.root.querySelector<HTMLButtonElement>('[data-work-action="home"]')!.click();
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="task"]')));
  let confirms=0;f.dom.window.confirm = () => {confirms++;return true;};
  f.root.querySelector<HTMLButtonElement>('[data-work-action="task"]')!.click();
  await waitFor(() => f.opened.includes(otherWorkId));
  await f.controller.flushResume();
  assert.equal(confirms,0);
  assert.equal(f.controller.currentTask, null);
  assert.deepEqual(await f.store.listTasks(documentId), []);
  assert.equal((await f.store.getResume(documentId))?.taskId ?? null, null);
  assert.match(f.root.querySelector('[data-task-current]')?.textContent || '', /未关联任务/);
  assert.ok(f.statuses.some(message => /未关联 Work/.test(message)));
  f.dom.window.close();
});

test('任务接口失联时仍可明确选择不关联任务并建立 Work', async () => {
  const f = fixture({ kind: 'unavailable', reason: 'offline' });
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="create"]')));
  assert.match(f.root.querySelector('[data-work-current]')?.textContent || '', /Work.*未选择/);
  assert.match(f.root.querySelector('[data-task-current]')?.textContent || '', /任务.*可选.*未关联/);
  assert.match(f.root.querySelector('[data-chat-current]')?.textContent || '', /对话.*未选择/);
  f.root.querySelector<HTMLButtonElement>('[data-work-action="create"]')!.click();
  await waitFor(() => Boolean(f.root.querySelector('[data-work-goal]')));
  assert.match(f.root.textContent || '', /任务可选/);
  assert.match(f.root.textContent || '', /最近任务.*offline/);
  assert.equal(f.root.querySelector<HTMLSelectElement>('[data-work-task]')?.value, '');
  const goal = f.root.querySelector<HTMLTextAreaElement>('[data-work-goal]')!;
  goal.value = '整理下一版方案'; goal.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="confirm-create"]')!.click();
  await waitFor(() => f.controller.currentWorkId === documentId);
  assert.deepEqual(await f.store.listTasks(documentId), []);
  assert.equal((await f.store.getResume(documentId))?.taskId ?? null, null);
  assert.match(f.root.querySelector('[data-work-current]')?.textContent || '', /Work.*测试文档/);
  assert.match(f.root.querySelector('[data-task-current]')?.textContent || '', /未关联任务/);
  f.dom.window.close();
});

test('选中最近未完成任务后，建立 Work 并保存正式关联和当前任务', async () => {
  let checked = 0;
  const f = fixture({ kind: 'found', value: [openTask] }, async id => { checked++; assert.equal(id, openTask.id); return { kind: 'found', value: openTask } as const; });
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="create"]')));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="create"]')!.click();
  await waitFor(() => Boolean(f.root.querySelector('[data-work-task] option[value="task-open"]')));
  const goal = f.root.querySelector<HTMLTextAreaElement>('[data-work-goal]')!;
  goal.value = '推进方案'; goal.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  const task = f.root.querySelector<HTMLSelectElement>('[data-work-task]')!;
  task.value = openTask.id; task.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="confirm-create"]')!.click();
  await waitFor(() => f.controller.currentTask === openTask.id);
  await waitFor(() => (f.root.querySelector('[data-task-current]')?.textContent || '').includes('继续整理方案'));
  assert.ok(checked >= 1);
  assert.deepEqual(await f.store.listTasks(documentId), [{ taskId: openTask.id, workId: documentId, connectionId: 'siyuan-native-local' }]);
  await f.controller.flushResume();
  assert.equal((await f.store.getResume(documentId))?.taskId, openTask.id);
  f.dom.window.close();
});

test('推荐任务核对为已完成时，拒绝创建 Work 且不改原文档', async () => {
  const f = fixture({ kind: 'found', value: [openTask] }, async () => ({ kind: 'found', value: { ...openTask, completed: true } } as const));
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="create"]')));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="create"]')!.click();
  await waitFor(() => Boolean(f.root.querySelector('[data-work-task] option[value="task-open"]')));
  const goal = f.root.querySelector<HTMLTextAreaElement>('[data-work-goal]')!;
  goal.value = '推进方案'; goal.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  const task = f.root.querySelector<HTMLSelectElement>('[data-work-task]')!;
  task.value = openTask.id; task.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="confirm-create"]')!.click();
  await waitFor(() => f.statuses.some(message => /已完成/.test(message)));
  assert.equal(f.controller.currentWorkId, null);
  assert.equal(f.attrs.has(documentId), false);
  assert.deepEqual(await f.store.listWorks(), []);
  f.dom.window.close();
});

test('任务已有其他主 Work 时，拒绝把它关联到新文档', async () => {
  const f = fixture({ kind: 'found', value: [openTask] });
  await f.store.registerWork(otherWorkId);
  await f.store.linkTask({ taskId: openTask.id, workId: otherWorkId, connectionId: 'siyuan-native-local' });
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="create"]')));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="create"]')!.click();
  await waitFor(() => Boolean(f.root.querySelector('[data-work-task] option[value="task-open"]')));
  const goal = f.root.querySelector<HTMLTextAreaElement>('[data-work-goal]')!;
  goal.value = '推进方案'; goal.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  const task = f.root.querySelector<HTMLSelectElement>('[data-work-task]')!;
  task.value = openTask.id; task.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="confirm-create"]')!.click();
  await waitFor(() => f.statuses.some(message => /其他 Work/.test(message)));
  assert.equal(f.attrs.has(documentId), false);
  assert.deepEqual(await f.store.listWorks(), [otherWorkId]);
  f.dom.window.close();
});

test('取消任务选择后，迟到的标题读取不能重画旧创建表单', async () => {
  const f = fixture({ kind: 'found', value: [openTask] });
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="create"]')));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="create"]')!.click();
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="cancel-create"]')));
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.host.getDocumentTitle = async () => { entered(); await gate; return '测试文档'; };
  const stale = (f.controller as any).renderAll() as Promise<void>;
  stale.catch(() => {});
  await started;
  f.root.querySelector<HTMLButtonElement>('[data-work-action="cancel-create"]')!.click();
  await waitFor(() => !f.root.querySelector('[data-work-goal]'));
  release();
  await assert.doesNotReject(stale);
  assert.equal(f.root.querySelector('[data-work-goal]'), null);
  f.dom.window.close();
});

test('确认建立 Work 后切换文档，迟到的创建结果不抢回旧 Work', async () => {
  const f = fixture({ kind: 'unavailable', reason: 'offline' });
  await waitFor(() => Boolean(f.root.querySelector('[data-work-action="create"]')));
  f.root.querySelector<HTMLButtonElement>('[data-work-action="create"]')!.click();
  await waitFor(() => Boolean(f.root.querySelector('[data-work-goal]')));
  const goal = f.root.querySelector<HTMLTextAreaElement>('[data-work-goal]')!;
  goal.value = '推进方案'; goal.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
  const prepend = f.host.prependMarkdown;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.host.prependMarkdown = async (id, text) => { entered(); await gate; await prepend(id, text); };
  f.root.querySelector<HTMLButtonElement>('[data-work-action="confirm-create"]')!.click();
  await started;
  f.setActiveDocument(otherWorkId);
  await f.controller.refreshDocument(otherWorkId);
  release();
  await waitFor(() => f.attrs.get(documentId)?.['custom-ai-work-v0'] === '1');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.controller.currentDocumentId, otherWorkId);
  assert.equal(f.controller.currentWorkId, null);
  f.dom.window.close();
});

for (const documentTarget of [null, otherWorkId]) test(`manual association rechecks exact task and leaves navigation/chat intact (${documentTarget})`, async () => {
  const selected = { ...openTask, documentId: documentTarget };
  let reads = 0;
  const f = fixture({ kind: 'found', value: [selected] }, async id => { reads++; assert.equal(id, selected.id); return { kind: 'found', value: selected }; });
  try {
    await f.store.registerWork(documentId);
    await (f.controller as any).options.service.createFromDocument({ documentId, goal: '', approved: true });
    const controller = f.controller as any;
    assert.equal(typeof controller.linkSelectedTask, 'function', 'manual task association must have a guarded entry');
    const version = f.controller.navigationVersion;
    await controller.linkSelectedTask(documentId, selected, () => true);
    assert.equal(reads, 2, 'commit must read exact task before queuing and at the queued write');
    assert.deepEqual(await f.store.listTasks(documentId), [{ taskId: selected.id, workId: documentId, connectionId: 'siyuan-native-local' }]);
    assert.equal(f.controller.navigationVersion, version);
    assert.equal(f.controller.currentWorkId, null);
    assert.equal(f.controller.currentTask, null);
    assert.deepEqual(f.opened, []);
  } finally { f.controller.detach(); f.dom.window.close(); }
});

for (const change of ['title', 'documentId', 'projectId', 'completed', 'wrong-id', 'missing', 'unavailable', 'work', 'guard', 'owner']) test(`manual association refuses changed ${change} before formal save`, async () => {
  let current = true;
  const selected = { ...openTask, documentId: otherWorkId };
  const f = fixture({ kind: 'found', value: [selected] }, async () => {
    if (change === 'guard') current = false;
    if (change === 'work') f.attrs.delete(documentId);
    if (change === 'missing') return { kind: 'missing' } as any;
    if (change === 'unavailable') return { kind: 'unavailable', reason: 'fictional offline' } as any;
    const value = change === 'wrong-id' ? { ...selected, id: 'another-task' } : change === 'completed' ? { ...selected, completed: true } : ['title', 'documentId', 'projectId'].includes(change) ? { ...selected, [change]: 'changed' } : selected;
    return { kind: 'found', value };
  });
  try {
    await (f.controller as any).options.service.createFromDocument({ documentId, goal: '', approved: true });
    if (change === 'owner') { await f.store.registerWork(otherWorkId); await f.store.linkTask({ taskId: selected.id, workId: otherWorkId, connectionId: 'siyuan-native-local' }); }
    const controller = f.controller as any;
    assert.equal(typeof controller.linkSelectedTask, 'function', 'manual task association must have a guarded entry');
    await assert.rejects(controller.linkSelectedTask(documentId, selected, () => current), /任务|Work|页面|变化|核对/);
    assert.deepEqual(await f.store.listTasks(documentId), []);
    assert.deepEqual(f.opened, []);
  } finally { f.controller.detach(); f.dom.window.close(); }
});

test('manual association freezes the confirmed task while its exact reread is pending', async () => {
  let release!:(value:any)=>void;
  const selected = { ...openTask, documentId: otherWorkId };
  const f = fixture({ kind: 'found', value: [selected] }, async () => new Promise(resolve => { release=resolve; }));
  try {
    await (f.controller as any).options.service.createFromDocument({ documentId, goal: '', approved: true });
    const pending=(f.controller as any).linkSelectedTask(documentId, selected, () => true);
    await waitFor(()=>typeof release==='function');
    selected.documentId=documentId;
    release({kind:'found',value:{...openTask,documentId:documentId}});
    await assert.rejects(pending,/变化|核对/);
    assert.deepEqual(await f.store.listTasks(documentId),[]);
  } finally { f.controller.detach(); f.dom.window.close(); }
});

for (const change of ['page', 'navigation', 'work']) test(`queued manual association refuses stale ${change} before formal write`, async () => {
  const selected={...openTask,documentId:otherWorkId};
  const f=fixture({kind:'found',value:[selected]},async()=>({kind:'found',value:selected}));
  let release!:()=>void;
  try {
    await (f.controller as any).options.service.createFromDocument({documentId,goal:'',approved:true});
    const storage=(f.store as any).storage,save=storage.saveData.bind(storage);
    let resumeStarted!:()=>void;const started=new Promise<void>(resolve=>resumeStarted=resolve),gate=new Promise<void>(resolve=>release=resolve);
    storage.saveData=async(key:string,value:unknown)=>{if(key==='work-resume-v1'){resumeStarted();await gate;}return save(key,value);};
    const blocked=f.store.saveResume({workId:documentId,documentId,focusBlockId:null,chatId:'fictional-chat',taskId:null,updatedAt:'2026-10-08T12:00:00Z'});
    await started;
    let enqueued!:()=>void;const reachedQueue=new Promise<void>(resolve=>enqueued=resolve),link=f.store.linkTask.bind(f.store);
    f.store.linkTask=(...args:Parameters<WorkStore['linkTask']>)=>{const pending=link(...args);enqueued();return pending;};
    let current=true;const navigation=f.controller.navigationVersion;
    const pending=f.controller.linkSelectedTask(documentId,selected,()=>current&&navigation===f.controller.navigationVersion);
    await reachedQueue;
    const rejected=assert.rejects(pending,/页面|Work|变化|核对|标记/);
    if(change==='page')current=false;
    else if(change==='navigation')(f.controller as any).navigationSequence++;
    else f.attrs.delete(documentId);
    release();await blocked;await rejected;
    assert.deepEqual(await f.store.listTasks(documentId),[],'queue recovery must not persist a stale task relation');
    assert.deepEqual(f.opened,[]);
  } finally {release?.();f.controller.detach();f.dom.window.close();}
});

for (const change of ['completed', 'title', 'documentId', 'projectId']) test(`queued manual association rereads changed task ${change} before formal write`, async () => {
  const selected={...openTask,documentId:otherWorkId,projectId:'fictional-project'};
  let actual={...selected},reads=0;
  const f=fixture({kind:'found',value:[selected]},async id=>{assert.equal(id,selected.id);reads++;return {kind:'found',value:{...actual}};});
  let release!:()=>void;
  try {
    await (f.controller as any).options.service.createFromDocument({documentId,goal:'',approved:true});
    const storage=(f.store as any).storage,save=storage.saveData.bind(storage);
    let resumeStarted!:()=>void;const started=new Promise<void>(resolve=>resumeStarted=resolve),gate=new Promise<void>(resolve=>release=resolve);
    storage.saveData=async(key:string,value:unknown)=>{if(key==='work-resume-v1'){resumeStarted();await gate;}return save(key,value);};
    const blocked=f.store.saveResume({workId:documentId,documentId,focusBlockId:null,chatId:'fictional-chat',taskId:null,updatedAt:'2026-10-08T12:00:00Z'});
    await started;
    let enqueued!:()=>void;const reachedQueue=new Promise<void>(resolve=>enqueued=resolve),link=f.store.linkTask.bind(f.store);
    f.store.linkTask=(...args:Parameters<WorkStore['linkTask']>)=>{const pending=link(...args);enqueued();return pending;};
    const pending=f.controller.linkSelectedTask(documentId,selected,()=>true);
    await reachedQueue;assert.equal(reads,1,'initial confirmation happens before queue recovery');
    const rejected=assert.rejects(pending,/任务.*完成|任务.*变化|重新.*核对/);
    actual=change==='completed'?{...actual,completed:true}:{...actual,[change]:'changed'};
    release();await blocked;await rejected;
    assert.equal(reads,2,'the queue must read the exact selected task again at execution');
    assert.deepEqual(await f.store.listTasks(documentId),[],'changed tasks must not receive a formal relation');
    assert.deepEqual(f.opened,[]);
  } finally {release?.();f.controller.detach();f.dom.window.close();}
});
