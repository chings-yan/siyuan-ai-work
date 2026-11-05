import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {SettingsDialog} from '../src/work/settings-dialog.ts';
import {createChatShell} from '../src/ui.ts';
const tick=()=>new Promise(r=>setTimeout(r,0));
const account={id:'test-connection',deviceId:'test-device',accountUserId:7,accountName:'测试账号',state:'connected'};

test('EKKO settings stays inside the modal and pairing preserves the current conversation',async()=>{
 const dom=new JSDOM(`<body>${createChatShell()}</body>`),root=dom.window.document.querySelector<HTMLElement>('.sac')!;
 root.dataset.surface='chat';root.querySelector<HTMLTextAreaElement>('textarea')!.value='原草稿';
 let oldEntry=0;const paired:any[]=[];
 const actions={bridgeUrl:()=> 'http://127.0.0.1:8782',bridgeStatus:()=>'',save:async()=>{},openEkko:async()=>{oldEntry++;},checkEkko:async()=>null,
  pairEkko:async(input:any)=>{paired.push({...input});return account;}};
 const view=new SettingsDialog(dom.window.document,actions);view.open(root);
 dom.window.document.querySelector<HTMLButtonElement>('[data-settings-action="ekko"]')!.click();await tick();
 const overlay=dom.window.document.querySelector<HTMLElement>('.sac-settings-overlay')!;
 assert.ok(overlay,'configuration must retain the modal');assert.equal(oldEntry,0);
 assert.equal(overlay.querySelector<HTMLElement>('[data-settings-pane="ekko"]')!.hidden,false);
 assert.equal(root.dataset.surface,'chat');assert.equal(root.querySelector('textarea')!.value,'原草稿');
 const field=(name:string)=>overlay.querySelector<HTMLInputElement>(`[data-ekko-setting="${name}"]`)!;
 assert.equal(field('baseUrl').value,'http://127.0.0.1:8748');field('username').value='test-account';field('password').value='fake-password';
 overlay.querySelector<HTMLButtonElement>('[data-settings-action="pair-ekko"]')!.click();await tick();
 assert.deepEqual(paired,[{baseUrl:'http://127.0.0.1:8748',username:'test-account',password:'fake-password'}]);
 assert.equal(field('password').value,'');assert.match(overlay.querySelector('[data-ekko-status]')!.textContent||'',/测试账号/);
 assert.equal(overlay.isConnected,true);assert.equal(oldEntry,0);view.dispose();dom.window.close();
});

test('modal sections preserve unsaved inputs and show a detected Bridge without saving or navigating',async()=>{
 const dom=new JSDOM('<body><aside></aside></body>');let saves=0;
 const actions={bridgeUrl:()=> 'http://127.0.0.1:8782',bridgeStatus:()=>'',save:async()=>{saves++;},openEkko:async()=>{},checkEkko:async()=>null,
  detectBridge:async()=>({url:'http://127.0.0.1:8783',message:'找到本机 Bridge，请保存地址'})};
 const view=new SettingsDialog(dom.window.document,actions);view.open(dom.window.document.querySelector('aside')!);
 const overlay=dom.window.document.querySelector<HTMLElement>('.sac-settings-overlay')!;
 overlay.querySelector<HTMLButtonElement>('[data-settings-action="hermes"]')!.click();
 const url=overlay.querySelector<HTMLInputElement>('[data-setting="baseUrl"]')!;url.value='http://127.0.0.1:8784';
 overlay.querySelector<HTMLButtonElement>('[data-settings-action="ekko"]')!.click();await tick();
 overlay.querySelector<HTMLButtonElement>('[data-settings-action="hermes"]')!.click();assert.equal(url.value,'http://127.0.0.1:8784');
 overlay.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click();await tick();
 assert.equal(url.value,'http://127.0.0.1:8783');assert.equal(saves,0);assert.ok(overlay.querySelector('[data-settings-action="confirm-bridge"]'));assert.equal(overlay.isConnected,true);
 assert.match(overlay.querySelector('[data-bridge-status]')!.textContent||'',/找到本机 Bridge/);view.dispose();dom.window.close();
});

test('unknown EKKO pairing clears the password, blocks duplicate submission and offers read-only verification',async()=>{
 const dom=new JSDOM('<body><aside></aside></body>');let pairs=0,checks=0;
 const actions={bridgeUrl:()=>'',bridgeStatus:()=>'',save:async()=>{},openEkko:async()=>{},
  checkEkko:async()=>{checks++;return null;},pairEkko:async()=>{pairs++;throw Error('配对结果未确认，请在 EKKO 核对应用连接');}};
 const view=new SettingsDialog(dom.window.document,actions);view.open(dom.window.document.querySelector('aside')!);
 dom.window.document.querySelector<HTMLButtonElement>('[data-settings-action="ekko"]')!.click();await tick();
 const overlay=dom.window.document.querySelector<HTMLElement>('.sac-settings-overlay')!;
 overlay.querySelector<HTMLInputElement>('[data-ekko-setting="username"]')!.value='test-account';
 overlay.querySelector<HTMLInputElement>('[data-ekko-setting="password"]')!.value='fake-password';
 const pair=overlay.querySelector<HTMLButtonElement>('[data-settings-action="pair-ekko"]')!;pair.click();pair.click();await tick();
 assert.equal(pairs,1);assert.equal(overlay.querySelector<HTMLInputElement>('[data-ekko-setting="password"]')!.value,'');
 assert.match(overlay.querySelector('[data-settings-error]')!.textContent||'',/核对/);assert.equal(pair.disabled,true);
 overlay.querySelector<HTMLButtonElement>('[data-settings-action="check-ekko"]')!.click();await tick();
 assert.equal(checks,2);assert.equal(pair.disabled,true,'no confirmed account cannot clear an unknown application login');
 view.dispose();dom.window.close();
});

test('EKKO unknown or malformed expiry stays unknown while service denial and account protection remain',async()=>{
 for(const authorization of [undefined,{source:'jwt',expiresAt:1800000000},{source:'app-login-record',expiresAt:1e20},{source:'app-login-record',expiresAt:'1800000000'}]){
  const dom=new JSDOM('<body><button>设置</button></body>'),doc=dom.window.document;const view=new SettingsDialog(doc,{bridgeUrl:()=>'',bridgeStatus:()=>'',save:async()=>{},pairingUnknown:()=>true,checkEkko:async()=>({...account,state:'install_mismatch',authorization} as any)});view.open(doc.querySelector('button')!,'ekko');await tick();
  assert.match(doc.querySelector('[data-ekko-authorization]')!.textContent||'',/未提供有效期/);assert.doesNotMatch(doc.querySelector('[data-ekko-status]')!.textContent||'',/已核对连接/);assert.equal(doc.querySelector<HTMLButtonElement>('[data-settings-action="pair-ekko"]')!.disabled,true);assert.equal(doc.querySelector<HTMLElement>('[data-settings-action="ack-pairing"]')!.hidden,false);view.dispose();dom.window.close();
 }
});
