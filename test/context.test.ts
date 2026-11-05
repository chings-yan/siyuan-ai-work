import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { extractEditorContext, enrichEditorContext, selectActiveEditor } from '../src/editor-context.ts';

beforeEach(() => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  Object.assign(globalThis, { document: dom.window.document, window: dom.window });
});

function fixture() {
  const protyle = document.createElement('div');
  protyle.className = 'protyle';
  protyle.dataset.id = 'root-1';
  protyle.innerHTML = '<input class="protyle-title__input" value="真实标题">\n<div class="protyle-wysiwyg">' +
    ['b1','b2','b3','b4','b5'].map((id, i) => `<div data-node-id="${id}"><span contenteditable="true">块 ${i + 1}</span></div>`).join('') +
    '</div>';
  document.body.append(protyle);
  const focus = protyle.querySelector('[data-node-id="b3"]')!;
  const range = document.createRange();
  range.selectNodeContents(focus);
  const selection = window.getSelection()!;
  selection.removeAllRanges(); selection.addRange(range);
  return { protyle, focus };
}

test('extracts title, rootID, focused block, selection, and ordered nearby blocks', () => {
  const { protyle, focus } = fixture();
  const result = extractEditorContext({
    document: document,
    activeProtyle: protyle,
    rootID: 'root-from-editor',
    recentBlockIds: ['b4', 'b2'],
  });
  assert.equal(result.documentId, 'root-from-editor');
  assert.equal(result.title, '真实标题');
  assert.equal(result.focusBlockId, 'b3');
  assert.equal(result.selection, '块 3');
  assert.deepEqual(result.nearby.map(x => x.blockId), ['b1', 'b2', 'b3', 'b4', 'b5']);
  assert.deepEqual(result.nearby.map(x => x.text), ['块 1', '块 2', '块 3', '块 4', '块 5']);
  assert.deepEqual(result.recent.map(x => x.blockId), ['b4', 'b2']);
  focus.remove(); protyle.remove();
});

test('reads a native contenteditable document title rather than the application window title', () => {
  document.title='思源测试窗口';
  const protyle=document.createElement('div');protyle.className='protyle';
  protyle.innerHTML='<div class="protyle-title__input" contenteditable="true"> 虚构访谈记录 </div>';
  document.body.append(protyle);
  assert.equal(extractEditorContext({document,activeProtyle:protyle,rootID:'test-root'}).title,'虚构访谈记录');
});

test('an unreadable document title remains unknown instead of using the application name',()=>{
  document.title='思源测试窗口';
  const protyle=document.createElement('div');protyle.className='protyle';document.body.append(protyle);
  assert.equal(extractEditorContext({document,activeProtyle:protyle,rootID:'test-root'}).title,'');
});

test('degrades safely when selection is outside an editor', () => {
  document.body.innerHTML = '<p id="outside">outside</p><div class="protyle"><div class="protyle-wysiwyg"><div data-node-id="b1">leak</div></div></div>';
  const protyle = document.querySelector('.protyle')!;
  const range = document.createRange(); range.selectNodeContents(document.querySelector('#outside')!);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const result = extractEditorContext({ document, activeProtyle: protyle });
  assert.equal(result.focusBlockId, '');
  assert.equal(result.selection, '');
  assert.deepEqual(result.nearby, []);
  assert.equal(result.degraded, true);
});

test('limits nearby blocks to a two-block DOM window around focus', () => {
  const protyle = document.createElement('div'); protyle.className = 'protyle';
  protyle.innerHTML = '<div class="protyle-wysiwyg">' + Array.from({length: 10}, (_, i) => `<div data-node-id="b${i + 1}"><span contenteditable="true">块 ${i + 1}</span></div>`).join('') + '</div>';
  document.body.append(protyle);
  const focus = protyle.querySelector('[data-node-id="b6"]')!;
  const range = document.createRange(); range.selectNodeContents(focus);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const result = extractEditorContext({ document, activeProtyle: protyle });
  assert.deepEqual(result.nearby.map(x => x.blockId), ['b4','b5','b6','b7','b8']);
});

test('enriches bounded nearby blocks with real Kramdown asynchronously', async () => {
  const input = {documentId:'d',title:'t',focusBlockId:'b3',selection:'',nearby:Array.from({length:7},(_,i)=>({blockId:`b${i}`,text:`text${i}`})),recent:[]};
  const calls: string[] = [];
  const result = await enrichEditorContext(input, async id => { calls.push(id); return {kramdown:{markdown:`md-${id}`}}; });
  assert.equal(result.nearby.length, 5); assert.deepEqual(result.nearby.map(x => x.sourceMarkdown), ['md-b0','md-b1','md-b2','md-b3','md-b4']); assert.deepEqual(calls, ['b0','b1','b2','b3','b4']);
});

test('selects the editor containing the DOM selection before active or visible editors', () => {
  const first = document.createElement('div'); first.className = 'protyle protyle--active';
  const second = document.createElement('div'); second.className = 'protyle';
  const selected = document.createElement('div'); selected.dataset.nodeId = 'selected'; second.append(selected);
  document.body.append(first, second);
  const range = document.createRange(); range.selectNodeContents(selected);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const firstEditor = { protyle: { element: first, block: { rootID: 'first' } } };
  const secondEditor = { protyle: { element: second, block: { rootID: 'second' } } };
  assert.equal(selectActiveEditor({ document, editors: [firstEditor, secondEditor] }), secondEditor);
});

test('uses focused or active visible editor and never falls back to a hidden editor when another is visible', () => {
  const hidden = document.createElement('div'); hidden.className = 'protyle'; hidden.hidden = true;
  const visible = document.createElement('div'); visible.className = 'protyle';
  document.body.append(hidden, visible);
  const hiddenEditor = { protyle: { element: hidden, block: { rootID: 'hidden' } } };
  const visibleEditor = { protyle: { element: visible, block: { rootID: 'visible' } } };
  assert.equal(selectActiveEditor({ document, editors: [hiddenEditor, visibleEditor] }), visibleEditor);
});

test('falls back to the only recognizable editor', () => {
  const protyle = document.createElement('div'); protyle.className = 'protyle'; document.body.append(protyle);
  const editor = { protyle: { element: protyle, block: { rootID: 'only' } } };
  assert.equal(selectActiveEditor({ document, editors: [{}, editor] }), editor);
});
