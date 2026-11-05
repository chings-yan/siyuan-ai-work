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
