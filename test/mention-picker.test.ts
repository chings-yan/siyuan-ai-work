import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionQueryAtCursor, filterMentionCandidates, referenceShortLabel, referenceMarker, applyMentionSelection, mentionKeyAction, renderMentionPickerMarkup, clampMentionIndex } from '../src/ui.ts';
import type { Reference } from '../src/references.ts';

const ref = (id:string, title:string, selectedText:string):Reference => ({
  id, blockId:`block-${id}`, documentRootId:'doc', documentTitle:title, selectedText,
  startOffset:null, endOffset:null, capturedBlockKramdown:selectedText, expectedOriginal:selectedText, createdAt:'now'
});

test('mention query is detected only immediately before the caret', () => {
  assert.deepEqual(mentionQueryAtCursor('请看 @合同', 7), { query:'合同', start:4, end:7 });
  assert.equal(mentionQueryAtCursor('请看 @合同', 3), null);
  assert.equal(mentionQueryAtCursor('email@test', 10), null);
});

test('mention candidates filter by title, selected text, or captured summary', () => {
  const candidates = [ref('1','劳动合同','付款条款'), ref('2','项目说明','验收标准')];
  assert.deepEqual(filterMentionCandidates(candidates, '合同').map(x=>x.id), ['1']);
  assert.deepEqual(filterMentionCandidates(candidates, '验收').map(x=>x.id), ['2']);
  assert.deepEqual(filterMentionCandidates(candidates, ''), candidates);
});

test('selection replaces only the active mention and keeps a normal textarea value', () => {
  const text = '先问 @劳动合同';
  const result = applyMentionSelection(text, text.length, ref('1','劳动合同','付款条款'), 1);
  assert.equal(result.text, '先问 【引用1：付款条款】');
  assert.equal(result.cursor, '先问 【引用1：付款条款】'.length);
});

test('short marker and attachment label share exactly one formatter', () => {
  const r = ref('1','劳动合同','这是一个很长的选中文本，应该在短标签中被合理截断而不是铺开完整文档，并且还要继续截断 this is extra text to force truncation');
  const label = referenceShortLabel(r);
  assert.match(label, /…$/);
  assert.equal(referenceMarker(r, 2), `【引用2：${label}】`);
});

test('mention picker renders a real escaped option menu with stable reference numbers', () => {
  const refs = [ref('1','<合同>','付款条款'), ref('2','项目说明','验收标准')];
  const html = renderMentionPickerMarkup(refs, 1, new Map([['1', 1], ['2', 2]]));
  assert.match(html, /class="sac-mention-option"/);
  assert.match(html, /role="option"/);
  assert.match(html, /data-mention-index="0"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(html, /【引用2：验收标准】/);
  assert.doesNotMatch(html, /项目说明.*1\./);
  assert.doesNotMatch(html, /<合同>/);
  assert.match(html, /&lt;合同&gt;/);
});

test('mention picker shows a non-selectable empty state and clamps filtered index', () => {
  assert.match(renderMentionPickerMarkup([], 4, new Map()), /暂无引用，请先用＋引用添加/);
  assert.doesNotMatch(renderMentionPickerMarkup([], 4, new Map()), /role="option"/);
  assert.equal(clampMentionIndex(4, 2), 1);
  assert.equal(clampMentionIndex(-1, 2), 0);
  assert.equal(clampMentionIndex(4, 0), 0);
});

test('keyboard actions navigate, choose, escape, and never choose while composing', () => {
  assert.deepEqual(mentionKeyAction({key:'ArrowDown', index:0, count:3, open:true}), {kind:'move', index:1});
  assert.deepEqual(mentionKeyAction({key:'ArrowUp', index:0, count:3, open:true}), {kind:'move', index:2});
  assert.deepEqual(mentionKeyAction({key:'Enter', index:1, count:3, open:true}), {kind:'choose', index:1});
  assert.deepEqual(mentionKeyAction({key:'Tab', index:1, count:3, open:true}), {kind:'choose', index:1});
  assert.deepEqual(mentionKeyAction({key:'Escape', index:1, count:3, open:true}), {kind:'close'});
  assert.deepEqual(mentionKeyAction({key:'Enter', index:1, count:3, open:true, isComposing:true}), {kind:'ignore'});
});
