import type {TaskLookup} from './reader.ts';
/** 只使用本轮读取结果；缺失不视为已完成，进度字段也不替代完成标记。 */
export function taskProgress(tasks:readonly TaskLookup[]){
 const counts={total:tasks.length,completed:0,incomplete:0,unknown:0,missing:0};
 for(const task of tasks){if(task.kind==='missing')counts.missing++;else if(task.kind==='unavailable')counts.unknown++;else if(task.value.completed)counts.completed++;else counts.incomplete++;}
 return counts;
}
export function taskProgressLabel(tasks:readonly TaskLookup[]):string{
 const n=taskProgress(tasks);return n.total?`已完成 ${n.completed}/${n.total} · 未完成 ${n.incomplete} · 未知 ${n.unknown} · 缺失 ${n.missing}`:'未关联任务';
}
export function taskCompletionReminder(tasks:readonly TaskLookup[]):string{
 const n=taskProgress(tasks),unfinished=tasks.flatMap(task=>task.kind==='found'&&!task.value.completed?[task.value.title]:[]);
 return `关联任务：${taskProgressLabel(tasks)}。${unfinished.length?`\n未完成：${unfinished.slice(0,5).join('、')}${unfinished.length>5?`；另有 ${unfinished.length-5} 项未完成`:''}。`:''}\nWork 状态独立，本次不会更改任务或项目。${n.unknown||n.missing?'请在原任务插件核对未知或缺失项。':''}`;
}
