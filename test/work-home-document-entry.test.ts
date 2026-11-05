import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WorkPage } from '../src/work/page.ts';
import { WorkController } from '../src/work/controller.ts';
import { WorkStore } from '../src/work/store.ts';

const A='20261022120000-aaaaaaa', B='20261022120001-bbbbbbb', BLOCK='20261022120002-ccccccc';
const tick=()=>new Promise(r=>setTimeout(r,0));
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};};
async function fixture(){
 const dom=new JSDOM('<main></main>');let editor=A,current=true,busy=false,pending=false;
 const opened:{id:string;focus:string|null}[]=[],changed:(string|null)[]=[],writes:string[]=[];
 const data=new Map<string,unknown>();
 const store=new WorkStore({loadData:async key=>data.get(key),saveData:async(key,value)=>{data.set(key,structuredClone(value));writes.push(key);}});
 // Existing storage initializes once before Home is used; retain its read-back behavior in this fixture.
 await store.listWorks();writes.length=0;
 const host:any={getDocumentPath:async(id:string)=>`/${id}.sy`,getDocumentRoot:async()=>A,getDocumentTitle:async()=> '虚构文档',getAttrs:async()=>({}),listDescendantDocuments:async()=>[]};
 const options:any={host,store,service:{readWork:async()=>null,listExternalDocuments:async()=>[]},taskReader:{},currentDocumentId:()=>editor,currentFocusBlockId:()=>null,currentChatId:()=> 'original-chat',isBusy:()=>busy,canBrowseDocuments:()=>true,hasPendingWrite:()=>pending,openDocument:async(id:string,focus:string|null)=>{opened.push({id,focus});editor=id;await controller.refreshFromEditor();},onWorkChanged:async(id:string|null)=>{changed.push(id);},onLinkCurrentChat:async()=>{},status:()=>{}};
 const controller=new WorkController(options);await controller.refreshDocument(A);
 const root=dom.window.document.querySelector('main')!;
 const context={documentId:A,title:'已捕获的虚构文档',focusBlockId:BLOCK};
 const actions:any={enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>assert.fail('entry cannot create Work'),linkDocument:async()=>assert.fail('entry cannot link documents'),startDocument:async(c:any,isCurrent:()=>boolean)=>controller.openDocumentFromPage(c.documentId,c.focusBlockId,isCurrent)};
 const page=new WorkPage(root,{context,catalog:{load:async()=>({works:[],continueWorks:[],recentTasks:{kind:'found',value:[]}})},actions});await page.refresh();
 return {controller,page,root,dom,host,options,opened,changed,writes,context,current:()=>current,setCurrent:(v:boolean)=>current=v,setEditor:(id:string)=>editor=id,setBusy:(v:boolean)=>busy=v,setPending:(v:boolean)=>pending=v,close(){page.dispose();controller.detach();dom.window.close();}};
}
test('zero Work Home opens the displayed frozen document after a background editor change without changing context or relations',async()=>{
 const f=await fixture();try{
  f.controller.restoreContext({mode:'none',documentIds:[B]});const before=f.controller.contextChoice;const changed=[...f.changed];f.setEditor(B);await f.page.refresh();
  assert.match(f.root.textContent||'',/已捕获的虚构文档/);const button=f.root.querySelector<HTMLButtonElement>('[data-page-action="start-document"]');assert.ok(button);assert.equal(button.textContent,'在这篇文档开始');button.click();await tick();
  assert.deepEqual(f.opened,[{id:A,focus:BLOCK}]);assert.deepEqual(f.controller.contextChoice,before);assert.deepEqual(f.changed,changed);assert.deepEqual(f.writes,[]);assert.equal(f.controller.currentWorkId,null);
 }finally{f.close();}
});
for(const context of [null,{documentId:'not-a-document',title:'无效',focusBlockId:null}])test('Home has guidance and no executable document entry for '+JSON.stringify(context),async()=>{
 const f=await fixture();try{f.page.setContext(context);assert.equal(f.root.querySelector('[data-page-action="start-document"]'),null);assert.match(f.root.textContent||'',/先打开一篇文档/);}finally{f.close();}
});
test('deleted captured document is reported and does not open or mutate the scene',async()=>{
 const f=await fixture();try{f.host.getDocumentPath=async()=>null;await assert.rejects(f.controller.openDocumentFromPage(A,null,f.current),/不存在|读取/);assert.deepEqual(f.opened,[]);assert.equal(f.controller.currentDocumentId,A);assert.deepEqual(f.writes,[]);}finally{f.close();}
});
for(const invalidation of ['page','route','context'] as const)test('late existence read respects invalidated '+invalidation,async()=>{
 const f=await fixture();const delayed=gate();try{
  let reading=false;f.host.getDocumentPath=async()=>{reading=true;await delayed.promise;return `/${A}.sy`;};const button=f.root.querySelector<HTMLButtonElement>('[data-page-action="start-document"]');assert.ok(button);button.click();await tick();assert.equal(reading,true);
  if(invalidation==='page')f.page.dispose();else if(invalidation==='route')f.page.show({kind:'list'});else f.page.setContext({documentId:B,title:'新场景',focusBlockId:null});
  delayed.release();await tick();assert.deepEqual(f.opened,[]);assert.equal(f.root.querySelector('.sac-page-notice'),null);assert.deepEqual(f.writes,[]);
 }finally{delayed.release();f.close();}
});
for(const root of [A,B,null])test('optional focus opens only a block belonging to the displayed document: '+root,async()=>{
 const f=await fixture();try{f.host.getDocumentRoot=async()=>root;await f.controller.openDocumentFromPage(A,BLOCK,f.current);assert.deepEqual(f.opened,[{id:A,focus:root===A?BLOCK:null}]);}finally{f.close();}
});
test('waiting reply permits document browsing while original scene and selected materials remain frozen',async()=>{
 const f=await fixture();try{f.setBusy(true);f.controller.restoreContext({mode:'selection',documentIds:[A]});const before=f.controller.contextChoice;const changed=[...f.changed];await f.controller.openDocumentFromPage(B,null,f.current);assert.deepEqual(f.opened,[{id:B,focus:null}]);assert.equal(f.controller.activeDocumentId,A);assert.deepEqual(f.changed,changed);assert.deepEqual(f.controller.contextChoice,before);assert.deepEqual(f.writes,[]);}finally{f.close();}
});
for(const blocked of ['preparing','settings','accepting','pending'] as const)test('document entry blocks '+blocked+' before native opening',async()=>{
 const f=await fixture();try{if(blocked==='pending')f.setPending(true);else{f.setBusy(true);f.options.canBrowseDocuments=()=>false;}await assert.rejects(f.controller.openDocumentFromPage(B,null,f.current),/生成|待处理/);assert.deepEqual(f.opened,[]);assert.equal(f.controller.currentDocumentId,A);assert.deepEqual(f.writes,[]);}finally{f.close();}
});
test('document entry rechecks busy protection after delayed existence lookup',async()=>{
 const f=await fixture();const delayed=gate();try{f.host.getDocumentPath=async()=>{await delayed.promise;return `/${B}.sy`;};const opening=f.controller.openDocumentFromPage(B,null,f.current);f.setPending(true);delayed.release();await assert.rejects(opening,/生成|待处理/);assert.deepEqual(f.opened,[]);}finally{delayed.release();f.close();}
});
test('invalid page and invalid document IDs never reach native navigation',async()=>{
 const f=await fixture();try{f.setCurrent(false);await assert.rejects(f.controller.openDocumentFromPage(A,null,f.current),/页面|变化/);f.setCurrent(true);await assert.rejects(f.controller.openDocumentFromPage('invalid',null,f.current),/文档/);assert.deepEqual(f.opened,[]);}finally{f.close();}
});
