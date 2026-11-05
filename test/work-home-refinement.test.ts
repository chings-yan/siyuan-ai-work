import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {WorkPage} from '../src/work/page.ts';
import {SettingsDialog} from '../src/work/settings-dialog.ts';
import {inspectLocalBridge} from '../src/work/connection-settings.ts';
const tick=()=>new Promise(r=>setTimeout(r,0));
const actions={enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{}};
test('Home first use provides both document paths and optional AI without exposing captured identifiers',async()=>{
 const dom=new JSDOM('<body><main></main></body>'),root=dom.window.document.querySelector('main')!;let mode='',settings=0;
 const page=new WorkPage(root,{catalog:{load:async()=>({works:[],continueWorks:[],recentTasks:{kind:'unavailable',reason:'任务笔记管理 MCP 工具未注册'}})},context:{documentId:'20261002120000-aaaaaaa',title:'冻结的文档',focusBlockId:null},actions:{...actions,startDocument:async()=>{},create:async(_c:any,m:any)=>{mode=m;},settings:()=>{settings++;}} as any});
 await page.refresh();assert.equal(root.querySelector('[data-work-search]'),null);assert.ok(root.querySelector('[data-first-use]'));
 assert.match(root.textContent||'',/冻结的文档/);assert.equal(root.querySelector('[data-page-action="start-document"]')?.textContent,'在这篇文档开始');assert.doesNotMatch(root.textContent||'',/从第一个 Work 开始/);
 root.querySelector<HTMLButtonElement>('[data-page-action="create-existing"]')!.click();await tick();assert.equal(mode,'current');
 root.querySelector<HTMLButtonElement>('[data-page-action="settings"]')!.click();await tick();assert.equal(settings,1);
 assert.doesNotMatch(root.textContent||'',/20261002120000-aaaaaaa/);assert.match(root.textContent||'',/可稍后/);page.dispose();dom.window.close();
});
test('Bridge authentication is independent of selected Hermes authentication',async()=>{
 const urls:string[]=[];const fake:typeof fetch=async(u,init)=>{urls.push(String(u));assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
 if(String(u).endsWith('/health')){assert.equal(new Headers(init?.headers).has('X-Siyuan-Collab-Token'),false);return Response.json({ok:true,service:'siyuan-ai-collab-bridge'});}
 if(String(u).endsWith('/connections'))return Response.json({data:[{id:'serve-local',kind:'serve',state:'auth_failed',displayName:'Fictional Serve',profile:'default',installId:null}]});
 return Response.json({error:{code:'bridge_error',message:'Studio session index failed (401)'}},{status:500});};
 const result=await inspectLocalBridge({bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'fictional-token',documentRootId:'20261002120000-aaaaaaa'},fake);
 assert.equal((result as any).bridgeAuthenticated,true);assert.equal(result.hermesReady,false);assert.match(result.message,/下方检测结果/);assert.equal(result.connections?.[0].state,'auth_failed');assert.deepEqual(urls.map(s=>new URL(s).pathname),['/health','/connections']);
});
test('malformed authenticated response cannot become Bridge authentication success',async()=>{
 for(const payload of [{},{connection:[]},{connection:{}}]){const result=await inspectLocalBridge({bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'fictional-token'},async(u)=>Response.json(String(u).endsWith('/health')?{ok:true,service:'siyuan-ai-collab-bridge'}:payload));assert.equal((result as any).bridgeAuthenticated,false);}
});
test('Settings keeps paired EKKO credentials collapsed until explicit change and returns keyboard focus',async()=>{
 const dom=new JSDOM('<body><button id="source">设置</button></body>'),doc=dom.window.document,source=doc.querySelector<HTMLButtonElement>('#source')!;source.focus();
 const dialog=new SettingsDialog(doc,{bridgeUrl:()=>'',bridgeStatus:()=>'',save:async()=>{},checkEkko:async()=>({id:'fake',deviceId:'fake-device',accountUserId:1,accountName:'测试账号',state:'connected'})});dialog.open(source,'ekko');await tick();
 const form=doc.querySelector<HTMLFormElement>('[data-settings-ekko-form]')!;assert.equal(form.hidden,true);doc.querySelector<HTMLButtonElement>('[data-settings-action="change-ekko"]')!.click();assert.equal(form.hidden,false);
 const overlay=doc.querySelector<HTMLElement>('.sac-settings-overlay')!;overlay.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(doc.activeElement,source);dom.window.close();
});
test('Settings empty password candidate passes only explicit input and busy check cannot close',async()=>{
 const dom=new JSDOM('<body><button id="source">设置</button></body>'),doc=dom.window.document;let release!:(r:any)=>void;let received:any;
 const dialog=new SettingsDialog(doc,{bridgeUrl:()=> 'http://127.0.0.1:8782',bridgeStatus:()=>'',save:async()=>{},inspectBridge:async(input:any)=>{received=input;return new Promise(r=>release=r);}} as any);dialog.open(doc.querySelector('button')!,'hermes');
 const token=doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]');assert.ok(token);assert.equal(token.type,'password');assert.equal(token.value,'');token.value='fictional-new-token';
 doc.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click();await tick();assert.equal(received.token,'fictional-new-token');doc.querySelector('.sac-settings-overlay')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.ok(doc.querySelector('.sac-settings-overlay'));
 release({url:'http://127.0.0.1:8782',message:'Bridge 已配对，Hermes 待授权',bridgeAuthenticated:true,hermesReady:false});await tick();assert.equal(token.value,'fictional-new-token');dialog.close();dom.window.close();
});

