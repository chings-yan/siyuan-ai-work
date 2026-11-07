import test from 'node:test';
import assert from 'node:assert/strict';
import { ReplyActivityStore } from '../src/work/reply-activity.ts';
import type { ChatLink } from '../src/work/store.ts';
const link:ChatLink={chatId:'chat-a',workId:null,documentRootId:'20261106000000-aaaaaaa',connectionId:'studio-default',adapter:'studio',profile:'default',installId:null,storedSessionId:'session-a',title:'虚构对话',state:'ready'};
test('new replies require an observed current run and acknowledgements do not resolve review state',()=>{
 const store=new ReplyActivityStore();const revision=store.begin('a',{connection:'connection-1',link});
 assert.equal(store.list('connection-1')[0].state,'waiting');
 store.update('a',revision,'review');store.acknowledge('a',revision);
 assert.equal(store.list('connection-1')[0].state,'review');assert.equal(store.list('connection-1')[0].acknowledged,true);
});
test('late result and old acknowledgement cannot replace or acknowledge another attempt',()=>{
 const store=new ReplyActivityStore();const old=store.begin('a',{connection:'c',link});const fresh=store.begin('a',{connection:'c',link});
 assert.equal(store.update('a',old,'unread','old'),false);assert.equal(store.acknowledge('a',old),false);
 assert.equal(store.list('c')[0].state,'waiting');store.update('a',fresh,'unread','new');assert.equal(store.list('c')[0].messageId,'new');
});
test('connection identities and copied snapshots isolate activity from current selections',()=>{
 const store=new ReplyActivityStore();store.begin('a',{connection:'one',link});store.begin('b',{connection:'two',link:{...link,title:'其他'}});
 const row=store.list('one')[0];row.target.link.title='污染';assert.equal(store.list('one')[0].target.link.title,'虚构对话');assert.equal(store.list('two').length,1);
});
test('acknowledgement cannot dismiss a running turn and terminal state is monotone',()=>{
 const store=new ReplyActivityStore();const n=store.begin('a',{connection:'c',link});assert.equal(store.acknowledge('a',n),false);
 store.update('a',n,'unread');assert.equal(store.update('a',n,'waiting'),false);assert.equal(store.list('c')[0].state,'unread');
});
test('completed activity is bounded without removing the active turn',()=>{
 const store=new ReplyActivityStore();store.begin('running',{connection:'c',link});
 for(let i=0;i<110;i++){const n=store.begin('k'+i,{connection:'c',link});store.update('k'+i,n,'unread');}
 assert.equal(store.list('c').length,100);assert.ok(store.list('c').some(x=>x.key==='running'));
});
test('only exact waiting relation can acquire the confirmed persistent session identity',()=>{
 const store=new ReplyActivityStore();const pending={...link,state:'pending' as const,storedSessionId:null};const n=store.begin('a',{connection:'c',link:pending});
 assert.equal(store.confirmTarget('a',n,{...link,profile:'other'}),false);assert.equal(store.confirmTarget('a',n-1,link),false);
 assert.equal(store.confirmTarget('a',n,link),true);assert.equal(store.list('c')[0].target.link.storedSessionId,'session-a');
 assert.equal(store.confirmTarget('a',n,{...link,storedSessionId:'session-b'}),false);
 store.update('a',n,'unread');assert.equal(store.confirmTarget('a',n,link),false);
});
