import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WorkStore } from '../src/work/store.ts';
import { RoomLinkStore } from '../src/work/room-store.ts';
import { WorkController } from '../src/work/controller.ts';
import { SiYuanWorkHost } from '../src/work/siyuan-host.ts';
import { createChatShell } from '../src/ui.ts';

const A = '20260929120000-aaaaaaa', B = '20260929120001-bbbbbbb', C = '20260929120002-ccccccc', DOC = '20260929120003-ddddddd';
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function modules() {
  const catalog = await import('../src/work/catalog.ts').catch(() => null);
  const page = await import('../src/work/page.ts').catch(() => null);
  assert.ok(catalog && page, 'native Work catalog and page must be implemented');
  return { ...catalog, ...page };
}
function fixture() {
  const disk = new Map<string, unknown>();
  const storage = { loadData: (key: string) => disk.get(key), saveData: (key: string, value: unknown) => { disk.set(key, structuredClone(value)); } };
  const store = new WorkStore(storage), rooms = new RoomLinkStore(storage, () => store.listWorks());
  const records = new Map([ [A, { id:A,title:'季度方案',goal:'明确交付范围',status:'active' as const }], [B,{ id:B,title:'暂停项目',goal:'等待确认',status:'paused' as const }], [C,{id:C,title:'资料整理',goal:'整理访谈',status:'active' as const}] ]);
  const host = { getAttrs: async () => ({}), getDocumentPath: async (id:string) => `/${id}.sy`, getDocumentTitle: async (id:string) => id === DOC ? '参考文档' : records.get(id)?.title || id, listDescendantDocuments: async () => [DOC], getDocumentRoot:async () => DOC };
  const service = { readWork: async (id:string) => records.get(id) || null, listExternalDocuments: async () => [DOC] };
  const taskReader = { listRecent: async () => ({kind:'found' as const,value:[]}), getTask:async () => ({kind:'unavailable' as const,reason:'任务离线'}) };
  return { disk,store,rooms,records,host,service,taskReader };
}

test('Home searches tasks outside the recent five and keeps the input while results arrive',async()=>{
  const {WorkPage}=await modules(),dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;let opened='';
  const page=new WorkPage(root,{catalog:{load:async()=>({works:[],continueWorks:[],recentTasks:{kind:'found',value:[]}})},context:null,taskReader:{search:async(q:string)=>({kind:'found',value:[{id:'older',title:q+'方案',completed:false}]})},actions:{enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async(id:string)=>{opened=id;},create:async()=>{},linkDocument:async()=>{}}} as any);
  await page.refresh();const input=root.querySelector<HTMLInputElement>('[data-page-task-search]');assert.ok(input);
  input.value='招聘';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));
  assert.equal(root.querySelector('[data-page-task-search]'),input);assert.match(root.querySelector('[data-page-task-results]')?.textContent||'',/招聘方案/);
  root.querySelector<HTMLButtonElement>('[data-page-task-results] [data-task-id="older"]')!.click();await tick();assert.equal(opened,'older');page.dispose();dom.window.close();
});

test('Home empty matches are explicit and a late search cannot replace another page',async()=>{
  const {WorkPage}=await modules(),dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;let release!:(v:any)=>void;
  const page=new WorkPage(root,{catalog:{load:async()=>({works:[],continueWorks:[],recentTasks:{kind:'found',value:[]}})},context:null,taskReader:{search:async(q:string)=>q==='迟到'?new Promise(r=>release=r):{kind:'found',value:[]}},actions:{enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{}}} as any);
  await page.refresh();const input=root.querySelector<HTMLInputElement>('[data-page-task-search]')!;
  input.value='无匹配';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));assert.match(root.querySelector('[data-page-task-results]')?.textContent||'',/暂无|没有/);
  input.value='迟到';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));page.show({kind:'list'});release({kind:'found',value:[{id:'late',title:'不能覆盖新页'}]});await tick();
  assert.equal(root.querySelector('[data-page-task-results]'),null);assert.doesNotMatch(root.textContent||'',/不能覆盖新页/);page.dispose();dom.window.close();
});

