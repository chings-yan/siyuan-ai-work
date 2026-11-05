import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { RoomLinkStore, type RoomLink } from '../src/work/room-store.ts';
import { PendingRoomSendStore } from '../src/ekko/pending.ts';
import { prepareRoomSend, assertRoomSendCurrent } from '../src/ekko/context.ts';
import { EkkoRoomUI } from '../src/ekko/ui.ts';
import { createChatShell } from '../src/ui.ts';
import { sessionChoices, sessionKey } from '../src/work/sessions.ts';
const A='20261012120000-aaaaaaa',B='20261012120001-bbbbbbb';
const work:RoomLink={workId:'work-a',connectionId:'connection-a',deviceId:'device-a',accountUserId:7,roomId:'room-a',roomNameAtLink:'虚构房间'};
const link=(documentRootId=A):RoomLink=>({...work,workId:null,documentRootId});
function storage(){const values=new Map<string,any>();return {values,loadData:async(key:string)=>structuredClone(values.get(key)),saveData:async(key:string,value:unknown)=>{values.set(key,structuredClone(value));}};}
test('ordinary documents and legacy Work persist the same remote room as three exact independent scopes',async()=>{
 const s=storage(),rooms=new RoomLinkStore(s,async()=>['work-a']);
 await rooms.linkRoom(work);await rooms.linkRoom(link());await rooms.linkRoom(link(B));await rooms.linkRoom({...link(),roomNameAtLink:'changed'});
 const restarted=new RoomLinkStore(s,async()=>['work-a']);assert.deepEqual(await restarted.listForWork('work-a'),[work]);assert.deepEqual(await restarted.listForDocument(A),[link()]);assert.deepEqual(await restarted.listForDocument(B),[link(B)]);
 assert.deepEqual(s.values.get('work-rooms-v1'),{schema:1,links:[work,link(),link(B)]});
 await rooms.unlinkRoom(link(B));assert.deepEqual(await rooms.listForDocument(A),[link()]);
 await assert.rejects(rooms.linkRoom({...link(B),accountUserId:8}),/身份|冲突/);
 await assert.rejects(rooms.assertLinked(null,work,'room-a',B),/未关联|身份/);
});
test('null, absent and empty Work or invalid document fields are never interchangeable',async()=>{
 for(const malformed of [{...work,workId:null},{...work,workId:''},{...work,workId:undefined},{...link(),documentRootId:'bad'},{...work,documentRootId:A}]){
  const s=storage();const bad={schema:1,links:[malformed]};s.values.set('work-rooms-v1',bad);const rooms=new RoomLinkStore(s,async()=>['work-a']);await assert.rejects(rooms.linkRoom(link()),/损坏|版本/);assert.deepEqual(s.values.get('work-rooms-v1'),bad);
 }
});
test('pending identifiers restore independently and cannot overwrite or clear another document',async()=>{
 const s=storage(),pending=new PendingRoomSendStore(s);await pending.remember(work,'work-id');await pending.remember(link(),'original-a');await pending.remember(link(B),'original-b');
 const restored=new PendingRoomSendStore(s);assert.equal((await restored.get(link()))?.clientMessageId,'original-a');await assert.rejects(restored.remember(link(),'new-a'),/未决|覆盖/);await assert.rejects(restored.clear(link(B),'original-a'),/不一致/);await restored.clear(link(B),'original-b');assert.equal((await restored.get(link()))?.clientMessageId,'original-a');assert.equal((await restored.get(work))?.clientMessageId,'work-id');assert.ok(!JSON.stringify([...s.values.values()]).includes('正文'));
});
test('standalone send freezes exact document, reads no unselected source and rejects unrelated source before read',async()=>{
 let reads=0;const input={workId:null,roomLink:link(),documentRootId:A,text:'虚构消息',selectedSources:[],loadSource:async()=>{reads++;return {kind:'document' as const,documentId:A,title:'虚构',text:'正文'};}};
 const frozen=await prepareRoomSend(input);assert.equal(reads,0);assertRoomSendCurrent(frozen,input);assert.throws(()=>assertRoomSendCurrent(frozen,{...input,documentRootId:B}),/变化/);
 await assert.rejects(prepareRoomSend({...input,selectedSources:[{kind:'document',documentId:B}]}),/资料|文档|范围/);assert.equal(reads,0);
});
test('selector keys and rows isolate two ordinary documents using the same room',()=>{
 assert.notEqual(sessionKey({kind:'ekko',link:link()}),sessionKey({kind:'ekko',link:link(B)}));assert.deepEqual(sessionChoices(null,[],[link(),link(B)],A),[{kind:'ekko',link:link()}]);
});
test('production room UI associates without switching and restores document drafts, sources, Agents, height and pending',async()=>{
 const s=storage(),rooms=new RoomLinkStore(s,async()=>[]),pending=new PendingRoomSendStore(s),drafts=new Map();let doc=A;const sent:any[]=[];
 const dom=new JSDOM(createChatShell());const root=dom.window.document.querySelector<HTMLElement>('.sac')!;
 const connection={id:work.connectionId,deviceId:work.deviceId,accountUserId:7,accountName:'虚构账号',state:'connected'};
 const client={connection:async()=>({connection}),pair:async()=>({connection}),rooms:async()=>({rooms:[{id:'room-a',name:'虚构房间'}],hasMore:false,total:1}),room:async()=>({room:{id:'room-a',name:'虚构房间'},messages:[],agents:[{roomId:'room-a',agentId:'agent-a',name:'虚构助手'}],hasMore:false}),events:async(_id:string,_cb:any,signal?:AbortSignal)=>new Promise<void>(resolve=>signal?.addEventListener('abort',()=>resolve(),{once:true})),send:async(...args:any[])=>{sent.push(args);return {state:'unknown' as const};},sendStatus:async()=>({state:'unknown' as const})};
 const options={drafts,client:()=>client,store:rooms,pendingStore:pending,getWorkId:()=>null,getDocumentRootId:()=>doc,availableSources:async()=>[{label:'当前文档',source:{kind:'document' as const,documentId:doc}}],loadSource:async(source:any)=>({kind:'document' as const,documentId:source.documentId,title:'虚构',text:'资料'})};
 let ui=new EkkoRoomUI(root,options);try{
 await ui.enter();await ui.linkRoom('room-a');assert.equal(ui.activeLink,null);await ui.openRoom('room-a');assert.equal((ui.activeLink as RoomLink | null)?.workId,null);
 const compose=()=>root.querySelector<HTMLTextAreaElement>('[data-ekko-composer]')!;compose().value='A 草稿';root.querySelector<HTMLInputElement>('[data-ekko-source]')!.checked=true;root.querySelector<HTMLInputElement>('[data-ekko-agent]')!.checked=true;root.querySelector<HTMLElement>('[data-composer-resize]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));await ui.sendCurrent();const original=ui.unknownMessageId();assert.ok(original);const height=[...drafts.values()][0].composerHeight;
 doc=B;await ui.documentChanged();await ui.linkRoom('room-a');await ui.openRoom('room-a');assert.equal(compose().value,'');assert.equal(ui.unknownMessageId(),undefined);compose().value='B 草稿';
 doc=A;await ui.documentChanged();await ui.openRoom('room-a');assert.equal(compose().value,'A 草稿');assert.equal(ui.unknownMessageId(),original);assert.equal(root.querySelector<HTMLInputElement>('[data-ekko-source]')!.checked,true);assert.equal(root.querySelector<HTMLInputElement>('[data-ekko-agent]')!.checked,true);assert.equal([...drafts.values()][0].composerHeight,height);await ui.sendCurrent();assert.equal(sent.length,1);
 ui.dispose();ui=new EkkoRoomUI(root,options);await ui.enter();await ui.openRoom('room-a');assert.equal(compose().value,'A 草稿');assert.equal(ui.unknownMessageId(),original);
 }finally{ui.dispose();dom.window.close();}
});
test('pending store rejects different identity on another document before persisting corrupt state',async()=>{
 const s=storage(),pending=new PendingRoomSendStore(s);await pending.remember(link(),'original-a');const before=structuredClone(s.values.get('ekko-send-pending-v1'));
 await assert.rejects(pending.remember({...link(B),deviceId:'device-b'},'original-b'),/身份|冲突/);assert.deepEqual(s.values.get('ekko-send-pending-v1'),before);
});
test('document links preserve an existing nonempty formal relationship snapshot and reject duplicate stored scopes',async()=>{
 const s=storage();const formal={schema:2,works:['work-a'],chats:[{chatId:'fictional-existing',workId:'work-a',documentRootId:A}],tasks:[{taskId:'fictional-task',workId:'work-a'}],pins:{'fictional-existing':[{documentId:A,kind:'document',blockId:null}]}};s.values.set('work-formal-v2',structuredClone(formal));const rooms=new RoomLinkStore(s,async()=>['work-a']);await rooms.linkRoom(work);await rooms.linkRoom(link());assert.deepEqual(s.values.get('work-formal-v2'),formal);
 const bad={schema:1,links:[link(),link()]};s.values.set('work-rooms-v1',bad);await assert.rejects(rooms.linkRoom(link(B)),/损坏|版本/);assert.deepEqual(s.values.get('work-rooms-v1'),bad);
});
test('invalid or duplicate document pending rows fail closed without overwriting original data',async()=>{
 const item={...link(),clientMessageId:'original-a',state:'unknown'};delete (item as any).roomNameAtLink;
 for(const items of [[{...item,documentRootId:'bad'}],[{...item,workId:undefined}],[item,item],[{...item,extra:'正文'}]]){const s=storage(),bad={schema:1,items};s.values.set('ekko-send-pending-v1',bad);const pending=new PendingRoomSendStore(s);await assert.rejects(pending.remember(link(B),'original-b'),/损坏|版本/);assert.deepEqual(s.values.get('ekko-send-pending-v1'),bad);}
});
