import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { JSDOM } from 'jsdom';
import { ReplyActivityPanel, ReplyActivityStore, type ReplyActivity } from '../src/work/reply-activity.ts';
import type { ChatLink } from '../src/work/store.ts';

const link: ChatLink = {
  chatId: 'synthetic-chat', workId: null, documentRootId: '20990101000000-aaaaaaa',
  connectionId: 'studio-default', adapter: 'studio', profile: 'default', installId: null,
  storedSessionId: 'synthetic-session', title: '虚构原会话', state: 'ready',
};

function fixture(open: (row: ReplyActivity) => Promise<string | void> = async () => undefined) {
  const dom = new JSDOM('<main class="sac"><nav class="sac-dock-tabs"></nav><textarea>保留正在编辑的草稿</textarea></main>', { pretendToBeVisual: true });
  const root = dom.window.document.querySelector<HTMLElement>('main')!;
  const store = new ReplyActivityStore();
  const opened: ReplyActivity[] = [], acknowledged: ReplyActivity[] = [];
  const panel = new ReplyActivityPanel(root, {
    rows: () => store.list('runtime-one'),
    open: async row => { opened.push(row); return open(row); },
    acknowledge: row => { acknowledged.push(row); store.acknowledge(row.key, row.revision); },
  });
  const begin = (key: string, title = link.title) => store.begin(key, { connection: 'runtime-one', link: { ...link, title } });
  const article = (key: string) => [...root.querySelectorAll<HTMLElement>('[data-activity-key]')].find(row => row.dataset.activityKey === key)!;
  const action = (key: string, name: 'open' | 'ack') => article(key).querySelector<HTMLButtonElement>(`[data-activity-action="${name}"]`);
  return { dom, root, store, panel, begin, article, action, opened, acknowledged, close: () => { panel.dispose(); dom.window.close(); } };
}

test('activity panel starts as a collapsed native details with an explicit local-only scope', () => {
  const f = fixture();
  try {
    const details = f.root.querySelector<HTMLDetailsElement>('[data-reply-activity]')!;
    const summary = details.querySelector<HTMLElement>('summary')!;
    assert.equal(details.tagName, 'DETAILS');
    assert.equal(details.open, false);
    assert.equal(details.firstElementChild, summary);
    assert.equal(summary.getAttribute('aria-label'), '回复动态');
    assert.notEqual(summary.getAttribute('tabindex'), '-1');
    summary.focus();
    assert.equal(f.dom.window.document.activeElement, summary);
    summary.click();
    assert.equal(details.open, true);
    summary.click();
    assert.equal(details.open, false);
    assert.match(details.textContent || '', /仅记录本次启用期间观察到的 Hermes 回复；不是全部远端未读/);
    assert.match(details.textContent || '', /暂无本次回复记录/);
    assert.equal(details.querySelector('[data-activity-count]')?.textContent, '0');
    assert.equal(f.opened.length, 0);
    assert.equal(f.acknowledged.length, 0);
  } finally { f.close(); }
});

test('activity titles and keys remain literal text and opening receives the exact original target', async () => {
  const f = fixture();
  try {
    const key = 'row" onclick="window.attack()<&';
    const title = '<img src="https://invalid.example/pixel" onerror="window.attack()"> & 虚构';
    const revision = f.begin(key, title);
    f.store.update(key, revision, 'unread', 'synthetic-message');
    f.panel.render();
    assert.equal(f.article(key).querySelector('strong')?.textContent, title);
    assert.equal(f.root.querySelector('img,script,iframe,[onclick],[onerror]'), null);
    f.action(key, 'open')!.click();
    await setImmediate();
    assert.equal(f.opened.length, 1);
    assert.equal(f.opened[0].key, key);
    assert.equal(f.opened[0].revision, revision);
    assert.deepEqual(f.opened[0].target, { connection: 'runtime-one', link: { ...link, title } });
    assert.equal(f.opened[0].messageId, 'synthetic-message');
    assert.equal(f.acknowledged.length, 0);
    assert.equal(f.store.list('runtime-one')[0].acknowledged, false);
    assert.match(f.root.textContent || '', /已打开原会话；查看完成后可标为已查看/);
  } finally { f.close(); }
});

test('waiting cannot be dismissed and explicit acknowledgement preserves review state', () => {
  const f = fixture();
  try {
    const unread = f.begin('unread'), review = f.begin('review');
    f.begin('waiting');
    f.store.update('unread', unread, 'unread');
    f.store.update('review', review, 'review');
    f.panel.render();
    assert.match(f.article('waiting').textContent || '', /等待回复/);
    assert.equal(f.action('waiting', 'ack'), null);
    assert.match(f.article('unread').textContent || '', /新回复待查看/);
    assert.match(f.article('review').textContent || '', /结果待核对/);
    assert.equal(f.root.querySelector('[data-activity-count]')?.textContent, '3');
    f.action('unread', 'ack')!.click();
    f.action('review', 'ack')!.click();
    assert.equal(f.acknowledged.length, 2);
    assert.match(f.article('unread').textContent || '', /回复已查看/);
    assert.match(f.article('review').textContent || '', /结果待核对（提示已查看）/);
    assert.equal(f.store.list('runtime-one').find(row => row.key === 'review')?.state, 'review');
    assert.equal(f.action('review', 'ack'), null);
    assert.equal(f.root.querySelector('[data-activity-count]')?.textContent, '1');
    assert.equal(f.opened.length, 0);
  } finally { f.close(); }
});