test('Home retries the failed current task search instead of merely reloading the Work catalog',async()=>{
  const {WorkPage}=await modules(),dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;const queries:string[]=[];
  const page=new WorkPage(root,{catalog:{load:async()=>({works:[],continueWorks:[],recentTasks:{kind:'found',value:[]}})},context:null,taskReader:{search:async(q:string)=>{queries.push(q);return queries.length===1?{kind:'unavailable',reason:'offline'}:{kind:'found',value:[{id:'retry',title:'恢复后的匹配任务'}]};}},actions:{enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{}}} as any);
  await page.refresh();const input=root.querySelector<HTMLInputElement>('[data-page-task-search]')!;input.value='招聘';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));await new Promise(r=>setTimeout(r,220));
  root.querySelector<HTMLButtonElement>('[data-page-task-results] button')!.click();await tick();
  assert.deepEqual(queries,['招聘','招聘']);assert.match(root.querySelector('[data-page-task-results]')?.textContent||'',/恢复后的匹配任务/);page.dispose();dom.window.close();
});
test('catalog preserves read failures and only offers active valid Resume ordered by activity', async () => {
  const { WorkCatalog } = await modules(); const f = fixture();
  for (const [id,time] of [[A,'2026-09-28'],[B,'2026-09-30'],[C,'2026-09-29']]) {
    await f.store.registerWork(id);
    await f.store.saveResume({workId:id,documentId:DOC,focusBlockId:null,chatId:null,taskId:null,updatedAt:time});
  }
  await f.store.linkTask({taskId:'t1',workId:A,connectionId:'siyuan-native-local'});
  await f.store.linkChat({chatId:'chat-1',workId:A,documentRootId:A,connectionId:'local'});
  const catalog = new WorkCatalog(f as any);
  const snapshot = await catalog.load();
  assert.deepEqual(snapshot.continueWorks.map((row:any) => row.id),[C,A]);
  assert.equal(snapshot.works[0].documents.value!.length,2, 'root and deduplicated resource');
  assert.equal(snapshot.works[0].chats.value![0].chatId,'chat-1');
  const lookup=snapshot.works[0].tasks.value![0].lookup;
  assert.equal(lookup.kind,'unavailable');if(lookup.kind==='unavailable')assert.match(lookup.reason,/离线/);
  f.host.listDescendantDocuments = async () => { throw new Error('目录读取失败'); };
  f.service.readWork = async () => { throw new Error('目标块错误'); };
  const failed = await catalog.load();
  assert.match(failed.works[0].record.error!,/目标块错误/);
  assert.match(failed.works[0].documents.error!,/目录读取失败/);
  assert.deepEqual(failed.continueWorks,[]);
  f.disk.set('work-formal-v2',{schema:9});
  const corrupt = await catalog.load();
  assert.match(corrupt.error!,/正式关系/);
  assert.deepEqual(f.disk.get('work-formal-v2'),{schema:9});
});

test('a Work without a Goal remains enterable and offers a later Goal action in management',async()=>{
  const {WorkCatalog,WorkPage}=await modules(),f=fixture();f.records.get(A)!.goal='';await f.store.registerWork(A);
  const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;let added='';
  const page=new WorkPage(root,{catalog:new WorkCatalog(f as any),context:null,actions:{enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{},addGoal:async(id:string)=>{added=id;}}});
  await page.refresh();assert.doesNotMatch(root.querySelector('[data-work-card]')?.textContent||'',/未设置目标/);
  assert.ok(root.querySelector('[data-work-card] [data-page-action="enter"]'));
  root.querySelector<HTMLButtonElement>('[data-page-action="detail"]')!.click();
  root.querySelector<HTMLButtonElement>('[data-page-action="add-goal"]')!.click();await tick();assert.equal(added,A);
  page.dispose();dom.window.close();
});