test('Work creation keeps optional goal and tasks collapsed, location visible, and restores focus on Escape',async()=>{
 const {WorkCreateForm}=await import('../src/work/create-form.ts');const dom=new JSDOM('<body><button>新建</button></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});const origin=dom.window.document.querySelector('button')!;origin.focus();
 const creator:any={recentTasks:async()=>({kind:'found',value:[]}),prepare:async()=>({context:null,notebooks:[{id:'notebook',name:'工作笔记'}],notebookId:'notebook',locationError:''}),pending:async()=>[]};
 const view=new WorkCreateForm(creator,async()=>{});await view.open(null);const goal=dom.window.document.querySelector<HTMLDetailsElement>('[data-create-optional="goal"]');assert.ok(goal);assert.equal(goal.open,false);assert.equal(dom.window.document.querySelector<HTMLDetailsElement>('[data-create-optional="task"]')!.open,false);assert.equal(dom.window.document.querySelector('[name="notebook"]')!.closest('details'),null);
 dom.window.document.querySelector('.sac-create-overlay')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(dom.window.document.querySelector('.sac-create-overlay'),null);assert.equal(dom.window.document.activeElement,origin);dom.window.close();
});

test('modal Tab loops only visible controls and blocks field changes during verification',async()=>{
 const dom=new JSDOM('<body><button>设置</button></body>'),doc=dom.window.document;let finish!:(v:any)=>void;const dialog=new SettingsDialog(doc,{bridgeUrl:()=>'',bridgeStatus:()=>'',save:async()=>{},inspectBridge:async()=>new Promise(r=>finish=r)} as any);dialog.open(doc.querySelector('button')!,'hermes');const last=doc.querySelector<HTMLElement>('[data-settings-action="later"]')!,first=doc.querySelector<HTMLButtonElement>('[data-settings-action="close"]')!;last.focus();last.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',bubbles:true}));assert.equal(doc.activeElement,first);first.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}));assert.equal(doc.activeElement,last);doc.querySelector<HTMLButtonElement>('[data-settings-action="detect-bridge"]')!.click();await tick();assert.equal(doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!.disabled,true);finish({url:'',message:'尚未配对',bridgeAuthenticated:false,hermesReady:false});await tick();assert.equal(doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!.disabled,false);dialog.close();dom.window.close();
});

test('opening a modal from Home preserves its invoking button until focus returns',async()=>{
 const dom=new JSDOM('<body><main></main></body>'),doc=dom.window.document,root=doc.querySelector('main')!;const dialog=new SettingsDialog(doc,{bridgeUrl:()=>'',bridgeStatus:()=>'',save:async()=>{}});const page=new WorkPage(root,{catalog:{load:async()=>({works:[],continueWorks:[],recentTasks:{kind:'found',value:[]}})},context:null,actions:{...actions,settings:()=>dialog.open(root,'hermes')}});await page.refresh();const trigger=root.querySelector<HTMLButtonElement>('[data-page-action="settings"]')!;trigger.focus();trigger.click();await tick();assert.equal(trigger.isConnected,true);dialog.close();assert.equal(doc.activeElement,trigger);page.dispose();dom.window.close();
});
test('late optional task read does not replace a focused creation name or caret',async()=>{
 const {WorkCreateForm}=await import('../src/work/create-form.ts');const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});let done!:(v:any)=>void;const creator:any={recentTasks:async()=>new Promise(r=>done=r),prepare:async()=>({context:null,notebooks:[{id:'notebook',name:'工作笔记'}],notebookId:'notebook',locationError:''}),pending:async()=>[]};const form=new WorkCreateForm(creator,async()=>{});await form.open(null);const input=dom.window.document.querySelector<HTMLInputElement>('[name="title"]')!;input.focus();input.value='进行中的中文';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));input.setSelectionRange(3,3);done({kind:'found',value:[]});await tick();assert.equal(dom.window.document.querySelector('[name="title"]'),input);assert.equal(dom.window.document.activeElement,input);assert.equal(input.selectionStart,3);form.dispose();dom.window.close();
});


