import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { ReplySyncController, type ReplySnapshot } from '../src/work/reply-sync.ts';
import { ReplySyncPanel } from '../src/work/reply-sync-panel.ts';
import type { ChatLink } from '../src/work/store.ts';

const link: ChatLink = {
  chatId: 'synthetic-chat', workId: null, documentRootId: '20990101000000-aaaaaaa',
  connectionId: 'studio-default', adapter: 'studio', profile: 'default', installId: null,
  storedSessionId: 'synthetic-session', title: '虚构原会话', state: 'ready',
};
function fixture(options: { title?: string; legacy?: boolean; open?: (target: ChatLink) => Promise<void>; isCurrent?: () => boolean } = {}) {
  const dom = new JSDOM('<main class="sac"><textarea>保留原草稿和选区</textarea><details data-reply-activity><summary>回复动态</summary><section class="sac-activity-tray"><div data-existing-activity>本次观察记录仍保留</div></section></details></main>', { pretendToBeVisual: true });
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  const container = root.querySelector<HTMLElement>('.sac-activity-tray')!;
  const target: ChatLink = { ...link, title: options.title ?? link.title, ...(options.legacy ? { adapter: 'legacy-api' as const } : {}) };
  const values = new Map<string, unknown>(), opened: ChatLink[] = [];
  let reads = 0;
  let messages: ReplySnapshot['messages'] = [{ id: 'answer-a', role: 'assistant', content: '虚构答复' }];
  const controller = new ReplySyncController({
    storage: { loadData: key => structuredClone(values.get(key)), saveData: (key, value) => { values.set(key, structuredClone(value)); } },
    captureSource: async () => ({ namespace: 'synthetic-bridge', isCurrent: options.isCurrent ?? (() => true) }),
    listTargets: async () => ({ links: [target], unresolvedCount: 0 }),
    isTargetCurrent: candidate => candidate.chatId === target.chatId,
    readSnapshot: async candidate => { reads++; return { schemaVersion: 1, complete: true, completeness: 'display-history', consistency: 'two-complete-reads-match',
      source: { chatId: candidate.chatId, documentRootId: candidate.documentRootId, connectionId: candidate.connectionId,
        kind: 'studio', profile: candidate.profile, storedSessionId: candidate.storedSessionId!, installId: candidate.installId }, messages: structuredClone(messages) }; },
  });
  const openTarget = async (candidate: ChatLink) => { opened.push(structuredClone(candidate)); await options.open?.(candidate); };
  const panel = new ReplySyncPanel(container, { controller, openTarget });
  const button = (name: string, inElement: ParentNode = container) => inElement.querySelector<HTMLButtonElement>(`[data-reply-sync-action="${name}"]`)!;
  return { dom, root, container, target, controller, panel, values, opened, openTarget, button, reads: () => reads,
    setMessages: (items: ReplySnapshot['messages']) => { messages = items; },
    close: () => { panel.dispose(); controller.dispose(); dom.window.close(); } };
}

function waitForRead(controller: ReplySyncController): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('The explicit acknowledgement did not complete')); }, 1000);
    const unsubscribe = controller.subscribe(() => {
      if (controller.view().rows[0]?.status !== 'read') return;
      clearTimeout(timer); unsubscribe(); resolve();
    });
  });
}

test('linked reply checks are a collapsed child of the existing activity tray and start without polling', async () => {
  const f = fixture();
  try {
    const details = f.container.querySelector<HTMLDetailsElement>('[data-reply-sync]')!;
    assert.equal(details.tagName, 'DETAILS'); assert.equal(details.open, false);
    assert.equal(details.parentElement, f.container);
    assert.equal(details.querySelector('summary')?.textContent, '已关联会话');
    assert.match(details.textContent || '', /尚未检查/);
    assert.match(details.textContent || '', /每分钟自动检查（仅本次启用）/);
    assert.match(details.textContent || '', /不代表生成已结束/);
    assert.equal(f.container.querySelector('[data-existing-activity]')?.textContent, '本次观察记录仍保留');
    await setImmediate(); assert.equal(f.reads(), 0);
    assert.equal(f.container.querySelector<HTMLInputElement>('[data-reply-sync-auto]')?.checked, false);
    f.button('check').click(); await f.controller.check();
    assert.equal(f.reads(), 1);
    assert.match(f.container.textContent || '', /未设置已读基线|已读基线未设置/);
    assert.match(f.container.textContent || '', /数量未知/);
    assert.ok(f.container.querySelector('[data-reply-sync-time]')?.textContent);
    assert.equal(f.values.size, 0);
  } finally { f.close(); }
});

test('titles remain literal and opening preserves the exact document binding without marking read', async () => {
  const title = '<img src="https://invalid.example/pixel" onerror="attack()"> & 长标题';
  const f = fixture({ title });
  try {
    await f.controller.check();
    assert.equal(f.container.querySelector('[data-reply-sync-row] strong')?.textContent, title);
    assert.equal(f.root.querySelector('img,script,iframe,[onerror]'), null);
    f.button('open').click(); await setImmediate();
    assert.deepEqual(f.opened, [f.target]);
    assert.equal(f.values.size, 0);
    assert.equal(f.controller.view().rows[0].status, 'baseline-unset');
    assert.match(f.container.textContent || '', /已打开原会话/);
    assert.equal(f.button('ack').textContent, '标记当前检查已读');
  } finally { f.close(); }
});

