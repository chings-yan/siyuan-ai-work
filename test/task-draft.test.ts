import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
const source={kind:'answer' as const,key:'frozen-session-message-v1',documentId:'20261106000000-aaaaaaa',documentTitle:'虚构来源'};
async function model(){assert.ok(existsSync(new URL('../src/task/draft.ts',import.meta.url)),'task drafts must preserve source and explicit to-do extraction');return import('../src/task/draft.ts');}

test('task draft extracts only open explicit checkboxes outside fenced and indented examples',async()=>{
 const {prepareTaskDrafts}=await model();
 const body='- [ ] 核对合同\n- [x] 已完成\n```md\n- [ ] 代码示例\n```\n~~~\n- [ ] 另一个示例\n~~~\n    - [ ] 缩进代码\n> - [ ] 引用示例\n  * [ ] 补充记录\n普通内容';
 const result=prepareTaskDrafts({source,body});
 assert.deepEqual(result.items.map(item=>item.title),['核对合同','补充记录']);assert.equal(result.originalBody,body);assert.equal(result.extracted,true);
});
test('task draft ordinary answer preserves its complete text and never silently truncates its title',async()=>{
 const {prepareTaskDrafts,taskDraftIssue}=await model();const body='很长的标题'.repeat(100)+'\r\n  完整说明\n';
 const result=prepareTaskDrafts({source,body});assert.equal(result.items.length,1);assert.equal(result.items[0].title,body.split('\r\n')[0]);assert.equal(result.items[0].description,body);assert.match(taskDraftIssue(result.items[0])||'',/标题/);
});
test('task draft completed items and code examples do not become proposed new tasks',async()=>{
 const {prepareTaskDrafts}=await model();const result=prepareTaskDrafts({source,body:'- [x] 已办事项\n```\n- [ ] 示例\n```'});
 assert.equal(result.extracted,false);assert.equal(result.items.length,1);assert.equal(result.items[0].title,'');assert.match(result.originalBody,/示例/);
});
test('task draft rejects empty source and oversized input without a partial task list',async()=>{
 const {prepareTaskDrafts}=await model();assert.throws(()=>prepareTaskDrafts({source,body:' \n\t'}),/空|内容/);
 assert.throws(()=>prepareTaskDrafts({source:{...source,key:''},body:'任务'}),/来源/);
 assert.throws(()=>prepareTaskDrafts({source:{...source,documentId:'bad-id'},body:'任务'}),/文档/);
 assert.throws(()=>prepareTaskDrafts({source,body:'字'.repeat(100001)}),/过长|100000/);
});
test('task draft copy contains only reviewed fields and a validated source URI',async()=>{
 const {prepareTaskDrafts,serializeTaskDraft}=await model();const input={source:{...source},body:'原始回答'};const result=prepareTaskDrafts(input);
 input.source.documentTitle='被外部改动';const text=serializeTaskDraft({...result.items[0],title:'核对项目',description:'已编辑的说明\n保留第二行'},result.source);
 assert.equal(text,'标题：核对项目\n\n说明：\n已编辑的说明\n保留第二行\n\n来源文档：虚构来源\nsiyuan://blocks/20261106000000-aaaaaaa');assert.doesNotMatch(text,/原始回答|frozen-session-message/);
});
test('task draft copy refuses invalid reviewed title and retains complete body for explicit editing',async()=>{
 const {prepareTaskDrafts,serializeTaskDraft}=await model();const result=prepareTaskDrafts({source,body:'说明'});
 assert.throws(()=>serializeTaskDraft({...result.items[0],title:' '},result.source),/标题/);
 assert.throws(()=>serializeTaskDraft({...result.items[0],title:'第一行\n第二行'},result.source),/标题/);
 const item={...result.items[0],title:'标题',description:'x'.repeat(100001)};assert.throws(()=>serializeTaskDraft(item,result.source),/说明/);
});

test('task draft fence length, marker and unfinished fences exclude lookalike checkboxes',async()=>{
 const {prepareTaskDrafts}=await model();const body='````text\n```\n- [ ] 仍在围栏中\n~~~~\n- [ ] 不同标记仍是代码\n````\n+ [ ] 真正待办\n~~~js\n- [ ] 未关闭的围栏';
 const result=prepareTaskDrafts({source,body});assert.deepEqual(result.items.map(item=>item.title),['真正待办']);assert.equal(result.originalBody,body);
});
test('task draft explicit size bound refuses all excess candidates without silently dropping any',async()=>{
 const {prepareTaskDrafts}=await model();const hundred=Array.from({length:100},(_,index)=>`- [ ] 事项 ${index}`).join('\n');assert.equal(prepareTaskDrafts({source,body:hundred}).items.length,100);assert.throws(()=>prepareTaskDrafts({source,body:hundred+'\n- [ ] 第101项'}),/100.*项/);
});
test('task draft Unicode count and source-free copy never invent a document location',async()=>{
 const {prepareTaskDrafts,serializeTaskDraft,taskDraftIssue}=await model();const result=prepareTaskDrafts({source:{...source,kind:'selection',documentId:null,documentTitle:''},body:'😀'.repeat(200)});assert.equal(taskDraftIssue(result.items[0]),null);assert.doesNotMatch(serializeTaskDraft(result.items[0],result.source),/siyuan:|来源文档/);assert.equal(result.items[0].title,'😀'.repeat(200));assert.equal(Object.isFrozen(result.source),true);
});