test('late notebook readiness stays locked during a Bridge check and becomes usable after it',async()=>{
 const dom=new JSDOM('<body><button>设置</button></body>'),doc=dom.window.document;let notebooks!:(v:any)=>void,check!:(v:string)=>void;
 const dialog=new SettingsDialog(doc,{bridgeUrl:()=> 'http://127.0.0.1:8782',bridgeStatus:()=>'',save:async()=>{},listNotebooks:()=>new Promise(r=>notebooks=r),saveDefaultNotebook:async()=>{},checkBridge:()=>new Promise(r=>check=r)});
 dialog.open(doc.querySelector('button')!,'hermes');doc.querySelector<HTMLButtonElement>('[data-settings-action="check-bridge"]')!.click();
 notebooks([{id:'notes',name:'工作笔记'}]);await tick();const select=doc.querySelector<HTMLSelectElement>('[data-setting="defaultNotebook"]')!,save=doc.querySelector<HTMLButtonElement>('[data-settings-action="save-location"]')!;
 assert.equal(dialog.isBusy,true);assert.equal(select.disabled,true,'loading must not unlock controls while verification owns the dialog');assert.equal(save.disabled,true);
 check('核对完成');await tick();assert.equal(dialog.isBusy,false);assert.equal(select.disabled,false);assert.equal(save.disabled,false);assert.match(select.textContent||'',/工作笔记/);dialog.close();dom.window.close();
});

test('read-only EKKO check recomputes pairing availability after resolving an unknown result',async()=>{
 const dom=new JSDOM('<body><button>设置</button></body>'),doc=dom.window.document;let unknown=true;
 const dialog=new SettingsDialog(doc,{bridgeUrl:()=>'',bridgeStatus:()=>'',save:async()=>{},pairingUnknown:()=>unknown,checkEkko:async()=>{unknown=false;return {id:'fake',deviceId:'fake-device',accountUserId:1,accountName:'测试账号',state:'connected'};}});
 dialog.open(doc.querySelector('button')!,'ekko');await tick();doc.querySelector<HTMLButtonElement>('[data-settings-action="change-ekko"]')!.click();assert.equal(doc.querySelector<HTMLButtonElement>('[data-settings-action="pair-ekko"]')!.disabled,false);assert.equal(doc.querySelector<HTMLElement>('[data-settings-action="ack-pairing"]')!.hidden,true);dialog.close();dom.window.close();
});

