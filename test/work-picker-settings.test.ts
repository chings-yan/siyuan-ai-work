import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WorkQuickPicker } from '../src/work/quick-picker.ts';
import { SettingsDialog } from '../src/work/settings-dialog.ts';
import type { BridgeInspection } from '../src/work/connection-settings.ts';
import { createChatShell } from '../src/ui.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('dock Work control opens a local menu; entering and linking are distinct actions', async () => {
  const dom = new JSDOM(`<!doctype html><body>${createChatShell()}</body>`);
  const root = dom.window.document.querySelector<HTMLElement>('.sac')!;
  const input = root.querySelector<HTMLTextAreaElement>('textarea')!;
  input.value = '保留草稿';
  const entered: string[] = [], linked: string[] = [];
  let browsed = 0;
  const picker = new WorkQuickPicker(root, {
    load: async () => [{id:'20260929120000-aaaaaaa',title:'季度培训复盘',goal:'形成行动方案',status:'active'}],
    currentDocument: () => ({id:'20260929120001-aaaaaaa',title:'培训访谈记录'}),
    currentWork: () => null,
    enter: async id => {entered.push(id);},
    link: async (id, doc) => {linked.push(`${id}:${doc.id}`);},
    create: async () => {},
    browse: () => {browsed++;},
    status: () => {},
    confirm: () => true,
  });
  root.querySelector<HTMLButtonElement>('[data-action="work-picker"]')!.click();
  await tick();
  assert.equal(browsed, 0);
  assert.equal(root.querySelector<HTMLElement>('[data-work-quick-menu]')!.hidden, false);
  assert.match(root.querySelector('[data-work-quick-menu]')!.textContent||'', /季度培训复盘/);
  root.querySelector<HTMLButtonElement>('[data-quick-action="link"]')!.click();
  await tick();
  assert.deepEqual(linked, ['20260929120000-aaaaaaa:20260929120001-aaaaaaa']);
  assert.deepEqual(entered, []);
  assert.equal(input.value, '保留草稿');
  root.querySelector<HTMLButtonElement>('[data-action="work-picker"]')!.click();
  await tick();
  root.querySelector<HTMLButtonElement>('[data-quick-action="enter"]')!.click();
  await tick();
  assert.deepEqual(entered, ['20260929120000-aaaaaaa']);
  picker.dispose(); dom.window.close();
});

test('settings uses a document modal and explains local Bridge address without shrinking chat', async () => {
  const dom = new JSDOM(`<!doctype html><body>${createChatShell()}</body>`);
  const root = dom.window.document.querySelector<HTMLElement>('.sac')!;
  const saved: string[] = [],inspected:string[]=[],locations:string[]=[];
  const inspection=(url:string):BridgeInspection=>({url,message:'只读核对完成',bridgeAuthenticated:true,hermesReady:false,connections:[],saveOutcome:'not-requested',evidence:{checkedAt:'2026-11-06T12:00:00.000Z',code:'ok',reads:[{attempt:1,step:'health',httpStatus:200},{attempt:1,step:'connections',httpStatus:200}],companion:null}});
  const dialog = new SettingsDialog(dom.window.document, {
    bridgeUrl: () => 'http://127.0.0.1:8782',
    bridgeStatus: () => '已连接',pairingPresent:()=>true,
    save: async () => {assert.fail('legacy save must not bypass confirmation');},
    inspectBridge: async (input,current) => {assert.equal(current(),true);inspected.push(input.url);return inspection(input.url);},
    connectBridge: async (input,current) => {assert.equal(current(),true);assert.equal(input.bridgeOnly,true);saved.push(input.url);return {...inspection(input.url),saveOutcome:'bridge-only'};},
    defaultNotebookId:()=>'',listNotebooks:async()=>[{id:'20260929120001-abcdef0',name:'工作笔记本'}],
    saveDefaultNotebook:async id=>{locations.push(id);},
  });
  dialog.open(root);
  const overlay=dom.window.document.querySelector<HTMLElement>('.sac-settings-overlay')!;
  assert.ok(overlay);
  assert.equal(overlay.querySelector('[role="dialog"]')?.getAttribute('aria-modal'),'true');
  assert.match(overlay.textContent||'', /127\.0\.0\.1.*这台电脑/);
  assert.equal(overlay.querySelector('[data-settings-action="create"]'),null,'Work creation belongs in the Work flow');
  assert.equal(overlay.querySelector('[data-settings-action="link-chat"]'),null,'Chat association belongs in the conversation flow');
  assert.ok(overlay.querySelector('[data-settings-action="ekko"]'),'EKKO connection configuration remains available');
  await tick();
  const location=overlay.querySelector<HTMLSelectElement>('[data-setting="defaultNotebook"]')!;
  assert.match(location.textContent||'',/工作笔记本/);
  location.value='20260929120001-abcdef0';
  overlay.querySelector<HTMLButtonElement>('[data-settings-action="save-location"]')!.click();await tick();
  assert.deepEqual(locations,['20260929120001-abcdef0']);
  assert.equal(root.querySelector('.sac-settings'),null,'settings content must not occupy a dock grid row');
  overlay.querySelector<HTMLButtonElement>('[data-settings-action="hermes"]')!.click();
  const maintenance=overlay.querySelector<HTMLDetailsElement>('[data-settings-help="maintenance"]')!;
  maintenance.querySelector<HTMLElement>('summary')!.click();assert.equal(maintenance.open,true);
  const address=overlay.querySelector<HTMLInputElement>('[data-setting="baseUrl"]')!;address.value='http://127.0.0.1:8783';address.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  overlay.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click();await tick();
  assert.deepEqual(inspected,['http://127.0.0.1:8783']);assert.deepEqual(saved,[],'inspection must not save');
  overlay.querySelector<HTMLButtonElement>('[data-settings-action="prepare-bridge"]')!.click();await tick();
  assert.deepEqual(saved,[],'maintenance preparation must not save');assert.deepEqual(inspected,['http://127.0.0.1:8783']);
  assert.equal(overlay.querySelector('[data-settings-action="save"]'),null);
  const confirm=overlay.querySelector<HTMLButtonElement>('[data-connection-card] [data-settings-action="confirm-bridge"]')!;
  assert.equal(overlay.querySelectorAll('[data-settings-action="confirm-bridge"]').length,1);assert.equal(confirm.textContent,'使用此连接');assert.equal(confirm.hidden,false);assert.equal(confirm.closest('[hidden]'),null);assert.equal(dom.window.document.activeElement,confirm);
  confirm.click();await tick();
  assert.deepEqual(saved,['http://127.0.0.1:8783']);
  overlay.querySelector<HTMLButtonElement>('[data-settings-action="close"]')!.click();
  assert.equal(dom.window.document.querySelector('.sac-settings-overlay'),null);
  dialog.dispose();dom.window.close();
});

