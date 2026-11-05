import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WorkGoalForm } from '../src/work/goal-form.ts';
import type { WorkCreator } from '../src/work/create.ts';

const workId='20260930190000-abcdef0';
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));

test('management adds an optional Goal only after showing its exact target and confirmation',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  let approved=false,prompt='',calls=0,refreshed=0;dom.window.confirm=(value:string)=>{prompt=value;return approved;};
  const creator={goalPending:async()=>null,addGoal:async(id:string,goal:string,confirmed:boolean)=>{assert.equal(id,workId);assert.equal(goal,'后补目标');assert.equal(confirmed,true);calls++;return {kind:'complete',operationId:`work-goal:${id}`,work:{id},message:'目标已读回'};}} as unknown as WorkCreator;
  const form=new WorkGoalForm(creator,async()=>{refreshed++;});await form.open(workId,'我的 Work');await tick();
  const input=dom.window.document.querySelector<HTMLTextAreaElement>('[name="goal"]');assert.ok(input);input.value='后补目标';input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));
  dom.window.document.querySelector<HTMLButtonElement>('[data-goal-action="submit"]')!.click();assert.equal(calls,0);assert.match(prompt,/我的 Work.*后补目标/s);
  approved=true;dom.window.document.querySelector<HTMLButtonElement>('[data-goal-action="submit"]')!.click();await tick();
  assert.equal(calls,1);assert.equal(refreshed,1);assert.match(dom.window.document.body.textContent||'',/目标已读回/);
  form.dispose();dom.window.close();
});

test('unknown previous Goal write is shown as read-only reconciliation',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const pending={id:`work-goal:${workId}`,workId,kind:'work',state:'unknown',details:JSON.stringify({version:1,goal:'旧目标',attempted:true}),updatedAt:'2026-09-30'};
  let calls=0;const creator={goalPending:async()=>pending,addGoal:async(_id:string,goal:string)=>{assert.equal(goal,'旧目标');calls++;return {kind:'pending',operationId:pending.id,work:null,message:'仍待核对，不再次写入'};}} as unknown as WorkCreator;
  const form=new WorkGoalForm(creator,async()=>{});await form.open(workId,'旧 Work');await tick();
  assert.equal(dom.window.document.querySelector<HTMLTextAreaElement>('[name="goal"]')?.readOnly,true);
  const button=dom.window.document.querySelector<HTMLButtonElement>('[data-goal-action="submit"]');assert.match(button?.textContent||'',/核对/);
  button!.click();await tick();assert.equal(calls,1);assert.match(dom.window.document.body.textContent||'',/不再次写入/);
  form.dispose();dom.window.close();
});

test('a written Goal with a pending record can still be reconciled from management',async()=>{
  const dom=new JSDOM('<body></body>');Object.assign(globalThis,{document:dom.window.document,window:dom.window});
  const pending={id:`work-goal:${workId}`,workId,kind:'work',state:'unknown',details:JSON.stringify({version:1,goal:'已经写入的目标',attempted:true}),updatedAt:'2026-09-30'};
  let checked=0;const creator={goalPending:async()=>pending,addGoal:async(_id:string,goal:string)=>{assert.equal(goal,'已经写入的目标');checked++;return {kind:'complete',operationId:pending.id,work:{id:workId},message:'目标记录已核对'};}} as unknown as WorkCreator;
  const form=new WorkGoalForm(creator,async()=>{});await form.open(workId,'已有目标 Work','已经写入的目标');await tick();
  assert.match(dom.window.document.querySelector('[data-goal-action="submit"]')?.textContent||'',/核对/);
  dom.window.document.querySelector<HTMLButtonElement>('[data-goal-action="submit"]')!.click();await tick();assert.equal(checked,1);
  form.dispose();dom.window.close();
});