test('management keeps Goal reconciliation reachable after a successful native write',async()=>{
  const {WorkCatalog,WorkPage}=await modules(),f=fixture();await f.store.registerWork(A);
  const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;let selected='';
  const page=new WorkPage(root,{catalog:new WorkCatalog(f as any),context:null,actions:{enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{},addGoal:async(id:string)=>{selected=id;}}});
  await page.refresh();root.querySelector<HTMLButtonElement>('[data-page-action="detail"]')!.click();
  const button=root.querySelector<HTMLButtonElement>('[data-page-action="add-goal"]');assert.ok(button);
  button.click();await tick();assert.equal(selected,A);page.dispose();dom.window.close();
});
test('page secondary filtering/back and details never mutate composer or use Resume for a document', async () => {
  const { WorkCatalog, WorkPage } = await modules(); const f = fixture();
  for (const id of [A,B,C]) await f.store.registerWork(id);
  const dom = new JSDOM('<main></main><textarea>原始草稿</textarea>');
  const root = dom.window.document.querySelector('main')!;
  const calls:string[]=[];
  const page = new WorkPage(root, { catalog:new WorkCatalog(f as any), context:{documentId:DOC,title:'参考文档',focusBlockId:null}, actions:{
    enter:async (id:string)=>{calls.push(`enter:${id}`);}, resume:async (id:string)=>{calls.push(`resume:${id}`);}, openDocument:async (_id:string,doc:string)=>{calls.push(`doc:${doc}`);},
    task:async()=>{}, create:async()=>{}, linkDocument:async()=>{},
  }});
  await page.refresh();
  const click = (selector:string) => { const button=root.querySelector<HTMLButtonElement>(selector);assert.ok(button,selector);button.click(); };
  click('[data-page-action="list"]');
  assert.equal(root.querySelector('dialog'),null);
  assert.equal(root.querySelectorAll('[data-work-card]').length,3);
  const search=root.querySelector<HTMLInputElement>('[data-work-search]')!; search.value='交付';search.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  assert.equal(root.querySelectorAll('[data-work-card]').length,1);
  click('[data-page-action="detail"]');
  click('[data-page-action="document"]'); await tick();
  assert.deepEqual(calls,[`doc:${A}`]);
  click('[data-page-action="back"]');
  assert.equal(root.querySelector<HTMLInputElement>('[data-work-search]')!.value,'交付');
  click('[data-page-action="enter"]');await tick();
  assert.deepEqual(calls,[`doc:${A}`,`enter:${A}`]);
  assert.equal(dom.window.document.querySelector('textarea')!.value,'原始草稿');
  const searchAgain=root.querySelector<HTMLInputElement>('[data-work-search]')!;searchAgain.value='不存在';searchAgain.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  assert.match(root.textContent||'',/没有符合/);
  page.dispose();const count=calls.length;root.querySelector<HTMLButtonElement>('[data-page-action="back"]')?.click();await tick();assert.equal(calls.length,count);
  dom.window.close();
});
test('native tab registers synchronously, opens one stable identity on demand and disposes only page', async () => {
  const module = await import('../src/work/native-tab.ts').catch(()=>null);assert.ok(module,'native tab adapter must exist');
  const dom = new JSDOM('<main></main>');let registration:any;let opened=0,mounted=0,disposed=0;const ids:string[]=[];
  const plugin:any={name:'plugin-',app:{},addTab:(options:any)=>{registration=options;}};
  const tab=new module.WorkNativeTab(plugin,async (options:any)=>{opened++;ids.push(options.custom.id);if(mounted===0){registration.init.call({element:dom.window.document.querySelector('main')});}return {} as any;},()=>{mounted++;return {show:()=>{},dispose:()=>{disposed++;},setContext:()=>{},refresh:async()=>{}} as any;});
  assert.ok(registration);assert.equal(opened,0);
  await tab.open({kind:'home'},null);await tab.open({kind:'list'},null);
  assert.equal(mounted,1);assert.deepEqual(ids,['plugin-ai-work-home','plugin-ai-work-home']);
  registration.destroy.call({element:dom.window.document.querySelector('main')});assert.equal(disposed,1);
  mounted=0;await tab.open({kind:'home'},null);assert.equal(mounted,1);tab.dispose();assert.equal(disposed,2);dom.window.close();
});
test('explicit Work entry opens root, Resume opens saved document; draft is outside navigation state', async () => {
  const f=fixture();await f.store.registerWork(A);await f.store.saveResume({workId:A,documentId:DOC,focusBlockId:null,chatId:null,taskId:null,updatedAt:'2026-09-29'});
  const opened:string[]=[];
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:f.taskReader as any,currentDocumentId:()=>DOC,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:(id:string)=>{opened.push(id);},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:()=>{}});
  assert.equal(typeof (controller as any).enterWork,'function','explicit entry must not reuse Resume');
  await (controller as any).enterWork(A);assert.deepEqual(opened,[A]);
  // Save a later reading position, independently of the entry's pending update.
  await controller.flushResume();await f.store.saveResume({workId:A,documentId:DOC,focusBlockId:null,chatId:null,taskId:null,updatedAt:'2026-09-29'});
  await controller.resumeWork(A);assert.deepEqual(opened,[A,DOC]);controller.detach();
});

