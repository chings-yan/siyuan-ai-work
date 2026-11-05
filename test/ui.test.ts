import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { applyGeneratingState, applyStudioInteractionEvent, bindComposerResize, createChatShell, isSendKey, prepareOutgoingMessage, renderEmptyStateMarkup, renderMessageMarkup, renderReferenceBasketMarkup } from '../src/ui.ts';
import { CSS } from '../src/styles.ts';
import { mountStudioPicker, renderStudioSessionOptions } from '../src/studio-picker.ts';

test('outgoing composer is cleared synchronously before async work', () => {
  const dom = new JSDOM('<textarea></textarea>'); const textarea=dom.window.document.querySelector('textarea')!;
  textarea.value='  hello  '; assert.equal(prepareOutgoingMessage(textarea),'hello'); assert.equal(textarea.value,'');
});

test('outgoing composer dispatches input and closes an open mention popup', () => {
  const dom = new JSDOM('<div><textarea></textarea><div data-mention-list></div></div>');
  const textarea=dom.window.document.querySelector('textarea')!;
  const popup=dom.window.document.querySelector('[data-mention-list]')!;
  popup.removeAttribute('hidden'); textarea.value='hello';
  let inputEvents=0; textarea.addEventListener('input', () => inputEvents++);
  assert.equal(prepareOutgoingMessage(textarea), 'hello');
  assert.equal(textarea.value, ''); assert.equal(inputEvents, 1); assert.equal(popup.hasAttribute('hidden'), true);
});

test('composer top grip resizes the draft vertically without hiding messages', async () => {
  const dom = new JSDOM('<div id="dock"></div>');
  const dock = dom.window.document.querySelector<HTMLElement>('#dock')!;
  dock.innerHTML = createChatShell();
  const grip = dock.querySelector<HTMLElement>('[data-composer-resize]');
  assert.ok(grip, 'the composer needs a visible top drag grip');
  const textarea = dock.querySelector<HTMLTextAreaElement>('.sac-composer textarea')!;
  const main = dock.querySelector<HTMLElement>('.sac-main')!;
  textarea.value = '保留草稿';
  Object.defineProperty(textarea, 'getBoundingClientRect', { value: () => ({ height: Number.parseFloat(textarea.style.height) || 38 }) });
  Object.defineProperty(main, 'clientHeight', { value: 140 });
  const ui = await import('../src/ui.ts');
  const bind = (ui as typeof ui & { bindComposerResize?: (root: HTMLElement) => void }).bindComposerResize;
  assert.equal(typeof bind, 'function');
  bind!(dock);
  const pointer = (type: string, clientY: number) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { clientY: { value: clientY }, pointerId: { value: 1 }, button: { value: 0 } });
    return event;
  };
  grip.dispatchEvent(pointer('pointerdown', 200));
  dom.window.dispatchEvent(pointer('pointermove', 160));
  assert.equal(textarea.style.height, '78px');
  dom.window.dispatchEvent(pointer('pointermove', 20));
  assert.equal(textarea.style.height, '98px', 'the list must retain at least 80px of its starting height');
  dom.window.dispatchEvent(pointer('pointermove', 400));
  assert.equal(textarea.style.height, '38px');
  dom.window.dispatchEvent(pointer('pointerup', 400));
  dom.window.dispatchEvent(pointer('pointermove', 100));
  assert.equal(textarea.style.height, '38px', 'drag listeners must stop on pointer up');
  grip.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  assert.equal(textarea.style.height, '50px');
  assert.equal(grip.getAttribute('aria-valuenow'), '50');
  assert.equal(textarea.value, '保留草稿');
});

