import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {WorkController} from '../src/work/controller.ts';
import {WorkQuickPicker} from '../src/work/quick-picker.ts';
import {createChatShell} from '../src/ui.ts';
const tick=()=>new Promise(r=>setTimeout(r,0));
function taskFixture(reader:()=>Promise<any>){
 const dom=new JSDOM(`<body><main id="editor"></main>${createChatShell()}</body>`),root=dom.window.document.querySelector<HTMLElement>('.sac')!;
 const controller=new WorkController({host:{} as any,store:{} as any,service:{} as any,taskReader:{listRecent:reader} as any,
  currentDocumentId:()=>'',currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,
  openDocument:async()=>{},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:()=>{}});
 controller.attach(root);return {controller,dom,root,close(){controller.detach();dom.window.close();}};
}

test('任务菜单分隔标题与文档信息，默认收起新建关联并能明确关闭',async()=>{
 const f=taskFixture(async()=>({kind:'found',value:[
  {id:'linked-task',title:'核对虚构项目记录与下一步行动安排',documentId:'20261009120000-aaaaaaa',completed:false},
  {id:'unlinked-task',title:'整理虚构待办',documentId:null,completed:false},
 ]}));try{
  const options=(f.controller as any).options;
  options.host.getDocumentTitle=async()=>'虚构记录文档';options.onCreateTask=async()=>{};options.onLinkTask=async()=>{};options.onOpenPage=()=>{};
  (f.controller as any).workId='20261009120001-bbbbbbb';
  const button=f.root.querySelector<HTMLButtonElement>('[data-work-action="recent-tasks"]')!,menu=f.root.querySelector<HTMLElement>('[data-recent-task-menu]')!;
  button.click();await tick();
  const rows=menu.querySelectorAll('article');assert.equal(rows.length,2,'每项任务应有独立列表行');
  assert.equal(rows[0].querySelector('strong')?.textContent,'核对虚构项目记录与下一步行动安排');
  assert.equal(rows[0].querySelector('small')?.textContent,'文档：虚构记录文档');
  assert.equal(rows[1].querySelector('small')?.textContent,'没有关联文档');assert.equal(rows[1].querySelector('button'),null);
  const actions=menu.querySelector<HTMLDetailsElement>('.sac-task-menu-actions');assert.ok(actions);assert.equal(actions.open,false);
  assert.ok(actions.querySelector('[data-work-action="create-task"]'));assert.ok(actions.querySelector('[data-work-action="link-task"]'));
  assert.ok(menu.querySelector('[data-work-action="manage-tasks"]'));
  const close=menu.querySelector<HTMLButtonElement>('[data-work-action="close-tasks"]');assert.ok(close);close.click();
  assert.equal(menu.hidden,true);assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(f.dom.window.document.activeElement,button);
 }finally{f.close();}
});

test('task menu search uses native matches, preserves focus and discards late or dismissed results',async()=>{
  let release!:(v:any)=>void;const f=taskFixture(async()=>({kind:'found',value:[{id:'recent',title:'最近任务'}]}));
  try{
    (f.controller as any).options.taskReader.search=async(q:string)=>q==='旧'?new Promise(r=>release=r):{kind:'found',value:[{id:'older',title:'搜索匹配任务'}]};
    f.root.querySelector<HTMLButtonElement>('[data-work-action="recent-tasks"]')!.click();await tick();
    const input=f.root.querySelector<HTMLInputElement>('[data-recent-task-search]');assert.ok(input);input.focus();
    input.value='旧';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));
    input.value='新';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));release({kind:'found',value:[{id:'late',title:'迟到任务'}]});await tick();
    assert.equal(f.root.querySelector('[data-recent-task-search]'),input);assert.equal(f.dom.window.document.activeElement,input);
    assert.ok(f.root.querySelector('[data-recent-task-menu] [data-task-id="older"]'));assert.equal(f.root.querySelector('[data-recent-task-menu] [data-task-id="late"]'),null);
    input.value='旧';input.dispatchEvent(new f.dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));f.dom.window.document.body.click();release({kind:'found',value:[{id:'hidden',title:'收起后迟到'}]});await tick();
    assert.equal(f.root.querySelector<HTMLElement>('[data-recent-task-menu]')!.hidden,true);assert.equal(f.root.querySelector('[data-task-id="hidden"]'),null);
  }finally{f.close();}
});
test('task menu dismisses on an outside editor click even when the editor stops bubbling',async()=>{
 const f=taskFixture(async()=>({kind:'found',value:[]}));try{
  const button=f.root.querySelector<HTMLButtonElement>('[data-work-action="recent-tasks"]')!,menu=f.root.querySelector<HTMLElement>('[data-recent-task-menu]')!;
  button.click();await tick();assert.equal(menu.hidden,false);
  menu.dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));assert.equal(menu.hidden,false);
  const editor=f.dom.window.document.querySelector<HTMLElement>('#editor')!;editor.addEventListener('pointerdown',e=>e.stopPropagation());
  editor.dispatchEvent(new f.dom.window.Event('pointerdown',{bubbles:true}));assert.equal(menu.hidden,true);assert.equal(button.getAttribute('aria-expanded'),'false');
  button.click();await tick();f.dom.window.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(menu.hidden,true);
 }finally{f.close();}
});
test('task loading cannot reopen a dismissed menu and detached listeners no longer handle clicks',async()=>{
 let release!:(v:any)=>void;const f=taskFixture(()=>new Promise(r=>{release=r;}));try{
  const button=f.root.querySelector<HTMLButtonElement>('[data-work-action="recent-tasks"]')!,menu=f.root.querySelector<HTMLElement>('[data-recent-task-menu]')!;
  button.click();f.dom.window.document.body.click();assert.equal(menu.hidden,true);
  release({kind:'found',value:[{id:'late',title:'迟到任务',completed:false}]});await tick();assert.equal(menu.hidden,true);
  f.controller.detachRoot(f.root);menu.hidden=false;f.dom.window.document.body.click();assert.equal(menu.hidden,false);
 }finally{f.close();}
});
test('Work menu also handles captured editor pointer events and programmatic outside clicks',async()=>{
 const dom=new JSDOM(`<body><main id="editor"></main>${createChatShell()}</body>`),root=dom.window.document.querySelector<HTMLElement>('.sac')!;
 const view=new WorkQuickPicker(root,{load:async()=>[],currentDocument:()=>null,currentWork:()=>null,enter:async()=>{},link:async()=>{},create:async()=>{},browse:()=>{},status:()=>{},confirm:()=>false});
 const button=root.querySelector<HTMLButtonElement>('[data-action="work-picker"]')!,menu=root.querySelector<HTMLElement>('[data-work-quick-menu]')!;
 button.click();await tick();const editor=dom.window.document.querySelector<HTMLElement>('#editor')!;editor.addEventListener('pointerdown',e=>e.stopPropagation());
 editor.dispatchEvent(new dom.window.Event('pointerdown',{bubbles:true}));assert.equal(menu.hidden,true);
 button.click();await tick();dom.window.document.body.click();assert.equal(menu.hidden,true);view.dispose();dom.window.close();
});