test('task management hides navigation for unlinked tasks and displays readable target document titles',async()=>{
 const dom=new JSDOM('<body><main></main></body>'),root=dom.window.document.querySelector('main')!;const W='20261002120000-aaaaaaa',D='20261002120001-bbbbbbb';let opened:string[]=[];
 const tasks=[{id:'without-document',title:'无文档待办',documentId:null,completed:false,projectId:null,createdAt:''},{id:'linked-document',title:'有文档待办',documentId:D,completed:false,projectId:null,createdAt:''}];
 const snapshot:any={works:[{id:W,record:{value:{id:W,title:'示例Work',goal:'',status:'active'}},resume:{value:null},documents:{value:[]},tasks:{value:tasks.map(value=>({workId:W,taskId:value.id,connectionId:'siyuan-native-local',lookup:{kind:'found',value}}))},chats:{value:[]},rooms:{value:[]}}],continueWorks:[],recentTasks:{kind:'found',value:[tasks[0]]}};
 const page=new WorkPage(root,{catalog:{load:async()=>snapshot},context:null,taskDocumentTitle:async id=>{assert.equal(id,D);return '实际目标文档';},actions:{...actions,task:async id=>{opened.push(id);}}});await page.refresh();assert.match(root.querySelector('[data-page-task-results]')!.textContent||'',/没有关联文档/);assert.equal(root.querySelector('[data-page-task-results] [data-page-action="task"]'),null);
 page.show({kind:'detail',workId:W,section:'tasks'});const rows=[...root.querySelectorAll('article')],noDocument=rows.find(row=>row.textContent?.includes('无文档待办'))!,linked=rows.find(row=>row.textContent?.includes('有文档待办'))!;
 assert.match(noDocument.textContent||'',/没有关联文档/);assert.equal(noDocument.querySelector('[data-page-action="task"]'),null);assert.match(linked.textContent||'',/实际目标文档/);assert.deepEqual(opened,[]);linked.querySelector<HTMLButtonElement>('[data-page-action="task"]')!.click();await tick();assert.deepEqual(opened,['linked-document']);page.dispose();dom.window.close();
});

test('editing an expanded completed pairing step retains input focus node caret and expansion',async()=>{
 const dom=new JSDOM('<body><button>设置</button></body>'),doc=dom.window.document;
 const previous:any={url:'http://127.0.0.1:8782',message:'',bridgeAuthenticated:true,hermesReady:false,connections:[],evidence:{checkedAt:'2026-10-22T12:00:00.000Z',code:'ok',reads:[],companion:null}};
 const dialog=new SettingsDialog(doc,{bridgeUrl:()=>previous.url,bridgeStatus:()=>'',save:async()=>{},lastInspection:()=>previous});dialog.open(doc.querySelector('button')!,'hermes');
 const step=doc.querySelector<HTMLDetailsElement>('[data-connection-step="pairing"]')!,input=doc.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!;step.open=true;input.focus();input.value='fictional-draft';input.setSelectionRange(4,4);input.dispatchEvent(new dom.window.InputEvent('input',{bubbles:true,isComposing:true}));
 assert.equal(step.open,true);assert.equal(doc.querySelector('[data-setting="bridgeToken"]'),input);assert.equal(doc.activeElement,input);assert.equal(input.selectionStart,4);assert.equal(input.value,'fictional-draft');assert.doesNotMatch(doc.querySelector('[data-hermes-results-label]')!.textContent||'',/本次/);dialog.dispose();dom.window.close();
});