test('generating state exposes a visible animated busy indicator and preserves stop action', () => {
  const dom = new JSDOM('<div id="root"></div>'); const root=dom.window.document.querySelector('#root')!; root.innerHTML=createChatShell();
  const indicator=root.querySelector('[data-generating-indicator]')!; assert.equal(indicator.hasAttribute('hidden'),true); applyGeneratingState(root,true);
  assert.equal(root.querySelector('[data-action="send-stop"]')?.getAttribute('aria-label'),'停止'); assert.equal(indicator.hasAttribute('hidden'),false); assert.equal(indicator.querySelectorAll('i').length,3);
  applyGeneratingState(root,false); assert.equal(root.querySelector('[data-action="send-stop"]')?.getAttribute('aria-label'),'发送'); assert.equal(indicator.hasAttribute('hidden'),true);
});

test('chat shell is message-led with compact header, local Work picker, and fixed composer', () => {
  const dom = new JSDOM('<div id="root"></div>');
  const root = dom.window.document.querySelector('#root')!;
  root.innerHTML = createChatShell();
  assert.ok(root.querySelector('.sac-header'));
  assert.ok(root.querySelector('.sac-header-primary'));
  assert.ok(root.querySelector('.sac-header-secondary'));
  assert.match(root.querySelector('[data-work-title]')?.textContent || '', /Work/);
  assert.equal(root.querySelector('[data-action="work-picker"]')?.getAttribute('aria-expanded'), 'false');
  assert.equal(root.querySelector('[data-work-quick-menu]')?.getAttribute('hidden'), '');
  assert.ok(root.querySelector('[data-status-alert][aria-live]'));
  assert.ok(root.querySelector('[data-action="dismiss-status"]'));
  assert.ok(root.querySelector('.sac-main[data-messages]'));
  assert.ok(root.querySelector('.sac-composer'));
  assert.equal(root.querySelector('.sac-settings'), null,'settings no longer occupies chat height');
  assert.ok(root.querySelector('[data-action="toggle-settings"]'));
  assert.ok(root.querySelector('[data-action="send-stop"]'));
  assert.equal(root.querySelector('[data-action="send"]'), null);
  assert.equal(root.querySelector('[data-action="stop"]'), null);
  assert.equal(root.querySelector('img'), null);
  for (const button of root.querySelectorAll('button')) assert.ok(button.getAttribute('aria-label'), button.outerHTML);
});

test('composer sends on Enter but not Shift+Enter or IME composition', () => {
  assert.equal(isSendKey({ key: 'Enter', shiftKey: false, isComposing: false }), true);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(isSendKey({ key: 'Enter', shiftKey: false, isComposing: true }), false);
});

test('empty references do not render a basket and messages are safely escaped', () => {
  const dom = new JSDOM('<div id="root"></div>');
  const root = dom.window.document.querySelector('#root')!;
  root.innerHTML = createChatShell();
  const refs = root.querySelector('[data-references]')!;
  assert.equal(refs.hasAttribute('hidden'), true);
  const html = renderMessageMarkup({ role: 'assistant', content: '<script>alert(1)</script>\n**safe**', references: [], status: 'complete' });
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /sac-message-assistant/);
  assert.match(html, /sac-message-content/);
});

test('empty state is compact, document-led, and exposes three capabilities', () => {
  const dom = new JSDOM(renderEmptyStateMarkup());
  assert.match(dom.window.document.body.textContent || '', /一起处理当前文档/);
  assert.equal(dom.window.document.querySelectorAll('.sac-empty-capability').length, 3);
  assert.equal(dom.window.document.querySelector('img'), null);
});

test('reference basket is a compact escaped strip with count, sources, and stable removal hooks', () => {
  const html = renderReferenceBasketMarkup([
    { id:'q1', blockId:'b1', documentRootId:'20260826094850-kronins', documentTitle:'文档 <一>', selectedText:'重点', startOffset:null, endOffset:null, capturedBlockKramdown:'重点', expectedOriginal:'重点', createdAt:'now' },
    { id:'q2', blockId:'b2', documentRootId:'20260826094850-kronins', documentTitle:'文档二', selectedText:'另一段', startOffset:null, endOffset:null, capturedBlockKramdown:'另一段', expectedOriginal:'另一段', createdAt:'now' },
  ]);
  const dom = new JSDOM(html);
  assert.match(dom.window.document.body.textContent || '', /引用 2/);
  assert.equal(dom.window.document.querySelectorAll('[data-remove-reference]').length, 2);
  assert.equal(dom.window.document.querySelector('[data-remove-reference]')?.getAttribute('aria-label'), '删除引用1');
  assert.equal(html.includes('<一>'), false);
  assert.match(html, /文档 &lt;一&gt;/);
});