test('list starts with all Works and Back restores the originating filters; cancelled association is not success', async () => {
  const {WorkCatalog,WorkPage}=await modules();const f=fixture();for(const id of [A,B,C])await f.store.registerWork(id);
  const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;
  const page=new WorkPage(root,{catalog:new WorkCatalog(f as any),context:{documentId:DOC,title:'参考',focusBlockId:null},actions:{enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>false}});
  await page.refresh();
  assert.ok(root.querySelector('[data-work-card] [data-page-action="link"]'),'Home card should link the captured document directly without navigating away');
  assert.equal(root.querySelector('[data-work-search]'),null,'Home keeps full filtering in the secondary list');
  root.querySelector<HTMLButtonElement>('[data-page-action="list"]')!.click();
  assert.equal(root.querySelectorAll('[data-work-card]').length,3);
  const input=root.querySelector<HTMLInputElement>('[data-work-search]')!;input.value='交付';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  root.querySelector<HTMLButtonElement>('[data-page-action="detail"]')!.click();
  root.querySelector<HTMLButtonElement>('[data-page-action="back"]')!.click();
  assert.equal(root.querySelector<HTMLInputElement>('[data-work-search]')!.value,'交付');
  root.querySelector<HTMLButtonElement>('[data-page-action="home"]')!.click();
  root.querySelector<HTMLButtonElement>('[data-page-action="link-list"]')!.click();
  root.querySelector<HTMLButtonElement>('[data-page-action="link"]')!.click();await tick();
  assert.doesNotMatch(root.querySelector('[role="status"]')?.textContent||'',/已关联/);
  page.dispose();dom.window.close();
});

test('Home card links its captured document without entering a Work or leaving Home', async () => {
  const {WorkCatalog,WorkPage}=await modules();const f=fixture();await f.store.registerWork(A);
  const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;
  const links:string[]=[];let entries=0;
  const page=new WorkPage(root,{catalog:new WorkCatalog(f as any),context:{documentId:DOC,title:'参考文档',focusBlockId:null},actions:{enter:async()=>{entries++;},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async(id,context)=>{links.push(`${id}:${context.documentId}`);}}});
  await page.refresh();root.querySelector<HTMLButtonElement>('[data-work-card] [data-page-action="link"]')!.click();await tick();
  assert.deepEqual(links,[`${A}:${DOC}`]);assert.equal(entries,0);
  assert.match(root.textContent||'',/今天想推进什么/);
  assert.match(root.textContent||'',/当前文档已关联/);
  page.dispose();dom.window.close();
});

test('nested Work descendant discovery uses its actual path and reports truncated or failed reads', async () => {
  const queries:string[]=[];
  let rows:unknown=[{id:DOC}];
  const host=new SiYuanWorkHost(async(_path,body)=>{queries.push(String(body.stmt));return String(body.stmt).includes('select path')?[{path:`/${B}/${A}.sy`}]:rows;});
  assert.deepEqual(await host.listDescendantDocuments(A),[DOC]);
  assert.match(queries.at(-1)!,new RegExp(`/${B}/${A}/`));
  rows=Array.from({length:201},()=>({id:DOC}));
  await assert.rejects(host.listDescendantDocuments(A),/过多|完整/);
  rows={failed:true};await assert.rejects(host.listDescendantDocuments(A),/读取|格式/);
});

