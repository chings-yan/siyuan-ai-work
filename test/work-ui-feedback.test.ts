import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WorkPage } from '../src/work/page.ts';
import type { WorkStatus } from '../src/work/service.ts';

const W='20261008120000-aaaaaaa';
const tick=()=>new Promise(resolve=>setTimeout(resolve,5));
function fixture() {
  const dom=new JSDOM('<body><main></main></body>');
  const root=dom.window.document.querySelector('main')!;
  const record={id:W,title:'季度复盘',goal:'确认下一季度行动',status:'active' as WorkStatus};
  const chat={workId:W,chatId:'test-chat',documentRootId:W,connectionId:'test-connection',title:'复盘对话'};
  const room={workId:W,roomId:'test-room',connectionId:'test-ekko',deviceId:'test-device',accountUserId:7,roomNameAtLink:'复盘讨论室'};
  const row={id:W,record:{value:record},resume:{value:null},documents:{value:[{id:W,kind:'root',title:{value:record.title}}]},tasks:{value:[]},chats:{value:[chat]},rooms:{value:[room]}};
  const snapshot:any={works:[row],continueWorks:[],recentTasks:{kind:'found',value:[{id:'task-one',title:'整理访谈',documentId:null,completed:false}]}};
  const changes:Array<{id:string;status:WorkStatus;expected:WorkStatus}>=[];
  let allow=true;
  const actions:any={enter:async()=>{},resume:async()=>{},openDocument:async()=>{},task:async()=>{},create:async()=>{},linkDocument:async()=>{},
    setStatus:async(id:string,status:WorkStatus,expected:WorkStatus,current:()=>boolean)=>{assert.equal(current(),true);if(!allow)return false;changes.push({id,status,expected});record.status=status;return true;}};
  const page=new WorkPage(root,{catalog:{load:async()=>snapshot},context:null,actions});
  return {dom,root,record,row,page,snapshot,changes,actions,setAllow:(value:boolean)=>allow=value,close(){page.dispose();dom.window.close();}};
}

test('主页区分工作与待办，卡片分别显示资料、任务、AI 对话和协作房间',async()=>{
  const f=fixture();try{
    await f.page.refresh();
    const works=f.root.querySelector('[aria-label="工作列表"]');
    const tasks=f.root.querySelector('[aria-label="待办任务"]');
    assert.ok(works);assert.ok(tasks);assert.notEqual(works,tasks);
    assert.match(works.textContent||'',/季度复盘/);assert.doesNotMatch(tasks.textContent||'',/季度复盘/);
    assert.match(tasks.textContent||'',/整理访谈/);assert.match(tasks.textContent||'',/任务笔记管理/);
    const metrics=f.root.querySelector('[data-work-card] [aria-label="工作内容"]');assert.ok(metrics);
    for(const label of ['资料','任务','AI 对话','协作房间'])assert.match(metrics.textContent||'',new RegExp(label));
  }finally{f.close();}
});

for(const [metric,section,kind] of [
  ['documents','文档与资料',null],
  ['tasks','关联任务',null],
  ['hermes','AI 对话与房间','hermes'],
  ['ekko','AI 对话与房间','ekko'],
] as const)test(`列表卡片的${metric}统计直接打开对应工作内容`,async()=>{
  const f=fixture();try{
    await f.page.refresh();f.page.show({kind:'list'});
    const metricButton=f.root.querySelector<HTMLButtonElement>(`[data-work-card] [data-work-metric="${metric}"]`);
    assert.ok(metricButton,'统计项应是可点击按钮');
    metricButton.click();
    assert.match(f.root.textContent||'',/季度复盘/);
    assert.equal(f.root.querySelector('[aria-label="工作内容分类"] [aria-current="page"]')?.textContent,section);
    if(kind){
      const group=f.root.querySelector<HTMLElement>(`.sac-session-group[data-session-kind="${kind}"]`);
      assert.ok(group);assert.equal(f.dom.window.document.activeElement,group,'会话统计应定位到自己的分区');
    }else assert.equal(f.dom.window.document.activeElement,f.root.querySelector('[aria-label="工作内容分类"] [aria-current="page"]'),'资料或任务统计应聚焦对应分类');
  }finally{f.close();}
});

test('从 AI 对话统计进入同一 Work 的多对话列表，只有明确打开时才切换',async()=>{
  const f=fixture();try{
    f.row.chats.value.push({...f.row.chats.value[0],chatId:'test-chat-two',title:'另一条虚构对话'});
    const opened:string[]=[];f.actions.openChat=async(_id:string,link:{chatId:string})=>{opened.push(link.chatId);};
    await f.page.refresh();f.page.show({kind:'list'});
    const metric=f.root.querySelector<HTMLButtonElement>('[data-work-card] [data-work-metric="hermes"]');assert.ok(metric);
    assert.match(metric.textContent||'',/AI 对话\s*2/);
    metric.click();
    const group=f.root.querySelector<HTMLElement>('.sac-session-group[data-session-kind="hermes"]');assert.ok(group);
    assert.match(group.textContent||'',/侧栏顶部.*会话/,'多对话列表应说明另一个切换入口');
    const choices=group.querySelectorAll<HTMLButtonElement>('[data-page-action="session"]');assert.equal(choices.length,2);
    assert.deepEqual(opened,[],'查看统计不应切换当前对话');
    choices[1].click();await tick();assert.deepEqual(opened,['test-chat-two']);
  }finally{f.close();}
});