test('plan controls are absent until a message has a valid plan', () => {
  const dom = new JSDOM('<div id="root"></div>');
  const root = dom.window.document.querySelector('#root')!;
  root.innerHTML = createChatShell();
  assert.equal(root.querySelector('[data-action="accept"]'), null);
  assert.equal(root.querySelector('[data-action="reject"]'), null);
  const html = renderMessageMarkup({ role: 'assistant', content: '建议', references: [], status: 'complete', plan: [{ blockId: 'b1', expectedOriginal: '旧内容', replacement: '新内容' }] });
  assert.match(html, /查看修改建议/);
});

test('message bodies explicitly allow text selection and copying', () => {
  assert.match(CSS, /\.sac-message-body\{[^}]*user-select:text/);
  assert.match(CSS, /\.sac-message-body\{[^}]*-webkit-user-select:text/);
});

test('native narrow-panel styles use actual dock width and height and cover interaction states', () => {
  assert.match(CSS, /container-type:size/);
  assert.match(CSS, /@container[^\{]*\(max-height:400px\)/);
  assert.match(CSS, /overflow-x:hidden/);
  assert.match(CSS, /\.sac-reference-chips\{[^}]*overflow-x:auto/);
  assert.match(CSS, /:focus-visible/);
  assert.match(CSS, /:disabled/);
  assert.match(CSS, /@container[^\{]*\(max-width:340px\)/);
  assert.match(CSS, /\.sac-send-stop\{[^}]*width:36px[^}]*height:36px/);
  assert.doesNotMatch(CSS, /#[0-9a-f]{3,8}\b/i);
  assert.doesNotMatch(CSS, /rgba?\(/i);
});

test('messages retain flexible independent scrolling and bottom composer when status opens', () => {
  const dom=new JSDOM('<html><head></head><body></body></html>');const d=dom.window.document;
  const style=d.createElement('style');style.textContent=CSS;d.head.append(style);d.body.innerHTML=createChatShell();
  const shell=d.querySelector<HTMLElement>('.sac')!,main=d.querySelector<HTMLElement>('[data-messages]')!,composer=d.querySelector<HTMLElement>('[data-composer]')!;
  const css=(e:Element)=>dom.window.getComputedStyle(e);
  assert.equal(css(shell).display,'flex');assert.equal(css(shell).flexDirection,'column');
  for(const hidden of [true,false]){d.querySelector<HTMLElement>('[data-status-alert]')!.hidden=hidden;assert.equal(css(main).overflow,'auto');assert.equal(css(main).flexGrow,'1');assert.equal(css(composer).flexShrink,'0');}
  assert.equal(d.querySelector('.sac-header')!.children.length,2);dom.window.close();
});

test('Studio picker titles stay on one ellipsized line while full title and preview remain searchable', () => {
  const title = '这是一个包含空格、换行\n以及 HTML <片段> 的超长 Hermes 对话标题';
  const dom = new JSDOM('<!doctype html><html><head></head><body><div class="sac"><div data-studio-options></div></div></body></html>');
  const styleElement = dom.window.document.createElement('style');
  styleElement.textContent = CSS;
  dom.window.document.head.appendChild(styleElement);
  const options = dom.window.document.querySelector<HTMLElement>('[data-studio-options]')!;
  options.innerHTML = renderStudioSessionOptions([
    { id: 'long', title, preview: '完整预览关键词' },
    { id: 'other', title: '另一个对话', preview: '另一个预览' },
  ], '完整预览关键词');

  const label = options.querySelector('label')!;
  const titleSpan = label.querySelector(':scope > span')!;
  const computed = dom.window.getComputedStyle(titleSpan);
  assert.equal(titleSpan.textContent, title);
  assert.equal(titleSpan.getAttribute('title'), title);
  assert.equal(computed.whiteSpace, 'nowrap');
  assert.equal(computed.overflow, 'hidden');
  assert.equal(computed.textOverflow, 'ellipsis');
  assert.equal(dom.window.getComputedStyle(options).overflowY, 'auto');
  assert.equal(options.querySelectorAll('label').length, 1);
  const sessionInput = options.querySelector<HTMLInputElement>('label input')!;
  assert.equal(sessionInput.value, 'long');
  assert.equal(renderStudioSessionOptions([{ id: 'long', title, preview: '完整预览关键词' }], 'HTML <片段>').includes('value="long"'), true);
  assert.equal(titleSpan.innerHTML.includes('<片段>'), false);
  assert.match(titleSpan.innerHTML, /&lt;片段&gt;/);
});

test('Studio picker stays inside the chat panel and constrains a long list to its own scroll area', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="dock"></div></body></html>');
  const styleElement = dom.window.document.createElement('style');
  styleElement.textContent = CSS;
  dom.window.document.head.appendChild(styleElement);
  const dock = dom.window.document.querySelector<HTMLElement>('#dock')!;
  dock.innerHTML = createChatShell();
  const overlay = dom.window.document.createElement('div');
  overlay.className = 'sac-studio-picker';
  overlay.innerHTML = '<div role="dialog"><input data-studio-search><div data-studio-options></div><div class="sac-studio-actions"><button>取消</button><button>确认关联</button></div></div>';
  const options = overlay.querySelector<HTMLElement>('[data-studio-options]')!;
  options.innerHTML = renderStudioSessionOptions(Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, title: `第 ${i} 个对话` })), '');

  mountStudioPicker(dock, overlay);

  const panel = dock.querySelector<HTMLElement>('.sac')!;
  const dialog = overlay.querySelector<HTMLElement>('[role="dialog"]')!;
  assert.equal(overlay.parentElement, panel.querySelector('[data-chat-menu-anchor]'));
  assert.equal(dom.window.getComputedStyle(overlay).position, 'absolute');
  assert.equal(options.querySelectorAll('label').length, 100);
  assert.equal(dom.window.getComputedStyle(dialog).overflow, 'hidden');
  assert.equal(dom.window.getComputedStyle(dialog).gridTemplateRows, 'auto minmax(0,1fr) auto');
  assert.ok(Number.parseInt(dom.window.getComputedStyle(dialog).maxHeight, 10) <= 220, 'picker actions must fit in the default 360px dock');
  assert.equal(dom.window.getComputedStyle(options).minHeight, '0');
  assert.equal(dom.window.getComputedStyle(options).overflowY, 'auto');
});

