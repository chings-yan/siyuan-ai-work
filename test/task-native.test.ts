import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import type { App, IProtyle, Protyle, Plugin } from 'siyuan';
import { NativeTaskAdapter } from '../src/task/native.ts';

const documentId = '20261002120000-aaaaaaa';
function fixture() {
  const dom = new JSDOM('<body><div id="editor"></div></body>');
  const app = { appId: 'current-window', plugins: [] } as unknown as App;
  const element = dom.window.document.querySelector('#editor') as HTMLElement;
  const protyle = { app, block: { rootID: documentId }, element } as IProtyle;
  const wrapper = { protyle } as Protyle;
  const calls: unknown[] = [];
  const plugin = { name: 'siyuan-plugin-task-note-management', app, commands: [
    { langKey: 'shortcutSetDocumentAsTask', editorCallback: (editor: IProtyle) => { calls.push(editor); } },
    { langKey: 'shortcutOpenCalendarView', callback: () => { calls.push('calendar'); } },
  ] } as unknown as Plugin;
  app.plugins.push(plugin);
  let editors: Protyle[] = [wrapper];
  const deps = { document: dom.window.document, getAllEditor: () => editors, wait: async () => {} };
  return { app, dom, element, protyle, wrapper, plugin, calls, deps, setEditors: (value: Protyle[]) => { editors = value; } };
}
const request = () => ({ documentId, workId: 'work-a', isCurrent: () => true });

// Removing retained state or passing the SDK wrapper would cause a second invocation / wrong argument.
test('原生表单只接收真实protyle；返回后保留opened，明确准备下一次前拒绝重复', async () => {
  const f = fixture(); const adapter = new NativeTaskAdapter(f.app, f.deps);
  const first = await adapter.open(request());
  assert.equal(first.kind, 'opened'); assert.equal(f.calls[0], f.protyle);
  assert.match(first.reason, /发起|表单/); assert.match(first.reason, /核对|保存/);
  assert.equal('taskId' in first, false);
  await adapter.open(request()); assert.equal(f.calls.length, 1);
  assert.equal(adapter.prepareNext(), true);
  await adapter.open(request()); assert.equal(f.calls.length, 2);
});

test('没有确定文档只打开原生日历，不借用活动编辑器预填文档', async () => {
  const f = fixture(); const adapter = new NativeTaskAdapter(f.app, f.deps);
  const result = await adapter.open({ documentId: null, isCurrent: () => true });
  assert.equal(result.kind, 'opened'); assert.deepEqual(f.calls, ['calendar']);
  assert.equal(result.target?.documentId, null);
});

test('插件必须精确匹配且命令已注册，调用前失败可恢复再试', async () => {
  const f = fixture(); Object.defineProperty(f.plugin, 'name', { value: 'similar-task-plugin', configurable: true });
  const adapter = new NativeTaskAdapter(f.app, f.deps);
  const absent = await adapter.open(request());
  assert.equal(absent.kind, 'blocked'); assert.match(absent.reason, /插件/); assert.equal(f.calls.length, 0);
  Object.defineProperty(f.plugin, 'name', { value: 'siyuan-plugin-task-note-management' });
  const commands = f.plugin.commands; f.plugin.commands = [];
  const missing = await adapter.open(request());
  assert.equal(missing.kind, 'blocked'); assert.match(missing.reason, /命令|入口/);
  f.plugin.commands = commands;
  assert.equal((await adapter.open(request())).kind, 'opened');
});

for (const invalid of ['other-app', 'other-window', 'detached', 'wrong-root', 'bare-protyle'] as const) {
  test('拒绝不可靠编辑器：' + invalid, async () => {
    const f = fixture();
    if (invalid === 'other-app') f.protyle.app = { appId: 'other', plugins: [] } as App;
    if (invalid === 'other-window') {
      const other = new JSDOM('<body><div></div></body>');
      f.protyle.element = other.window.document.querySelector('div') as HTMLElement;
    }
    if (invalid === 'detached') f.element.remove();
    if (invalid === 'wrong-root') f.protyle.block.rootID = '20261002120000-bbbbbbb';
    if (invalid === 'bare-protyle') f.setEditors([f.protyle as unknown as Protyle]);
    const result = await new NativeTaskAdapter(f.app, f.deps).open(request());
    assert.equal(result.kind, 'blocked'); assert.match(result.reason, /文档|编辑器/); assert.equal(f.calls.length, 0);
  });
}

test('先打开冻结目标，再有限等待正确编辑器，不能用先到的其他文档替代', async () => {
  const f = fixture(); f.setEditors([]); let waits = 0; const opened: string[] = [];
  const target = request();
  const adapter = new NativeTaskAdapter(f.app, { ...f.deps,
    openDocument: async (id) => { opened.push(id); target.documentId = '20261002120000-bbbbbbb'; },
    wait: async () => { waits++; if (waits === 2) f.setEditors([f.wrapper]); },
    editorAttempts: 3,
  });
  const result = await adapter.open(target);
  assert.equal(result.kind, 'opened'); assert.deepEqual(opened, [documentId]);
  assert.equal(result.target?.documentId, documentId); assert.equal(f.calls[0], f.protyle); assert.equal(waits, 2);
});

