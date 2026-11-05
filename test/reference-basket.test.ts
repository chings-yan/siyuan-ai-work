import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReferenceBasket, formatQuestionWithReferences, type Reference } from '../src/references.ts';

const ref = (overrides: Partial<Reference> = {}): Reference => ({
  id: 'quote-1', blockId: 'b1', documentRootId: 'd1', documentTitle: '文档一',
  selectedText: '第一段', capturedBlockKramdown: '第一段\n{: id="b1"}', expectedOriginal: '第一段',
  createdAt: '2026-08-25T00:00:00.000Z', startOffset: null, endOffset: null, ...overrides,
});

test('keeps two different selections from the same block and stable numbering', () => {
  const basket = new ReferenceBasket();
  assert.equal(basket.add(ref({ id: 'q1', selectedText: '第一' })).id, 'q1');
  assert.equal(basket.add(ref({ id: 'q2', selectedText: '第二' })).id, 'q2');
  assert.deepEqual(basket.list().map(x => x.selectedText), ['第一', '第二']);
  assert.deepEqual(basket.list().map(x => basket.numberOf(x.id)), [1, 2]);
});

test('deduplicates exact block and selected text without merging different documents', () => {
  const basket = new ReferenceBasket();
  const first = basket.add(ref({ id: 'q1', selectedText: '相同' }));
  const duplicate = basket.add(ref({ id: 'q2', selectedText: '相同', capturedBlockKramdown: 'new' }));
  const otherDocument = basket.add(ref({ id: 'q3', documentRootId: 'd2', blockId: 'b2', selectedText: '相同' }));
  assert.equal(duplicate.id, first.id); assert.equal(otherDocument.id, 'q3'); assert.equal(basket.list().length, 2);
});

test('supports single deletion and clearing all references in memory', () => {
  const basket = new ReferenceBasket(); basket.add(ref({ id: 'q1' })); basket.add(ref({ id: 'q2', blockId: 'b2' }));
  assert.equal(basket.remove('q1'), true); assert.equal(basket.list()[0].id, 'q2'); basket.clear(); assert.deepEqual(basket.list(), []);
});

test('formats explicit references separately from bounded auxiliary context', () => {
  const prompt = formatQuestionWithReferences('怎么改？', [ref({ id: 'q1', selectedText: '重点' })], [{ blockId: 'b2', text: '附近背景', sourceMarkdown: '附近背景' }]);
  assert.match(prompt, /用户明确引用/); assert.match(prompt, /\[引用1\].*blockId=b1/s); assert.match(prompt, /辅助背景/); assert.match(prompt, /b2: 附近背景/); assert.ok(!prompt.includes('完整文档'));
});