test('page failed reads expose retry and disposing ignores late refresh without adding listeners on reopen', async () => {
  const {WorkPage}=await modules();const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;
  let reads=0;let release!:(value:any)=>void;
  const catalog={load:async()=>{reads++;if(reads===1)throw new Error('暂时离线');return new Promise<any>(resolve=>{release=resolve;});}};
  const actions={enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{}};
  const page=new WorkPage(root,{catalog,context:null,actions});await page.refresh();assert.match(root.textContent||'',/暂时离线/);
  root.querySelector<HTMLButtonElement>('.sac-page-error [data-page-action="refresh"]')!.click();await tick();assert.equal(reads,2);
  page.dispose();release({works:[],continueWorks:[],recentTasks:{kind:'found',value:[]}});await tick();assert.match(root.textContent||'',/暂时离线/);
  const next=new WorkPage(root,{catalog:{load:async()=>{reads++;return {works:[],continueWorks:[],recentTasks:{kind:'found',value:[]}};}},context:null,actions});
  root.querySelector<HTMLButtonElement>('[data-page-action="refresh"]')!.click();await tick();assert.equal(reads,3);next.dispose();dom.window.close();
});

test('recent task with a formal Work but no linked document does not jump to the Work root', async () => {
  const f=fixture();await f.store.registerWork(A);await f.store.linkTask({workId:A,taskId:'task',connectionId:'siyuan-native-local'});
  const opened:string[]=[];
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{getTask:async()=>({kind:'found',value:{id:'task',title:'待办',completed:false,documentId:null}})} as any,currentDocumentId:()=>DOC,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:(id:string)=>{opened.push(id);},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:()=>{}});
  await assert.rejects(controller.enterTask('task'),/关联文档/);controller.detach();
  assert.deepEqual(opened,[]);assert.equal(controller.currentTask,null);
});

test('task with a broken formal Work still opens its existing document without changing Work ownership', async () => {
  const f=fixture();await f.store.registerWork(A);await f.store.linkTask({workId:A,taskId:'task',connectionId:'siyuan-native-local'});
  f.service.readWork=async()=>{throw new Error('Work 目标角色块缺失或重复，已停止更新');};
  const opened:string[]=[],messages:string[]=[];
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{getTask:async()=>({kind:'found',value:{id:'task',title:'待办',completed:false,documentId:A}})} as any,currentDocumentId:()=>DOC,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:async(id:string)=>{opened.push(id);},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:(message:string)=>{messages.push(message);}});
  await controller.enterTask('task');controller.detach();
  assert.deepEqual(opened,[A]);assert.equal(controller.currentWorkId,null,'broken Work remains unselected');
  assert.match(messages.at(-1)||'',/已打开任务文档.*Work.*损坏/);
  assert.deepEqual(await f.store.listTasks(A),[{workId:A,taskId:'task',connectionId:'siyuan-native-local'}]);
});

test('unowned task never links to a Work whose goal marker broke after selection', async () => {
  const f=fixture();await f.store.registerWork(A);
  const opened:string[]=[];
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{getTask:async()=>({kind:'found',value:{id:'task',title:'待办',completed:false,documentId:DOC}})} as any,currentDocumentId:()=>DOC,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:async(id:string)=>{opened.push(id);},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:()=>{}});
  await controller.selectWork(A);
  f.service.readWork=async()=>{throw new Error('Work 目标角色块缺失或重复，已停止更新');};
  await controller.enterTask('task');controller.detach();
  assert.deepEqual(opened,[DOC]);assert.deepEqual(await f.store.listTasks(A),[]);
});

test('opening an unowned task only navigates to its document without offering association', async () => {
  const f=fixture();await f.store.registerWork(A);
  const opened:string[]=[],messages:string[]=[];let confirms=0;
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{getTask:async()=>({kind:'found',value:{id:'task',title:'待办',completed:false,documentId:DOC}})} as any,currentDocumentId:()=>A,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:async(id:string)=>{opened.push(id);},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:(message:string)=>{messages.push(message);}});
  await controller.selectWork(A);
  const previousWindow=(globalThis as any).window;(globalThis as any).window={confirm:()=>{confirms++;return true;}};
  try {
    await controller.enterTask('task');
    assert.equal(confirms,0,'opening a task must never offer to write a formal relation');
    assert.deepEqual(await f.store.listTasks(A),[]);
    assert.deepEqual(opened,[DOC]);
    assert.equal(controller.currentWorkId,A);
    assert.equal(controller.currentTask,null);
    assert.match(messages.at(-1)||'',/已打开任务文档.*未建立任务关系/);
  } finally {controller.detach();(globalThis as any).window=previousWindow;}
});

