import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import Module from 'node:module';
const W='20260929120000-aaaaaaa',OTHER='20260929120001-aaaaaaa';
async function fixture(){
 const dom=new JSDOM('<!doctype html><html><body><div id="dock"></div><div id="other"></div></body></html>');
 Object.assign(globalThis,{document:dom.window.document,window:dom.window,MutationObserver:dom.window.MutationObserver});
 dom.window.confirm=()=>false;
 const original=(Module as any)._load;
 (Module as any)._load=function(request:string,parent:any,isMain:boolean){if(request==='siyuan')return {Plugin:class{},getAllEditor:()=>[],openTab:async()=>{}};return original.call(this,request,parent,isMain);};
 const require=createRequire(import.meta.url);delete require.cache[require.resolve('../dist/index.js')];let C:any;try{C=require('../dist/index.js').default;}finally{(Module as any)._load=original;}
 const p:any=new C();const data=new Map();p.loadData=async(k:string)=>data.get(k);p.saveData=async(k:string,v:any)=>{data.set(k,structuredClone(v));};
 p.currentDocumentId=()=>p.workController.workId||W;p.currentFocusBlockId=()=>null;p.workController.refreshFromEditor=async()=>{};
 p.workHost.getDocumentTitle=async(id:string)=>id===W?'当前工作':'其他工作';p.workHost.listDescendantDocuments=async()=>[];p.workService.listExternalDocuments=async()=>[];p.workService.readWork=async(id:string)=>({id,title:'工作',goal:'目标',status:'active'});
 p.workController.workId=W;p.workController.documentId=W;await p.workStore.registerWork(W);await p.workStore.registerWork(OTHER);
 const root=dom.window.document.querySelector<HTMLElement>('#dock')!;p.render(root);await p.onWorkChanged(W);
 return {p,dom,root,data,close(){for(const r of [...p.roomViews.keys()])p.disposeRoomView(r);p.workController.detach();dom.window.close();}};
}
const tick=()=>new Promise(r=>setTimeout(r,15));


test('Task2 streaming keeps completed message DOM selection and selector stable without room reads',async()=>{
 const f=await fixture();try{const {p,root,dom}=f;const t=p.ensureThread();t.messages=[{id:'old',role:'assistant',content:'可选择的旧回复',references:[],status:'complete'},{id:'live',role:'assistant',content:'第一段',references:[]}];p.renderChatViews(root);await tick();const old=root.querySelector('.sac-message')!;const text=old.querySelector('.sac-message-body')!.firstChild!;const range=dom.window.document.createRange();range.selectNodeContents(text);dom.window.getSelection()!.addRange(range);const option=root.querySelector('option');let reads=0;p.roomStore.listForWork=async()=>{reads++;return [];};t.messages[1].content+='第二段';p.renderChatViews(root);await tick();assert.equal(root.querySelector('.sac-message'),old);assert.equal(dom.window.getSelection()!.toString(),'可选择的旧回复');assert.equal(root.querySelector('option'),option);assert.equal(reads,0);
 }finally{f.close();}
});
test('Task2 background reply respects scroll position and exposes return to newest',async()=>{
 const f=await fixture();try{const {p,root,dom}=f;const t=p.ensureThread();t.messages=[{id:'old',role:'assistant',content:'旧回复',references:[],status:'complete'}];p.renderMessages(root);const area=root.querySelector<HTMLElement>('[data-messages]')!;Object.defineProperties(area,{clientHeight:{value:100},scrollHeight:{get:()=>600,configurable:true}});area.scrollTop=80;area.dispatchEvent(new dom.window.Event('scroll'));t.messages.push({id:'new',role:'assistant',content:'新回复',references:[]});p.renderMessages(root);assert.equal(area.scrollTop,80);const jump=root.querySelector<HTMLButtonElement>('[data-message-latest]')!;assert.ok(jump&&!jump.hidden);jump.click();assert.equal(area.scrollTop,600);assert.equal(jump.hidden,true);
 }finally{f.close();}
});

