import test from 'node:test';
import assert from 'node:assert/strict';
import { taskProgress, taskCompletionReminder } from '../src/task/presentation.ts';
import type {TaskLookup} from '../src/task/reader.ts';
const found=(title:string,completed=false):TaskLookup=>({kind:'found',value:{id:title,title,completed,documentId:null,projectId:null,createdAt:''}});
test('统计来自实际读取结果，完成、未完成、未知与缺失分别计数',()=>{
 assert.deepEqual(taskProgress([found('a',true),found('b'),{kind:'unavailable',reason:'offline'},{kind:'missing'}]),{total:4,completed:1,incomplete:1,unknown:1,missing:1});
 assert.deepEqual(taskProgress([]),{total:0,completed:0,incomplete:0,unknown:0,missing:0});
});
test('完成Work提醒只列最多五个未完成名称与剩余、未知、缺失数',()=>{
 const input=[found('已做完',true),...['甲','乙','丙','丁','戊','己','庚'].map(x=>found(x)),{kind:'unavailable',reason:'offline'} as TaskLookup,{kind:'missing'} as TaskLookup];
 const text=taskCompletionReminder(input);for(const name of ['甲','乙','丙','丁','戊'])assert.ok(text.includes(name));
 assert.doesNotMatch(text,/己|庚|已做完/);assert.match(text,/另有 2/);assert.match(text,/未知 1/);assert.match(text,/缺失 1/);assert.match(text,/任务.*不.*更改|不会.*任务/);
});