test('opening cannot associate an unowned task that changed after its first read', async () => {
  const f=fixture();await f.store.registerWork(A);
  let live={id:'task',title:'待办',completed:false,documentId:DOC};let reads=0,confirms=0;
  const opened:string[]=[];
  f.host.getDocumentPath=async(id:string)=>{live={...live,completed:true,documentId:B};return `/${id}.sy`;};
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{getTask:async()=>{reads++;return {kind:'found',value:{...live}};}} as any,currentDocumentId:()=>A,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:async(id:string)=>{opened.push(id);},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:()=>{}});
  await controller.selectWork(A);
  const previousWindow=(globalThis as any).window;(globalThis as any).window={confirm:()=>{confirms++;return true;}};
  try {
    await controller.enterTask('task');
    assert.equal(reads,1);
    assert.equal(live.completed,true);
    assert.equal(live.documentId,B);
    assert.equal(confirms,0);
    assert.deepEqual(await f.store.listTasks(A),[],'a changed task must not gain formal Work ownership through opening');
    assert.deepEqual(opened,[DOC],'navigation uses the document observed for this opening');
  } finally {controller.detach();(globalThis as any).window=previousWindow;}
});

test('opening a task with existing ownership enters its Work and actual linked document', async () => {
  const f=fixture();await f.store.registerWork(A);await f.store.registerWork(B);
  await f.store.linkTask({workId:A,taskId:'task',connectionId:'siyuan-native-local'});
  const opened:string[]=[];
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{getTask:async()=>({kind:'found',value:{id:'task',title:'待办',completed:false,documentId:DOC}})} as any,currentDocumentId:()=>B,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:async(id:string)=>{opened.push(id);},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:()=>{}});
  await controller.selectWork(B);
  try {
    await controller.enterTask('task');
    assert.deepEqual(opened,[DOC]);
    assert.equal(controller.currentWorkId,A);
    assert.equal(controller.currentTask,'task');
    assert.deepEqual(await f.store.listTasks(A),[{workId:A,taskId:'task',connectionId:'siyuan-native-local'}]);
    assert.deepEqual(await f.store.listTasks(B),[]);
  } finally {controller.detach();}
});

test('unowned task awaits native document opening and a task without a document reports why entry cannot navigate', async () => {
  const f=fixture();let release!:()=>void;const opened:string[]=[];
  let documentId:string|null=DOC;
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{getTask:async()=>({kind:'found',value:{id:'task',title:'待办',completed:false,documentId}})} as any,currentDocumentId:()=>DOC,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:async(id:string)=>{opened.push(id);await new Promise<void>(resolve=>{release=resolve;});},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:()=>{}});
  let done=false;const entry=controller.enterTask('task').then(()=>{done=true;});
  for(let i=0;i<10&&!release;i++)await tick();assert.deepEqual(opened,[DOC]);assert.equal(done,false,'native navigation must be awaited');
  release();await entry;documentId=null;
  await assert.rejects(controller.enterTask('task'),/没有关联文档|无法打开/);
  controller.detach();
});

test('failed entry to an unowned task preserves the current task and Resume', async () => {
  const f=fixture();await f.store.registerWork(A);await f.store.linkTask({workId:A,taskId:'owned',connectionId:'siyuan-native-local'});
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{getTask:async(id:string)=>({kind:'found',value:{id,title:'待办',completed:false,documentId:id==='owned'?A:null}})} as any,currentDocumentId:()=>DOC,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:async()=>{},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:()=>{}});
  await controller.enterTask('owned');await controller.flushResume();
  const previousWindow=(globalThis as any).window;(globalThis as any).window={confirm:()=>false};
  try {await assert.rejects(controller.enterTask('unowned'),/没有关联文档/);}finally{(globalThis as any).window=previousWindow;}
  await controller.flushResume();assert.equal(controller.currentTask,'owned');assert.equal((await f.store.getResume(A))?.taskId,'owned');
  controller.detach();
});