test('an unsupported relation still has its original-history entry and never shows zero unread', async () => {
  const f = fixture({ legacy: true });
  try {
    await f.controller.check();
    assert.equal(f.reads(), 0);
    assert.match(f.container.textContent || '', /不可核验|无法核验/);
    assert.match(f.container.textContent || '', /数量未知/);
    assert.equal(f.button('ack'), null);
    assert.equal(f.button('open').textContent, '打开原会话');
    f.button('open').click(); await setImmediate(); assert.deepEqual(f.opened, [f.target]);
  } finally { f.close(); }
});

test('shared panels update from one controller and disposing one panel leaves checking and acknowledgement available', async () => {
  const f = fixture();
  const secondContainer = f.dom.window.document.createElement('section'); f.root.append(secondContainer);
  const second = new ReplySyncPanel(secondContainer, { controller: f.controller, openTarget: f.openTarget });
  try {
    await f.controller.check();
    const firstAuto = f.container.querySelector<HTMLInputElement>('[data-reply-sync-auto]')!;
    firstAuto.checked = true; firstAuto.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    await f.controller.check();
    assert.equal(secondContainer.querySelector<HTMLInputElement>('[data-reply-sync-auto]')?.checked, true);
    f.panel.dispose();
    assert.equal(f.controller.view().autoCheck, true);
    const saved = waitForRead(f.controller); f.button('ack', secondContainer).click(); await saved;
    assert.equal(f.controller.view().rows[0].status, 'read');
    assert.match(secondContainer.textContent || '', /未发现新回复/);
    assert.equal(f.container.querySelector('[data-reply-sync]'), null);
    assert.equal(f.container.querySelector('[data-existing-activity]')?.textContent, '本次观察记录仍保留');
  } finally { second.dispose(); f.close(); }
});

test('refresh preserves an external draft focus and selection plus expanded state and scroll', async () => {
  const f = fixture();
  try {
    const details = f.container.querySelector<HTMLDetailsElement>('[data-reply-sync]')!;
    const scroller = f.container.querySelector<HTMLElement>('[data-reply-sync-body]')!;
    const input = f.root.querySelector('textarea')!;
    details.open = true; scroller.scrollTop = 67;
    input.focus(); input.setSelectionRange(1, 4);
    await f.controller.check();
    assert.equal(f.dom.window.document.activeElement, input);
    assert.equal(input.value, '保留原草稿和选区');
    assert.deepEqual([input.selectionStart, input.selectionEnd], [1, 4]);
    assert.equal(details.open, true); assert.equal(scroller.scrollTop, 67);
  } finally { f.close(); }
});

test('a focused row action is restored by identity while stale detached buttons cannot acknowledge a newer check', async () => {
  const f = fixture();
  try {
    await f.controller.check();
    const oldAck = f.button('ack');
    f.button('open').focus();
    f.setMessages([{ id: 'answer-a', role: 'assistant', content: '虚构答复' }, { id: 'answer-b', role: 'assistant', content: '新的答复' }]);
    await f.controller.check();
    assert.equal(f.dom.window.document.activeElement, f.button('open'));
    oldAck.click(); await setImmediate();
    assert.equal(f.values.size, 0);
    assert.equal(f.controller.view().rows[0].status, 'baseline-unset');
    const saved = waitForRead(f.controller); f.button('ack').click(); await saved;
    assert.equal(f.controller.view().rows[0].status, 'read');
  } finally { f.close(); }
});

test('late open completion and detached actions after panel disposal cannot mutate UI or acknowledge', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ open: async () => gate });
  try {
    await f.controller.check(); const oldAck = f.button('ack'), oldOpen = f.button('open');
    oldOpen.click(); oldOpen.click();
    assert.equal(f.opened.length, 1);
    const feedback = f.container.querySelector<HTMLElement>('[data-reply-sync-feedback]')!;
    const before = feedback.textContent;
    f.panel.dispose(); oldAck.click(); oldOpen.click(); release(); await setImmediate();
    assert.equal(f.container.querySelector('[data-reply-sync]'), null);
    assert.equal(feedback.textContent, before);
    assert.equal(f.opened.length, 1);
    assert.equal(f.values.size, 0);
    await f.controller.check(); assert.equal(f.reads(), 2);
  } finally { release(); f.close(); }
});

test('open errors are text-only and do not erase the snapshot or read controls', async () => {
  const f = fixture({ open: async () => { throw new Error('<svg onload="attack()">原关联已变化'); } });
  try {
    await f.controller.check(); f.button('open').click(); await setImmediate();
    assert.match(f.container.querySelector('[data-reply-sync-feedback]')?.textContent || '', /原关联已变化/);
    assert.equal(f.root.querySelector('svg,[onload]'), null);
    assert.equal(f.button('open').disabled, false);
    assert.equal(f.button('ack').disabled, false);
    assert.equal(f.values.size, 0);
  } finally { f.close(); }
});

test('an old displayed open button cannot route its binding through a changed paired Bridge', async () => {
  let current = true;
  const f = fixture({ isCurrent: () => current });
  try {
    await f.controller.check(); const oldOpen = f.button('open');
    current = false; oldOpen.click(); await setImmediate();
    assert.equal(f.opened.length, 0);
    f.panel.render(); assert.equal(f.button('open').disabled, true);
    assert.equal(f.button('ack'), null);
    assert.equal(f.values.size, 0);
  } finally { f.close(); }
});
