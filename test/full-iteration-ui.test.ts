import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createChatShell,renderMessageMarkup} from '../src/ui.ts';
import {DocumentAssociationPanel} from '../src/work/document-panel.ts';

test('knowledge is a separate dock view and preserves chat nodes without reading task associations',()=>{
 const dom=new JSDOM(`<body>${createChatShell()}</body>`),root=dom.window.document.querySelector<HTMLElement>('.sac')!;
 let reads=0;const panel=new DocumentAssociationPanel(root,{currentDocument:()=>null,documentTitle:async()=>'',loadWorks:async()=>{reads++;return [];},listTaskLinks:async()=>[],searchTasks:async()=>({kind:'found',value:[]}),linkWork:async()=>{},linkTask:async()=>{},unlinkTask:async()=>{},editTask:async()=>'',openWork:()=>{},createWork:async()=>{},confirm:()=>false});
 try{const input=root.querySelector('textarea')!;input.value='保留草稿';root.querySelector('[data-messages]')!.textContent='原历史';
  const button=root.querySelector<HTMLButtonElement>('[data-dock-tab="knowledge"]');assert.ok(button);button.click();
  assert.equal(root.dataset.dockView,'knowledge');assert.equal((root.querySelector('[data-document-associations]') as HTMLElement).hidden,true);assert.equal(reads,0);
  root.querySelector<HTMLButtonElement>('[data-dock-tab="chat"]')!.click();assert.equal(root.querySelector('textarea'),input);assert.equal(input.value,'保留草稿');assert.equal(root.querySelector('[data-messages]')!.textContent,'原历史');
 }finally{panel.dispose();dom.window.close();}
});
test('only explicitly enabled ordinary complete answers expose document and task workflows',()=>{
 for(const role of ['user','assistant'] as const)for(const status of [undefined,'waiting','cancelled','error','complete'])for(const enabled of [true,false]){
  const dom=new JSDOM(renderMessageMarkup({role,status,content:'虚构回答',references:[],workflowActions:enabled} as any));
  const expected=role==='assistant'&&status==='complete'&&enabled;
  assert.equal(Boolean(dom.window.document.querySelector('[data-message-action="adopt"]')),expected);
  assert.equal(Boolean(dom.window.document.querySelector('[data-message-action="task-draft"]')),expected);dom.window.close();
 }
 const empty=new JSDOM(renderMessageMarkup({role:'assistant',status:'complete',content:' ',references:[],workflowActions:true} as any));assert.equal(empty.window.document.querySelector('[data-message-action]'),null);empty.window.close();
});