test('打开工作文档尚未完成时，统计按钮仍可查看只读列表',async()=>{
  const f=fixture();try{
    let finish!:()=>void;
    f.actions.enter=()=>new Promise<void>(resolve=>{finish=resolve;});
    await f.page.refresh();f.page.show({kind:'list'});
    f.root.querySelector<HTMLButtonElement>('[data-work-card] [data-page-action="enter"]')!.click();
    assert.equal(typeof finish,'function');
    f.root.querySelector<HTMLButtonElement>('[data-work-card] [data-work-metric="documents"]')!.click();
    assert.equal(f.root.querySelector('[aria-label="工作内容分类"] [aria-current="page"]')?.textContent,'文档与资料');
    finish();await tick();
  }finally{f.close();}
});

for(const [metric,focusAttribute] of [['documents','data-section'],['hermes','data-session-kind']] as const)test(`打开工作文档失败后，${metric}统计列表仍保留键盘焦点`,async()=>{
  const f=fixture();try{
    let fail!:()=>void;
    f.actions.enter=()=>new Promise<void>((_resolve,reject)=>{fail=()=>reject(Error('虚构打开失败'));});
    await f.page.refresh();f.page.show({kind:'list'});
    f.root.querySelector<HTMLButtonElement>('[data-work-card] [data-page-action="enter"]')!.click();
    f.root.querySelector<HTMLButtonElement>(`[data-work-card] [data-work-metric="${metric}"]`)!.click();
    assert.equal(f.dom.window.document.activeElement?.getAttribute(focusAttribute),metric);
    fail();await tick();
    assert.match(f.root.textContent||'',/虚构打开失败/);
    assert.equal(f.dom.window.document.activeElement?.getAttribute(focusAttribute),metric);
  }finally{f.close();}
});

test('多张 Work 的统计入口分别说清所查看的 Work',async()=>{
  const f=fixture();try{
    const secondId='20261008120000-bbbbbbb';
    f.snapshot.works.push({...f.row,id:secondId,record:{value:{...f.record,id:secondId,title:'虚构项目'}}});
    await f.page.refresh();f.page.show({kind:'list'});
    const buttons=f.root.querySelectorAll<HTMLButtonElement>('[data-work-metric="hermes"]');assert.equal(buttons.length,2);
    assert.match(buttons[0].getAttribute('aria-label')||'',/季度复盘.*AI 对话/);
    assert.match(buttons[1].getAttribute('aria-label')||'',/虚构项目.*AI 对话/);
  }finally{f.close();}
});

test('Work 由用户选择并确认状态，已完成可重新开始；任务完成不自动结束 Work',async()=>{
  const f=fixture();try{
    f.row.tasks.value=[{taskId:'done',lookup:{kind:'found',value:{id:'done',title:'已做完的待办',completed:true,documentId:null}}}] as any;
    await f.page.refresh();f.page.show({kind:'detail',workId:W});
    assert.equal(f.record.status,'active');assert.deepEqual(f.changes,[]);
    const select=f.root.querySelector<HTMLSelectElement>('[data-work-next-status]');assert.ok(select);
    select.value='completed';select.dispatchEvent(new f.dom.window.Event('change',{bubbles:true}));await tick();
    assert.deepEqual(f.changes,[],'选择状态本身不写入文档');
    f.setAllow(false);f.root.querySelector<HTMLButtonElement>('[data-page-action="set-status"]')!.click();await tick();
    assert.equal(f.record.status,'active');assert.deepEqual(f.changes,[]);
    f.setAllow(true);f.root.querySelector<HTMLButtonElement>('[data-page-action="set-status"]')!.click();await tick();
    assert.deepEqual(f.changes,[{id:W,status:'completed',expected:'active'}]);
    assert.match(f.root.querySelector('[data-work-lifecycle]')!.textContent||'',/已完成/);
    f.root.querySelector<HTMLSelectElement>('[data-work-next-status]')!.value='active';
    f.root.querySelector<HTMLButtonElement>('[data-page-action="set-status"]')!.click();await tick();
    assert.equal(f.record.status,'active');assert.equal(f.changes.length,2);
    assert.equal(f.row.chats.value.length,1);assert.equal(f.row.rooms.value.length,1);
  }finally{f.close();}
});

test('会话管理分组显示 AI 对话与协作房间，默认收起身份明细并保留正确的打开目标',async()=>{
  const f=fixture();try{
    let opened:any;f.actions.openRoom=async(id:string,link:any)=>{opened={id,link};};
    await f.page.refresh();f.page.show({kind:'detail',workId:W,section:'sessions'});
    const chats=f.root.querySelector('[aria-label="AI 对话"]');const rooms=f.root.querySelector('[aria-label="协作房间"]');
    assert.ok(chats);assert.ok(rooms);assert.match(chats.textContent||'',/复盘对话/);assert.match(rooms.textContent||'',/复盘讨论室/);
    assert.doesNotMatch(chats.textContent||'',/复盘讨论室/);
    const metadata=rooms.querySelector('details');assert.ok(metadata);assert.equal(metadata.open,false);
    rooms.querySelector<HTMLButtonElement>('[data-page-action="session"]')!.click();await tick();
    assert.equal(opened.id,W);assert.equal(opened.link.roomId,'test-room');assert.equal(opened.link.deviceId,'test-device');
  }finally{f.close();}
});
