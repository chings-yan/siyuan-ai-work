import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { Reference } from '../src/references.ts';
import { renderReferenceBasketMarkup } from '../src/ui.ts';

const reference = (overrides: Partial<Reference> = {}): Reference => ({
  id: 'quote-1', blockId: 'block-1', documentRootId: 'document-1', documentTitle: '来源文档',
  selectedText: '选择的原文', capturedBlockKramdown: '未选中的整块内容', expectedOriginal: '整块原文',
  createdAt: '2026-11-06T00:00:00.000Z', startOffset: null, endOffset: null, ...overrides,
});

test('empty reference basket has no preview or scope claim', () => {
  assert.equal(renderReferenceBasketMarkup([]), '');
});

test('reference scope counts selected Unicode characters without claiming a token budget', () => {
  const dom = new JSDOM(renderReferenceBasketMarkup([
    reference({ selectedText: '甲😀\n' }),
    reference({ id: 'quote-2', selectedText: 'B ' }),
  ]));
  const count = dom.window.document.querySelector('.sac-reference-count')?.textContent;
  assert.match(count || '', /本轮引用 2/);
  assert.match(count || '', /选区 5 字符/);
  assert.doesNotMatch(count || '', /token|令牌|模型/i);
});

test('each reference has an initially collapsed native preview with its exact source identity', () => {
  const dom = new JSDOM(renderReferenceBasketMarkup([
    reference(),
    reference({ id: 'quote-2', blockId: 'block-2', documentRootId: 'document-2', documentTitle: '另一来源' }),
  ]));
  const details = [...dom.window.document.querySelectorAll('details')];
  assert.equal(details.length, 2);
  for (const [index, preview] of details.entries()) {
    assert.equal(preview.open, false);
    const summary = preview.querySelector('summary');
    assert.ok(summary);
    assert.equal(summary.parentElement, preview);
    assert.notEqual(summary.getAttribute('tabindex'), '-1');
    assert.match(summary.textContent || '', new RegExp(`引用${index + 1}`));
  }
  assert.deepEqual([...details[0].querySelectorAll('dd')].map(node => node.textContent), ['来源文档', 'document-1', 'block-1']);
  assert.deepEqual([...details[1].querySelectorAll('dd')].map(node => node.textContent), ['另一来源', 'document-2', 'block-2']);
});

test('selection preview preserves exact whitespace and shows plain text without loading embedded content', () => {
  const selectedText = '\n  **原文**\r\n<script>alert(1)</script><img src="https://invalid.example/image"> & 尾部  \n';
  const dom = new JSDOM(renderReferenceBasketMarkup([reference({ selectedText })]));
  const preview = dom.window.document.querySelector('details pre');
  assert.ok(preview);
  assert.equal(preview.textContent, selectedText);
  assert.equal(preview.getAttribute('tabindex'), '0');
  assert.match(preview.getAttribute('aria-label') || '', /引用1.*选区/);
  assert.equal(dom.window.document.querySelector('script, img, iframe, a, strong'), null);
  assert.doesNotMatch(dom.window.document.body.textContent || '', /未选中的整块内容|整块原文/);
});

test('hostile source labels and reference ids remain escaped while removal stays separate from preview', () => {
  const id = 'quote" data-action="send-stop';
  const dom = new JSDOM(renderReferenceBasketMarkup([reference({
    id, documentTitle: '<svg onload="alert(1)">', documentRootId: 'root<&"', blockId: 'block\'<>',
  })]));
  const preview = dom.window.document.querySelector('details');
  assert.ok(preview);
  assert.deepEqual([...preview.querySelectorAll('dd')].map(node => node.textContent), ['<svg onload="alert(1)">', 'root<&"', 'block\'<>']);
  assert.equal(dom.window.document.querySelector('svg, [onload], [data-action]'), null);
  const buttons = [...dom.window.document.querySelectorAll('button')];
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].getAttribute('data-remove-reference'), id);
  assert.equal(buttons[0].getAttribute('aria-label'), '删除引用1');
  assert.equal(buttons[0].type, 'button');
  assert.equal(buttons[0].closest('details, summary'), null);
  assert.equal(preview.parentElement, buttons[0].parentElement);
});

test('long selection is fully available in its preview without expanding the short summary', () => {
  const selectedText = `开头${'长内容'.repeat(500)}结尾`;
  const dom = new JSDOM(renderReferenceBasketMarkup([reference({ selectedText })]));
  const preview = dom.window.document.querySelector('details');
  assert.ok(preview);
  assert.equal(preview.querySelector('pre')?.textContent, selectedText);
  assert.ok((preview.querySelector('summary')?.textContent || '').length < 120);
});