test('编辑器等待有界，目标始终未就绪时只反馈失败', async () => {
  const f = fixture(); f.setEditors([]); let waits = 0; let opens = 0;
  const adapter = new NativeTaskAdapter(f.app, { ...f.deps, editorAttempts: 3,
    openDocument: async () => { opens++; }, wait: async () => { waits++; },
  });
  const result = await adapter.open(request());
  assert.equal(result.kind, 'blocked'); assert.equal(opens, 1); assert.equal(waits, 2); assert.equal(f.calls.length, 0);
});

test('等待期间用户导航后停止，不发起原生命令也不再次打开旧文档', async () => {
  const f = fixture(); f.setEditors([]); let current = true; let opens = 0;
  const adapter = new NativeTaskAdapter(f.app, { ...f.deps, editorAttempts: 3,
    openDocument: async () => { opens++; }, wait: async () => { current = false; f.setEditors([f.wrapper]); },
  });
  const result = await adapter.open({ ...request(), isCurrent: () => current });
  assert.equal(result.kind, 'blocked'); assert.match(result.reason, /变化|切换|失效/);
  assert.equal(opens, 1); assert.equal(f.calls.length, 0);
});

test('最终异步guard后重新核对root，防止检查中编辑器变成其他文档', async () => {
  const f = fixture(); let checks = 0;
  const adapter = new NativeTaskAdapter(f.app, f.deps);
  const result = await adapter.open({ ...request(), isCurrent: async () => {
    checks++; if (checks > 1) f.protyle.block.rootID = '20261002120000-bbbbbbb'; return true;
  } });
  assert.equal(result.kind, 'blocked'); assert.equal(f.calls.length, 0);
});

test('等待中插件被卸载时拒绝旧命令', async () => {
  const f = fixture(); f.setEditors([]);
  const adapter = new NativeTaskAdapter(f.app, { ...f.deps, openDocument: async () => {
    f.setEditors([f.wrapper]); f.app.plugins.length = 0;
  } });
  assert.equal((await adapter.open(request())).kind, 'blocked'); assert.equal(f.calls.length, 0);
});

test('命令执行中的双击和prepareNext不能绕过重复保护', async () => {
  const f = fixture(); let finish!: () => void;
  f.plugin.commands[0].editorCallback = (() => { f.calls.push('started'); return new Promise<void>(resolve => { finish = resolve; }); }) as any;
  const adapter = new NativeTaskAdapter(f.app, f.deps); const pending = adapter.open(request());
  for (let attempt = 0; !finish && attempt < 10; attempt++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function', '原生命令应在有界等待内发起');
  assert.equal(adapter.getState().kind, 'opening'); assert.equal(adapter.prepareNext(), false);
  await adapter.open(request()); assert.equal(f.calls.length, 1);
  finish(); assert.equal((await pending).kind, 'opened');
});

test('调用后错误保持unknown，先核对再明确下一次；不当成未创建而自动重试', async () => {
  const f = fixture();
  f.plugin.commands[0].editorCallback = () => { f.calls.push('attempt'); throw new Error('native failure'); };
  const adapter = new NativeTaskAdapter(f.app, f.deps);
  const result = await adapter.open(request());
  assert.equal(result.kind, 'unknown'); assert.match(result.reason, /核对|未知/);
  await adapter.open(request()); assert.equal(f.calls.length, 1);
  assert.equal(adapter.getState().kind, 'unknown');
  adapter.prepareNext(); await adapter.open(request()); assert.equal(f.calls.length, 2);
});

test('原生命令不返回时超时标记unknown，迟到返回仍不能解除重复保护', async () => {
  const f = fixture(); let finish!: () => void;
  f.plugin.commands[0].editorCallback = (() => { f.calls.push('attempt'); return new Promise<void>(resolve => { finish = resolve; }); }) as any;
  const adapter = new NativeTaskAdapter(f.app, { ...f.deps, commandTimeoutMs: 5 });
  assert.equal((await adapter.open(request())).kind, 'unknown');
  finish(); await new Promise(resolve => setImmediate(resolve));
  await adapter.open(request()); assert.equal(f.calls.length, 1); assert.equal(adapter.getState().kind, 'unknown');
});

test('返回状态不能被调用方篡改以解锁或替换冻结目标', async () => {
  const f = fixture(); const adapter = new NativeTaskAdapter(f.app, f.deps);
  const result = await adapter.open(request());
  assert.throws(() => { (result as any).kind = 'idle'; }, TypeError);
  assert.throws(() => { (result.target as any).documentId = 'other'; }, TypeError);
  await adapter.open(request()); assert.equal(f.calls.length, 1); assert.equal(adapter.getState().target?.documentId, documentId);
});