test('chat actions open from a local menu with new and existing conversation choices', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="dock"></div></body></html>');
  const dock = dom.window.document.querySelector<HTMLElement>('#dock')!;
  dock.innerHTML = createChatShell();
  const menu = dock.querySelector<HTMLElement>('[data-chat-menu]')!;
  assert.ok(menu);
  assert.equal(menu.hidden, true);
  assert.equal(dock.querySelector('[data-action="chat-actions-menu"]')?.getAttribute('aria-expanded'), 'false');
  assert.match(menu.querySelector('[data-action="chat-menu-new"]')?.textContent || '', /新建.*对话/);
  assert.match(menu.querySelector('[data-action="associate-studio"]')?.textContent || '', /关联.*Hermes.*对话/);
  assert.equal(dock.querySelector('[data-current-session-kind]')?.textContent, 'AI 对话');
  dom.window.close();
});

test('message terminal states render separately from selectable message text', () => {
  const html = renderMessageMarkup({ role:'assistant', content:'失败正文', references:[], status:'error' });
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector('.sac-message-body')?.textContent, '失败正文');
  assert.equal(dom.window.document.querySelector('.sac-message-state')?.textContent, '失败');
});

test('approval and clarify events stop the spinner and direct the user to Studio', () => {
  const dom = new JSDOM('<div id="root"></div>'); const root=dom.window.document.querySelector('#root')!; root.innerHTML=createChatShell(); applyGeneratingState(root,true);
  assert.equal(applyStudioInteractionEvent(root,'approval.requested',{}),true); assert.equal(root.querySelector('[data-generating-indicator]')?.hasAttribute('hidden'),true); assert.match(root.querySelector('[data-status]')?.textContent||'',/需在 Hermes Studio 处理/);
  applyGeneratingState(root,true); applyStudioInteractionEvent(root,'clarify.requested',{}); assert.equal(root.querySelector('[data-generating-indicator]')?.hasAttribute('hidden'),true); assert.match(root.querySelector('[data-status]')?.textContent||'',/需在 Hermes Studio 处理/);
});