test('an open failure is readable plain text and neither acknowledges nor removes the original activity', async () => {
  const failure = '<svg onload="attack()">原关联已变化，请核对';
  const f = fixture(async () => { throw new Error(failure); });
  try {
    const revision = f.begin('failed');
    f.store.update('failed', revision, 'review');
    f.panel.render();
    f.action('failed', 'open')!.click();
    await setImmediate();
    assert.equal(f.root.querySelector('[data-activity-feedback]')?.textContent, failure);
    assert.equal(f.root.querySelector('svg,[onload]'), null);
    assert.equal(f.action('failed', 'open')?.disabled, false);
    assert.deepEqual(f.store.list('runtime-one').map(row => [row.key, row.state, row.acknowledged]), [['failed', 'review', false]]);
    assert.equal(f.acknowledged.length, 0);
  } finally { f.close(); }
});

test('opening is single-flight even when an already detached button is clicked again', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => { await gate; return '原会话已核对'; });
  try {
    f.begin('one'); f.begin('two'); f.panel.render();
    const oldButton = f.action('one', 'open')!;
    oldButton.click(); oldButton.click();
    f.action('two', 'open')!.click();
    assert.equal(f.opened.length, 1);
    assert.ok([...f.root.querySelectorAll<HTMLButtonElement>('[data-activity-action="open"]')].every(button => button.disabled));
    assert.match(f.root.querySelector('[data-activity-feedback]')?.textContent || '', /正在核对原会话/);
    release(); await setImmediate();
    assert.equal(f.root.querySelector('[data-activity-feedback]')?.textContent, '原会话已核对');
    assert.ok([...f.root.querySelectorAll<HTMLButtonElement>('[data-activity-action="open"]')].every(button => !button.disabled));
    assert.equal(f.acknowledged.length, 0);
  } finally { release(); f.close(); }
});

test('activity refresh preserves external draft focus, selection, expanded state and tray scroll', () => {
  const f = fixture();
  try {
    const revision = f.begin('one'); f.panel.render();
    const details = f.root.querySelector<HTMLDetailsElement>('details')!;
    const tray = f.root.querySelector<HTMLElement>('.sac-activity-tray')!;
    const input = f.root.querySelector('textarea')!;
    details.open = true; tray.scrollTop = 72;
    input.focus(); input.setSelectionRange(2, 5);
    f.store.update('one', revision, 'unread'); f.panel.render();
    assert.equal(f.dom.window.document.activeElement, input);
    assert.equal(input.value, '保留正在编辑的草稿');
    assert.deepEqual([input.selectionStart, input.selectionEnd], [2, 5]);
    assert.equal(details.open, true);
    assert.equal(tray.scrollTop, 72);
  } finally { f.close(); }
});

test('activity refresh restores a focused row action and acknowledgement returns focus to its native summary', () => {
  const f = fixture();
  try {
    const revision = f.begin('one'); f.store.update('one', revision, 'unread'); f.panel.render();
    const details = f.root.querySelector<HTMLDetailsElement>('details')!;
    details.open = true;
    f.action('one', 'open')!.focus(); f.begin('two'); f.panel.render();
    assert.equal(f.dom.window.document.activeElement, f.action('one', 'open'));
    f.action('one', 'ack')!.focus(); f.action('one', 'ack')!.click();
    assert.equal(f.dom.window.document.activeElement, details.querySelector('summary'));
    assert.equal(details.open, true);
  } finally { f.close(); }
});

test('late open completion after disposal cannot recreate the panel or mutate its detached feedback', async () => {
  let release!: (value: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const f = fixture(() => gate);
  try {
    f.begin('one'); f.panel.render(); f.action('one', 'open')!.click();
    const feedback = f.root.querySelector<HTMLElement>('[data-activity-feedback]')!;
    const oldOpen = f.action('one', 'open')!;
    f.panel.dispose();
    release('不得出现的迟到结果'); await setImmediate();
    oldOpen.click(); f.panel.render();
    assert.equal(f.root.querySelector('[data-reply-activity]'), null);
    assert.equal(feedback.textContent, '正在核对原会话…');
    assert.equal(f.root.querySelector('textarea')?.value, '保留正在编辑的草稿');
    assert.equal(f.opened.length, 1);
    assert.equal(f.acknowledged.length, 0);
  } finally { release('cleanup'); f.close(); }
});

test('disposed activity controls cannot acknowledge a record through a retained old button', () => {
  const f = fixture();
  try {
    const revision = f.begin('one'); f.store.update('one', revision, 'unread'); f.panel.render();
    const oldAck = f.action('one', 'ack')!;
    f.panel.dispose(); oldAck.click();
    assert.equal(f.acknowledged.length, 0);
    assert.equal(f.store.list('runtime-one')[0].acknowledged, false);
  } finally { f.close(); }
});
