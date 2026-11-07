import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTaskReader, shouldClearCurrentTask } from '../src/task/reader.ts';

test('任务暂时失联保留当前引用，仅明确完成或不存在时清空', () => {
  assert.equal(shouldClearCurrentTask('a', 'a', { kind: 'unavailable', reason: 'offline' }), false);
  assert.equal(shouldClearCurrentTask('b', 'a', { kind: 'missing' }), false);
  assert.equal(shouldClearCurrentTask('a', 'a', { kind: 'missing' }), true);
  assert.equal(shouldClearCurrentTask('a', 'a', { kind: 'found', value: { id: 'a', title: '任务', completed: true, documentId: null, projectId: null, createdAt: '' } }), true);
});

test('原生 MCP 只调用读取 action，解析动态命名工具和连接失败', async () => {
  const methods: string[] = [];
  let number = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)); methods.push(body.method + (body.params?.arguments?.action ? `:${body.params.arguments.action}` : ''));
    number++;
    const result = number === 1 ? { capabilities: {} } : number === 2 ? { tools: [{ name: 'plugin__siyuan_plugin_task_note_management__task__abc' }] } : { structuredContent: { success: true, data: [{ id: 't1', title: '测试任务', completed: false, createdAt: '2026-09-23' }] } };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'Mcp-Session-Id': 'test-session' } });
  };
  const reader = new NativeTaskReader(fetcher);
  const result = await reader.listRecent();
  assert.equal(result.kind, 'found');
  assert.deepEqual(methods, ['initialize', 'tools/list', 'tools/call:search_task']);
  const unavailable = await new NativeTaskReader(async () => { throw new Error('offline'); }).getTask('t1');
  assert.deepEqual(unavailable, { kind: 'unavailable', reason: 'offline' });
});

test('最近推荐只读取未完成任务，按创建时间排序且不推荐已完成项', async () => {
  const searchCalls: Record<string, unknown>[] = [];
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    let result: unknown = { capabilities: {} };
    if (body.method === 'tools/list') result = { tools: [{ name: 'plugin__siyuan_plugin_task_note_management__task__abc' }] };
    if (body.method === 'tools/call') {
      searchCalls.push(body.params.arguments);
      result = { structuredContent: { success: true, data: [
        { id: 'done', title: '已完成', completed: true, createdAt: '2026-09-27T10:00:00Z' },
        { id: 'open-old', title: '较早未完成', completed: false, createdAt: '2026-09-25T10:00:00Z' },
        { id: 'open-new', title: '最近未完成', completed: false, createdAt: '2026-09-26T10:00:00Z' },
      ] } };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'Mcp-Session-Id': 'test-session' } });
  };
  const result = await new NativeTaskReader(fetcher).listRecent(5);
  assert.equal(result.kind, 'found');
  if (result.kind === 'found') assert.deepEqual(result.value.map(task => task.id), ['open-new', 'open-old']);
  assert.equal(searchCalls[0]?.completed, false);
});

test('任务接口先截取后返回时，推荐仍包含真正最近创建的任务', async () => {
  let requestedLimit = 0;
  const tasks = Array.from({ length: 8 }, (_, index) => ({
    id: `task-${index}`, title: `任务 ${index}`, completed: false,
    createdAt: `2026-09-${String(index + 1).padStart(2, '0')}T10:00:00Z`,
  }));
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    let result: unknown = { capabilities: {} };
    if (body.method === 'tools/list') result = { tools: [{ name: 'plugin__siyuan_plugin_task_note_management__task__abc' }] };
    if (body.method === 'tools/call') {
      requestedLimit = body.params.arguments.limit;
      result = { structuredContent: { success: true, data: tasks.slice(0, requestedLimit) } };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  };
  const result = await new NativeTaskReader(fetcher).listRecent(5);
  assert.equal(result.kind, 'found');
  if (result.kind === 'found') assert.deepEqual(result.value.map(task => task.id), ['task-7', 'task-6', 'task-5', 'task-4', 'task-3']);
  assert.ok(requestedLimit > 5);
});

