import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourcePath = new URL('../src/index.ts', import.meta.url);

function method(source: string, start: string, end: string): string {
  return source.match(new RegExp(`private ${start}[\\s\\S]*?private ${end}`))?.[0] || '';
}

test('protocol document identity never uses a UI placeholder and reconnect uses connection capability', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const currentDocumentId = method(source, 'currentDocumentId', 'ensureThread');
  const sync = method(source, 'async syncHermesSessions', 'async loadThreadMessages');
  assert.doesNotMatch(currentDocumentId, /未识别文档/);
  assert.match(currentDocumentId, /\|\|\s*''/);
  assert.match(sync, /listConnections\(\)/);
  assert.doesNotMatch(sync, /syncDocumentSessions|listSessions\(/);
  assert.match(source, /请先打开一个思源文档/);
});

test('each send refreshes selected context, freezes Work and Chat, and keeps write-root validation', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const send = method(source, 'async send', 'async accept');
  const snapshot = method(source, 'async takeSnapshot', 'setGenerating');
  const context = method(source, 'async prepareRequestSnapshot', 'setGenerating');
  const accept = method(source, 'async accept', 'async readBlockMarkdown');
  const currentEditor = method(source, 'currentEditor', 'currentDocumentId');
  assert.match(send, /await this\.prepareRequestSnapshot\(root,documentRootId,choice,refs\)/);
  assert.match(send, /freezeRequest\(/);
  assert.match(context, /await this\.takeSnapshot\(root\)/);
  assert.match(context, /getDocumentMarkdown/);
  assert.match(accept, /applyApprovedProposal\(proposal/);
  assert.match(snapshot, /this\.currentEditor\(\)/);
  assert.match(currentEditor, /selectActiveEditor\(\{document,editors:getAllEditor\(\)\}\)/);
  assert.doesNotMatch(source, /getAllEditor\(\)\s*\[\s*0\s*\]/);
});

import {fixture,tick,W} from './shared-ui-fixture.ts';
test('shared association saves only and explicit open reads local UUID history',async()=>{
 const f=await fixture(),originalFetch=globalThis.fetch;
 try{
  const original=f.p.activeThreadId,draft=f.input.value,reads:string[]=[];let binds=0;
  f.p.bridgeClient=(documentRootId:string)=>({
   listCandidates:async()=>({data:[{id:'remote-existing',title:'Fictional conversation'}]}),
   bindChat:async(chatId:string,connectionId:string,storedSessionId:string,title:string)=>{
    binds++;return {chat:{chatId,connectionId,storedSessionId,title,documentRootId,kind:'serve',profile:'default',installId:'fictional-install',state:'ready'}};
   },
  });
  globalThis.fetch=async(url,init)=>{reads.push(String(url));return Response.json({data:[{role:'assistant',content:'fictional history'}]});};
  await f.p.associateStudio(f.root);
  assert.equal(binds,0);assert.deepEqual(reads,[],'candidate listing must not read history');
  const picker=f.doc.querySelector<HTMLElement>('.sac-studio-picker')!;
  assert.equal(picker.parentElement,f.root.querySelector('[data-chat-menu-anchor]'));
  const radio=picker.querySelector<HTMLInputElement>('[data-studio-options] input')!;
  radio.checked=true;radio.dispatchEvent(new f.dom.window.Event('change'));
  await (picker.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick as any)();
  assert.equal(binds,1);assert.deepEqual(reads,[]);assert.equal(f.p.activeThreadId,original);assert.equal(f.input.value,draft);
  const [saved]=await f.p.workStore.listChats(W);assert.ok(saved);assert.notEqual(saved.chatId,saved.storedSessionId);assert.equal(saved.storedSessionId,'remote-existing');assert.equal(saved.documentRootId,W);
  f.root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.click();await tick();
  assert.deepEqual(reads,[`http://127.0.0.1:8782/chats/${saved.chatId}/messages`]);assert.equal(f.p.activeThreadId,saved.chatId);assert.match(f.root.querySelector('[data-messages]')!.textContent||'',/fictional history/);
 }finally{globalThis.fetch=originalFetch;f.close();}
});
test('shared association refuses changed frozen document before binding',async()=>{
 const f=await fixture();try{
  let binds=0;f.p.bridgeClient=()=>({listCandidates:async()=>({data:[{id:'remote-existing',title:'Fictional conversation'}]}),bindChat:async()=>{binds++;throw Error('must not bind');}});
  await f.p.associateStudio(f.root);
  const radio=f.doc.querySelector<HTMLInputElement>('[data-studio-options] input')!;radio.dispatchEvent(new f.dom.window.Event('change'));
  f.setDocument('20261008120009-ccccccc');
  await (f.doc.querySelector<HTMLButtonElement>('[data-studio-confirm]')!.onclick as any)();
  assert.equal(binds,0);assert.deepEqual(await f.p.workStore.listChats(W),[]);assert.equal(f.input.value,'原 Chat 草稿');
 }finally{f.close();}
});