test('Task4 resize disposal releases a drag already listening on the window',async()=>{
 const ui=await import('../src/ui.ts');
 const dom=new JSDOM('<div id="dock"></div>');const root=dom.window.document.querySelector<HTMLElement>('#dock')!;root.innerHTML=createChatShell();const area=root.querySelector<HTMLTextAreaElement>('textarea')!,grip=root.querySelector<HTMLElement>('[data-composer-resize]')!;Object.defineProperty(root.querySelector('.sac-main'),'clientHeight',{value:240});Object.defineProperty(area,'getBoundingClientRect',{value:()=>({height:38})});
 const cleanup=ui.bindComposerResize(root);const event=(type:string,y:number)=>{const e=new dom.window.Event(type,{bubbles:true});Object.defineProperties(e,{clientY:{value:y},pointerId:{value:1},button:{value:0}});return e;};grip.dispatchEvent(event('pointerdown',200));assert.equal(typeof cleanup,'function');(cleanup as any)();dom.window.dispatchEvent(event('pointermove',150));assert.equal(area.style.height,'');dom.window.close();
});

test('restoring a composer height keeps its saved preference until the user resizes', () => {
  const dom=new JSDOM('<div id="dock"></div>');
  const root=dom.window.document.querySelector<HTMLElement>('#dock')!;
  root.innerHTML=createChatShell();
  const grip=root.querySelector<HTMLElement>('[data-composer-resize]')!;
  const area=root.querySelector<HTMLTextAreaElement>('textarea')!;
  Object.defineProperty(root.querySelector('.sac-main'),'clientHeight',{value:240});
  Object.defineProperty(area,'getBoundingClientRect',{value:()=>({height:parseFloat(area.style.height)||38})});
  const resized:number[]=[];
  let cssLimit=70;
  const originalGetComputedStyle=dom.window.getComputedStyle.bind(dom.window);
  dom.window.getComputedStyle=((element:Element)=>({ maxHeight:`${cssLimit}px` }) as CSSStyleDeclaration) as typeof dom.window.getComputedStyle;
  let cleanup=bindComposerResize(root,{initialHeight:180,onResize:height=>resized.push(height)});
  assert.equal(area.style.height,'70px');
  assert.equal(resized.length,0,'a narrow viewport must not replace the saved room preference');
  grip.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
  assert.equal(area.style.height,'70px');
  assert.equal(resized.length,0,'an arrow against the narrow limit must not replace the saved preference');
  cleanup();cssLimit=240;
  cleanup=bindComposerResize(root,{initialHeight:180,onResize:height=>resized.push(height)});
  assert.equal(area.style.height,'180px','a taller viewport restores the saved preference');
  grip.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
  assert.deepEqual(resized,[168]);
  cleanup();dom.window.getComputedStyle=originalGetComputedStyle;dom.window.close();
});
