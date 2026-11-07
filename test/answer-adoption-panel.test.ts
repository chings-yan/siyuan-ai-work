import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {setImmediate,setTimeout as delay} from 'node:timers/promises';
import {AnswerAdoptionPanel} from '../src/work/answer-actions.ts';import {AnswerAdoptionController,type AdoptionSource,type AdoptionNative} from '../src/work/answer-adoption.ts';import{WorkStore}from'../src/work/store.ts';
const source:AdoptionSource={conversationKey:'exact-synthetic',messageId:'remote-message',role:'assistant',complete:true,content:'<img onerror="attack()">完整回答',documentId:'20990101000000-aaaaaaa'};
function fixture(){const dom=new JSDOM('<button id="origin">采纳</button><main></main>'),doc=dom.window.document,container=doc.querySelector('main')!;doc.querySelector<HTMLButtonElement>('#origin')!.focus();const values=new Map<string,unknown>();let writes=0,lose=false,current=true;const copied:string[]=[];
 const storage={loadData:(k:string)=>values.get(k),saveData:(k:string,v:unknown)=>{values.set(k,structuredClone(v));}};
 const native:AdoptionNative={prepare:async(content,target,operationId)=>({operationId,target,preview:`最终预览：${content}`,dom:'safe',markdown:'safe',proof:{canonicalDigest:'a'.repeat(64),topIds:['20990101000001-bbbbbbb'],blocks:[{id:'20990101000001-bbbbbbb',ids:['20990101000001-bbbbbbb'],digest:'a'.repeat(64)}],root:null}}),checkTarget:async()=>{},write:async()=>{writes++;if(lose)throw Error('lost');return{rootId:source.documentId};},verify:async()=>({rootId:source.documentId})};
 const controller=new AnswerAdoptionController({storage,pendingStore:new WorkStore(storage),native,isCurrent:()=>current});
 const opts={controller,source,target:{documentId:source.documentId,title:'<script>目标</script>'},listNotebooks:async()=>[{id:'20990101000002-ccccccc',name:'虚构笔记本'}],copyText:async(s:string)=>{copied.push(s);},isCurrent:()=>current};const panel=new AnswerAdoptionPanel(container,opts);
 const button=(action:string)=>container.querySelector<HTMLButtonElement>(`[data-adoption-action="${action}"]`)!;
 return{dom,doc,container,controller,panel,opts,button,copied,native,writes:()=>writes,setLose:(v:boolean)=>lose=v,setCurrent:(v:boolean)=>current=v,close:()=>{panel.dispose();dom.window.close();}};
}
const settle=async(container:HTMLElement)=>{
 await setImmediate();const deadline=Date.now()+1000;
 while(container.querySelector<HTMLButtonElement>('[data-adoption-action="close"]')?.disabled){assert.ok(Date.now()<deadline,'采纳面板必须完成当前操作');await delay(5);}
};
test('adoption panel shows frozen source and explicit target, then exact final preview before confirmation',async()=>{const f=fixture();try{
 await settle(f.container);assert.equal(f.writes(),0);assert.equal(f.container.querySelector('img,script'),null);assert.match(f.container.textContent!,/目标/);assert.equal(f.button('confirm'),null);
 f.button('prepare').click();await settle(f.container);assert.match(f.container.querySelector('[data-adoption-preview]')!.textContent!,/^最终预览/);assert.equal(f.writes(),0);
 f.button('confirm').click();await settle(f.container);assert.equal(f.writes(),1);assert.match(f.container.textContent!,/已采纳/);assert.equal(f.button('confirm'),null);
 }finally{f.close();}});
test('unknown result exposes only read-only review, copy and close; reload recovery is accessible',async()=>{const f=fixture();try{
 f.setLose(true);f.button('prepare').click();await settle(f.container);f.button('confirm').click();await settle(f.container);assert.equal(f.writes(),1);assert.equal(f.button('confirm'),null);assert.equal(f.button('prepare'),null);assert.ok(f.button('review'));
 f.panel.dispose();new AnswerAdoptionPanel(f.container,{...f.opts,source:undefined,target:undefined});await settle(f.container);assert.ok(f.button('review'));f.button('review').click();await settle(f.container);assert.equal(f.writes(),1);assert.match(f.container.textContent!,/核验|已采纳/);
 }finally{f.close();}});
test('stale scene and disposed panel cannot start writes; copying keeps exact original text',async()=>{const f=fixture();try{
 f.button('copy').click();await settle(f.container);assert.deepEqual(f.copied,[source.content]);f.button('prepare').click();await settle(f.container);f.setCurrent(false);f.button('confirm').click();await settle(f.container);assert.equal(f.writes(),0);assert.match(f.container.textContent!,/变化|失效/);
 f.panel.dispose();assert.equal(f.doc.activeElement?.id,'origin');assert.equal(f.container.children.length,0);
 }finally{f.close();}});
test('new note is explicit and changing target invalidates a prior preview',async()=>{const f=fixture();try{
 f.button('prepare').click();await settle(f.container);const choice=f.container.querySelector<HTMLSelectElement>('[data-adoption-target]')!;choice.value='note';choice.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await settle(f.container);assert.equal(f.button('confirm'),null);assert.ok(f.container.querySelector('[data-adoption-notebook]'));assert.equal(f.writes(),0);
 }finally{f.close();}});
test('disposing a background panel never steals focus from the current editor',async()=>{const f=fixture();try{
 const editor=f.doc.createElement('textarea');f.doc.body.append(editor);editor.focus();await settle(f.container);assert.equal(f.doc.activeElement,editor);f.panel.dispose();assert.equal(f.doc.activeElement,editor);
 }finally{f.close();}});

test('preview stays busy while its actual conversion is unresolved, regardless of event-loop turns',async()=>{const f=fixture();try{
 const prepare=f.native.prepare;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.native.prepare=async(...args)=>{await gate;return prepare(...args);};
 f.button('prepare').click();for(let i=0;i<20;i++)await setImmediate();assert.equal(f.button('confirm'),null);assert.equal(f.button('close').disabled,true);assert.equal(f.writes(),0);
 release();await settle(f.container);assert.ok(f.button('confirm'));assert.equal(f.writes(),0);
 }finally{f.close();}});
test('M1: changing format or target preserves keyboard focus on the replacement control',async()=>{const f=fixture();try{
 await settle(f.container);
 for(const [attribute,value] of [['data-adoption-mode','plain'],['data-adoption-target','note']]){
  const select=f.container.querySelector<HTMLSelectElement>(`[${attribute}]`)!;select.focus();select.value=value;select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await settle(f.container);
  const replacement=f.container.querySelector<HTMLSelectElement>(`[${attribute}]`)!;assert.equal(f.doc.activeElement,replacement);assert.equal(replacement.value,value);assert.equal(f.writes(),0);
 }
 }finally{f.close();}});