test('quick association rejects a document change after opening the menu', async () => {
  const dom=new JSDOM(`<!doctype html><body>${createChatShell()}</body>`),root=dom.window.document.querySelector<HTMLElement>('.sac')!;
  let current={id:'20260929120001-aaaaaaa',title:'原文档'},linked=0,confirmed=0,status='';
  const picker=new WorkQuickPicker(root,{load:async()=>[{id:'20260929120000-aaaaaaa',title:'目标 Work',goal:'',status:'active'}],currentDocument:()=>current,currentWork:()=>null,enter:async()=>{},link:async()=>{linked++;},create:async()=>{},browse:()=>{},status:message=>{status=message;},confirm:()=>{confirmed++;return true;}});
  root.querySelector<HTMLButtonElement>('[data-action="work-picker"]')!.click();await tick();
  current={id:'20260929120002-aaaaaaa',title:'新文档'};
  root.querySelector<HTMLButtonElement>('[data-quick-action="link"]')!.click();await tick();
  assert.equal(linked,0);assert.equal(confirmed,0);assert.match(status,/文档已变化/);
  picker.dispose();dom.window.close();
});

test('关联确认未读到名称时明确给出文档 ID，避免把 ID 当成文档名称',async()=>{
  const dom=new JSDOM(`<body>${createChatShell()}</body>`),root=dom.window.document.querySelector<HTMLElement>('.sac')!;
  const source='20261009120000-aaaaaaa';let confirmation='';
  const picker=new WorkQuickPicker(root,{load:async()=>[{id:'20261009120001-bbbbbbb',title:'虚构工作',goal:'',status:'active'}],currentDocument:()=>({id:source,title:source}),currentWork:()=>null,enter:async()=>{},link:async()=>{assert.fail('取消不能关联');},create:async()=>{},browse:()=>{},status:()=>{},confirm:message=>{confirmation=message;return false;}});
  root.querySelector<HTMLButtonElement>('[data-action="work-picker"]')!.click();await tick();
  assert.match(root.querySelector('.sac-quick-context')!.textContent||'',/名称待核对/);
  root.querySelector<HTMLButtonElement>('[data-quick-action="link"]')!.click();await tick();
  assert.match(confirmation,/资料文档：当前文档（名称待核对）\n文档 ID：20261009120000-aaaaaaa/);
  assert.match(confirmation,/目标 Work：虚构工作/);
  picker.dispose();dom.window.close();
});

test('quick Work search keeps the input node during Chinese composition', async () => {
  const dom=new JSDOM(`<!doctype html><body>${createChatShell()}</body>`),root=dom.window.document.querySelector<HTMLElement>('.sac')!;
  const picker=new WorkQuickPicker(root,{load:async()=>[{id:'20260929120000-aaaaaaa',title:'季度培训复盘',goal:'',status:'active'}],currentDocument:()=>null,currentWork:()=>null,enter:async()=>{},link:async()=>{},create:async()=>{},browse:()=>{},status:()=>{},confirm:()=>true});
  root.querySelector<HTMLButtonElement>('[data-action="work-picker"]')!.click();await tick();
  assert.match(root.querySelector('.sac-quick-results')?.textContent||'',/未设置目标/);
  const input=root.querySelector<HTMLInputElement>('[data-quick-search]')!;
  input.value='季';input.dispatchEvent(new dom.window.InputEvent('input',{bubbles:true,isComposing:true}));
  assert.equal(root.querySelector('[data-quick-search]'),input,'IME must retain its composition target');
  assert.match(root.querySelector('.sac-quick-results')?.textContent||'',/季度培训复盘/);
  picker.dispose();dom.window.close();
});

test('failed EKKO connection action keeps the settings modal open and shows a visible error', async () => {
  const dom=new JSDOM(`<!doctype html><body>${createChatShell()}</body>`),root=dom.window.document.querySelector<HTMLElement>('.sac')!;
  const dialog=new SettingsDialog(dom.window.document,{bridgeUrl:()=>'',bridgeStatus:()=>'',save:async()=>{},checkEkko:async()=>{throw new Error('fictional-token private-path');}});
  dialog.open(root);dom.window.document.querySelector<HTMLButtonElement>('[data-settings-action="ekko"]')!.click();await tick();
  const overlay=dom.window.document.querySelector<HTMLElement>('.sac-settings-overlay');
  assert.ok(overlay,'connection failure must keep the dialog visible');
  assert.match(overlay.querySelector('[role="alert"]')?.textContent||'',/EKKO 暂不可用/);
  assert.doesNotMatch(overlay.querySelector('[role="alert"]')?.textContent||'',/fictional-token|private-path/);
  dialog.close();
  dom.window.close();
});