import {renderMessageMarkup} from '../src/ui.ts';
test('Task2 native Markdown headings code and reply copy are readable and safe',async()=>{
 const dom=new JSDOM('<!doctype html><body></body>');const doc=dom.window.document;let instances=0;(dom.window as any).Lute={New(){instances++;return {MarkdownStr:()=>'<h2>标题</h2><p><a href="javascript:alert(1)" onclick="alert(1)">危险链接</a><a href="https://example.test">正常链接</a><img src="https://remote.test/image.png" alt="图示"><script>alert(1)</script><iframe src="https://remote.test"></iframe></p><pre><code>const x = &lt;div&gt;;\n</code></pre><table><tbody><tr><td>内容</td></tr></tbody></table>'};}};const content='## 标题\n\n代码原文';doc.body.innerHTML=(renderMessageMarkup as any)({id:'md',role:'assistant',content,references:[]},doc);assert.ok(doc.querySelector('h2'));assert.equal(doc.querySelectorAll('script,iframe,img').length,0);assert.equal(doc.querySelector('a')!.getAttribute('href'),null);assert.equal(doc.querySelector('[onclick]'),null);assert.equal(doc.querySelector('pre code')!.textContent,'const x = <div>;\n');assert.ok(doc.querySelector('[data-copy-reply]'));assert.ok(doc.querySelector('[data-copy-code]'));assert.equal(instances,1);dom.window.close();
});

test('Task2 summary includes references with explicit selected documents and pins remain standby',async()=>{const f=await fixture();try{const {p,root}=f;p.workController.restoreContext({mode:'none',documentIds:[W]});await p.workController.renderAll();const ref={id:'ref-summary',documentRootId:W,blockId:'20260929120002-aaaaaaa',documentTitle:'引用来源',selectedText:'摘录'};p.references.add(ref);p.renderReferences(root);const summary=root.querySelector('[data-context-details] > summary')!;assert.match(summary.textContent||'',/引用 1 项/);assert.match(summary.textContent||'',/明确勾选 1 篇/);assert.match(root.querySelector('[data-work-panel]')!.textContent||'',/待选资料.*不会自动发送/);p.references.remove(ref.id);p.renderReferences(root);assert.match(summary.textContent||'',/引用 0 项/);}finally{f.close();}});

test('Task2 native Lute receives both document name and Markdown text',()=>{const dom=new JSDOM('<body></body>');(dom.window as any).Lute={New:()=>({MarkdownStr:(_name:string,text:string)=>text==='## 核对签名'?'<h2>核对签名</h2>':'<p>undefined</p>'})};dom.window.document.body.innerHTML=(renderMessageMarkup as any)({role:'assistant',content:'## 核对签名',references:[]},dom.window.document);assert.equal(dom.window.document.querySelector('h2')?.textContent,'核对签名');dom.window.close();});

import {MessageRenderer} from '../src/message-renderer.ts';
test('Task2 fix1 returning to a stored reading position exposes latest when newer messages exist',()=>{const dom=new JSDOM('<div><main></main></div>');const area=dom.window.document.querySelector('main')!;const renderer=new MessageRenderer<any>(area,renderMessageMarkup);const old={id:'old',role:'assistant',content:'A原消息',references:[],status:'complete'};renderer.render('A',[old]);Object.defineProperties(area,{clientHeight:{value:100},scrollHeight:{get:()=>550}});area.scrollTop=80;area.dispatchEvent(new dom.window.Event('scroll'));renderer.render('B',[{...old,id:'other',content:'B消息'}]);renderer.render('A',[old,{...old,id:'new',content:'A新消息'}]);assert.equal(area.scrollTop,80);assert.equal(area.parentElement!.querySelector<HTMLButtonElement>('[data-message-latest]')!.hidden,false);renderer.dispose();dom.window.close();});
test('Task2 fix1 raw PRE code copies its visible text without the action label',async()=>{const dom=new JSDOM('<div><main></main></div>');const copied:string[]=[];Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async(text:string)=>{copied.push(text);}}});(dom.window as any).Lute={New:()=>({MarkdownStr:()=>'<pre>raw code &lt;safe&gt;\nline two</pre>'})};const renderer=new MessageRenderer<any>(dom.window.document.querySelector('main')!,renderMessageMarkup);renderer.render('raw-pre',[{id:'raw',role:'assistant',content:'<pre>raw code &lt;safe&gt;\nline two</pre>',references:[]}]);dom.window.document.querySelector<HTMLButtonElement>('[data-copy-code]')!.click();await tick();assert.deepEqual(copied,['raw code <safe>\nline two']);assert.equal(dom.window.document.querySelector('[data-copy-code]')!.textContent,'已复制');renderer.dispose();dom.window.close();});