test('未完成任务超过可核对数量时，不把截断列表称为最近推荐', async () => {
  const fetcher: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    let result: unknown = { capabilities: {} };
    if (body.method === 'tools/list') result = { tools: [{ name: 'plugin__siyuan_plugin_task_note_management__task__abc' }] };
    if (body.method === 'tools/call') {
      result = { structuredContent: { success: true, data: Array.from({ length: body.params.arguments.limit }, (_, index) => ({
        id: `task-${index}`, title: `任务 ${index}`, completed: false, createdAt: '2026-09-27T10:00:00Z',
      })) } };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  };
  const result = await new NativeTaskReader(fetcher).listRecent(5);
  assert.equal(result.kind, 'unavailable');
  if (result.kind === 'unavailable') assert.match(result.reason, /无法可靠推荐/);
});

function responseReader(data:unknown) {
  return new NativeTaskReader(async(_url,init)=>{
    const body=JSON.parse(String(init?.body));
    const result=body.method==='tools/list'?{tools:[{name:'plugin__siyuan_plugin_task_note_management__task__fixture'}]}:body.method==='tools/call'?{structuredContent:{success:true,data}}:{};
    return new Response(JSON.stringify({result}),{status:200});
  });
}
for(const completed of [undefined,null,0,'false','true'])test(`非法完成标记 ${String(completed)} 不清当前引用`,async()=>{
  const result=await responseReader({id:'exact',title:'虚构任务',completed}).getTask('exact');
  assert.equal(result.kind,'unavailable');assert.equal(shouldClearCurrentTask('exact','exact',result),false);
});
test('合法原始块与独立进度保留，未提供的可选字段不补默认值',async()=>{
  const result=await responseReader({id:'exact',title:'虚构任务',completed:false,blockId:'20261105120000-aaaaaaa',customProgress:37,kanbanStatus:'opaque-native-status'}).getTask('exact');
  assert.equal(result.kind,'found');if(result.kind!=='found')return;
  assert.equal(result.value.blockId,'20261105120000-aaaaaaa');assert.equal(result.value.customProgress,37);assert.equal(result.value.kanbanStatus,'opaque-native-status');
  const bare=await responseReader({id:'exact',title:'虚构任务',completed:false}).getTask('exact');
  assert.equal(bare.kind,'found');if(bare.kind==='found')assert.equal(Object.hasOwn(bare.value,'customProgress'),false);
});
test('畸形块不可伪造无绑定任务；非法进度与状态不展示',async()=>{
  const malformed=await responseReader({id:'exact',title:'虚构任务',completed:false,blockId:{id:'unsafe'}}).getTask('exact');assert.equal(malformed.kind,'unavailable');
  for(const customProgress of [-1,101,'50']){
    const result=await responseReader({id:'exact',title:'虚构任务',completed:false,customProgress,kanbanStatus:42}).getTask('exact');
    assert.equal(result.kind,'found');if(result.kind==='found'){assert.equal(Object.hasOwn(result.value,'customProgress'),false);assert.equal(Object.hasOwn(result.value,'kanbanStatus'),false);}
  }
});
test('搜索遇到非法完成状态明确不可读取，不把未知推荐为未完成',async()=>{
  const result=await responseReader([{id:'exact',title:'未知状态'}]).listRecent();assert.equal(result.kind,'unavailable');
});

test('default native fetch preserves its host receiver without changing injected transports',async()=>{
 const prior=globalThis.fetch;let calls=0;
 globalThis.fetch=async function(input,init){assert.equal(this,globalThis);assert.equal(input,'/mcp');calls++;const body=JSON.parse(String(init?.body));return new Response(JSON.stringify({result:body.method==='tools/list'?{tools:[{name:'plugin__siyuan_plugin_task_note_management__task__synthetic'}]}:body.method==='tools/call'?{structuredContent:{success:true,data:[]}}:{}}),{status:200,headers:{'Content-Type':'application/json'}});};
 try{assert.deepEqual(await new NativeTaskReader().listRecent(),{kind:'found',value:[]});assert.equal(calls,3);}finally{globalThis.fetch=prior;}
});
