import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildSnapshot, validatePlan, applyPlan, parseKramdownResponse, normalizeForReadback, assertSnapshotMatchesThread, isBindableDocumentRoot, isValidDocumentRootId } from '../src/core.ts';

beforeEach(() => { const dom = new JSDOM('<!doctype html><html><body></body></html>'); Object.assign(globalThis, { document: dom.window.document, window: dom.window }); });
test('snapshot keeps bounded context and metadata', () => { const s = buildSnapshot({documentId:'d1',title:'文档',focusBlockId:'b2',selection:'选中内容',nearby:[{blockId:'a',text:'a'},{blockId:'b',text:'b'},{blockId:'c',text:'c'}],recent:[{blockId:'r1',text:'r1'}]}, {maxChars:20}); assert.equal(s.documentId,'d1'); assert.ok(s.contextText.length<=20); });
test('validatePlan rejects stale expectedOriginal', () => { assert.throws(() => validatePlan([{blockId:'b1',expectedOriginal:'old',replacement:'new'}],{b1:'current'}),/conflict/); });
test('applyPlan requires explicit acceptance and rechecks content', () => { const blocks={b1:'old'}; assert.throws(() => applyPlan([{blockId:'b1',expectedOriginal:'old',replacement:'new'}],blocks,{accepted:false}),/accepted/); assert.equal(applyPlan([{blockId:'b1',expectedOriginal:'old',replacement:'new'}],blocks,{accepted:true}).b1,'new'); });
test('snapshot marks missing change feed as degraded', () => { assert.equal(buildSnapshot({documentId:'d',title:'t',focusBlockId:'b',selection:'',nearby:[],recent:[]},{maxChars:100}).degraded,true); });
test('sending rejects a snapshot whose document differs from the thread root', () => { assert.throws(() => assertSnapshotMatchesThread('doc-b', { documentId:'doc-a' }), /文档快照与当前对话不一致/); });
test('Studio association is blocked for an unrecognized document root', () => { assert.equal(isBindableDocumentRoot(''), false); assert.equal(isBindableDocumentRoot('未识别文档'), false); });
test('SiYuan document roots use the timestamp and seven-character node id format', () => {
  assert.equal(isValidDocumentRootId('20260826094850-kronins'), true);
  for (const value of ['', '未识别文档', 'doc-root', '20260826094850-KRONINS', '20260826094850-short', '20260826094850-kronins\n']) {
    assert.equal(isValidDocumentRootId(value), false, value);
    assert.equal(isBindableDocumentRoot(value), false, value);
  }
});
test('validatePlan rejects duplicate targets', () => { assert.throws(() => validatePlan([{blockId:'b',expectedOriginal:'x',replacement:'1'},{blockId:'b',expectedOriginal:'x',replacement:'2'}],{b:'x'}),/duplicate/); });
test('parses kramdown response string object and array shapes', () => { assert.equal(parseKramdownResponse('plain'),'plain'); assert.equal(parseKramdownResponse({kramdown:{markdown:'object'}}),'object'); assert.equal(parseKramdownResponse({kramdown:[{kramdown:'array'}]}),'array'); });
test('rejects empty replacement and only permits snapshot nearby blocks', () => { assert.throws(() => validatePlan([{blockId:'b1',expectedOriginal:'x',replacement:'  '}],{b1:'x'}),/empty replacement/); assert.throws(() => validatePlan([{blockId:'b2',expectedOriginal:'x',replacement:'y'}],{b1:'x'}),/missing block/); });
test('readback normalization ignores only trailing generated block IAL', () => { assert.equal(normalizeForReadback('正文\n{: id="b1" updated="1"}'),'正文'); assert.notEqual(normalizeForReadback('正文 A'),normalizeForReadback('正文 B')); });