test('compact chat sidebar opens a recent task picker and enters a linked document', async () => {
  const f=fixture(),dom=new JSDOM(createChatShell());
  const root=dom.window.document.querySelector<HTMLElement>('.sac')!;
  const opened:string[]=[],messages:string[]=[];
  const task={id:'task',title:'待办',completed:false,documentId:DOC,projectId:null,createdAt:'2026-09-29'};
  const controller=new WorkController({...f,host:f.host as any,service:f.service as any,taskReader:{listRecent:async()=>({kind:'found',value:[task]}),getTask:async()=>({kind:'found',value:task})} as any,currentDocumentId:()=>DOC,currentFocusBlockId:()=>null,currentChatId:()=>null,isBusy:()=>false,hasPendingWrite:()=>false,openDocument:async(id:string)=>{opened.push(id);},onWorkChanged:async()=>{},onLinkCurrentChat:async()=>{},status:(message:string)=>{messages.push(message);}});
  controller.attach(root);
  const button=root.querySelector<HTMLButtonElement>('[data-work-action="recent-tasks"]');
  assert.ok(button,'task access belongs in the compact header');
  button.click();for(let i=0;i<10&&!root.querySelector('[data-recent-task-menu] [data-work-action="task"]');i++)await tick();
  assert.ok(root.querySelector('[data-recent-task-menu] [data-work-action="task"]'));
  root.querySelector<HTMLButtonElement>('[data-recent-task-menu] [data-work-action="task"]')!.click();
  for(let i=0;i<10&&!opened.length;i++)await tick();
  assert.deepEqual(opened,[DOC]);assert.match(messages.at(-1)||'',/已打开任务文档/);
  controller.detach();dom.window.close();
});

test('document path read distinguishes missing documents from malformed SQL rows and path fields', async () => {
  let response:unknown=[];
  const host=new SiYuanWorkHost(async()=>response);
  assert.equal(await host.getDocumentPath(DOC),null,'only a successful empty SQL result means missing');
  for(const malformed of [{unexpected:'invalid SQL result'},null,[null],[[]],[{}],[{path:null}],[{path:7}],[{path:''}],[{path:'  '}],[{path:'not-a-document-path'}]]) {
    response=malformed;
    await assert.rejects(host.getDocumentPath(DOC),/文档路径.*读取.*格式/);
  }
  response=[{path:`/${DOC}.sy`}];assert.equal(await host.getDocumentPath(DOC),`/${DOC}.sy`);
  response=[{path:`/${A}/${DOC}.sy`}];assert.equal(await host.getDocumentPath(DOC),`/${A}/${DOC}.sy`);
});

test('Resume path read failure stays visible with retry and never overwrites saved Resume', async () => {
  const {WorkCatalog,WorkPage}=await modules();const f=fixture();await f.store.registerWork(A);
  const saved={workId:A,documentId:DOC,focusBlockId:null,chatId:null,taskId:null,updatedAt:'2026-09-29'};
  await f.store.saveResume(saved);
  let response:unknown={unexpected:'invalid SQL result'};
  const host=new SiYuanWorkHost(async()=>response);
  f.host.getDocumentPath=id=>host.getDocumentPath(id) as Promise<string>;
  const catalog=new WorkCatalog(f as any);
  const failed=await catalog.load();
  assert.match(failed.works[0].resume.error||'',/文档路径.*读取.*格式/);
  assert.equal(failed.works[0].resume.value,undefined,'read failure cannot become a null Resume');
  assert.equal(failed.continueWorks.length,0);
  const dom=new JSDOM('<main></main>'),root=dom.window.document.querySelector('main')!;
  const page=new WorkPage(root,{catalog,context:null,actions:{enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{}}});
  try {
    await page.refresh();
    const retry=root.querySelector<HTMLButtonElement>('[data-work-card] .sac-page-error [data-page-action="refresh"]');
    assert.ok(retry,'Work card must keep the failed Resume read and a retry action visible');
    response=[{path:`/${DOC}.sy`}];retry.click();
    for(let i=0;i<30&&!root.querySelector('[data-page-action="resume"]');i++)await tick();
    assert.ok(root.querySelector('[data-page-action="resume"]'),'successful retry restores Continue');
    response=[];const missing=await catalog.load();
    assert.deepEqual(missing.works[0].resume,{value:null},'a genuinely missing document is distinct from the failed read');
    assert.equal(missing.continueWorks.length,0);
    assert.deepEqual(await f.store.getResume(A),saved,'neither read failure nor missing document overwrites stored Resume');
  } finally {page.dispose();dom.window.close();}
});
