import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
import Module from 'node:module';

function harness(t: import('node:test').TestContext) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="dock"></div></body></html>');
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, MutationObserver: dom.window.MutationObserver });
  let dock: any;
  const container = dom.window.document.getElementById('dock')!;
  class PluginStub {
    addTab() {}
    eventBus = { on: () => undefined, off: () => undefined };
    async loadData() { return undefined; }
    async saveData() {}
    addIcons() {}
    addDock(options: any) { dock = options; options.init.call({ element: container }); return {}; }
  }
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function(request: string, parent: any, isMain: boolean) {
    if (request === 'siyuan') return { Plugin: PluginStub, getAllEditor: () => [] };
    return originalLoad.call(this, request, parent, isMain);
  };
  let PluginClass: any;
  try { const require = createRequire(import.meta.url); delete require.cache[require.resolve('../dist/index.js')]; PluginClass = require('../dist/index.js').default; }
  finally { (Module as any)._load = originalLoad; }
  const plugin = new PluginClass();
  plugin.currentDocumentId = () => '';
  plugin.onload();
  t.after(() => { plugin.onunload(); dom.window.close(); });
  const room = plugin.roomViews.get(container);
  room.options.client = () => ({ connection: async () => ({ connection: null }) });
  return { plugin, dom, container, room, destroy: () => dock.destroy.call({ element: container }) };
}

test('packaged dock mounts EKKO surface on the styled shell and preserves the Serve choice', async t => {
  const f = harness(t);
  const shell = f.container.querySelector<HTMLElement>('.sac')!;
  assert.equal(f.plugin.selectedConnectionId,'serve-local');assert.ok(shell.querySelector('[data-action="toggle-settings"]'));
  const composer = shell.querySelector<HTMLTextAreaElement>('[data-composer] textarea')!;
  composer.value = 'Hermes 草稿';
  await f.room.enter();
  assert.equal(shell.dataset.surface, 'ekko');
  assert.equal(shell.querySelector('[data-composer]')!.matches('.sac[data-surface="ekko"] [data-chat-only]'), true);
  assert.equal(shell.querySelector<HTMLElement>('[data-ekko-panel]')!.hidden, false);
  f.room.leave();
  assert.equal(shell.dataset.surface, 'chat');
  assert.equal(composer.value, 'Hermes 草稿');
});

test('packaged dock keeps existing Hermes write proposals on the Chat surface', async t => {
  const f = harness(t);
  f.plugin.activeThreadId = 'chat-1';
  f.plugin.pendingProposal = { threadId: 'chat-1', targetDocumentId: '20260923123456-abcdefg', items: [] };
  f.plugin.renderProposal(f.container);
  const proposal = f.container.querySelector<HTMLElement>('[data-proposal]')!;
  assert.equal(proposal.hidden, false);
  await f.room.enter();
  assert.equal(proposal.matches('.sac[data-surface="ekko"] [data-chat-only]'), true);
  f.room.leave();
  assert.equal(proposal.hidden, false);
});

test('packaged dock destruction and floating close abort room subscriptions and remove their own views', async t => {
  const f = harness(t);
  const dockSubscription = new AbortController(); f.room.eventAbort = dockSubscription;
  f.destroy();
  assert.equal(dockSubscription.signal.aborted, true);
  assert.equal(f.plugin.roomViews.has(f.container), false);
  f.plugin.toggleFloatingPanel();
  const panel = f.dom.window.document.getElementById('siyuan-ai-collab-panel')!;
  const floating = f.plugin.roomViews.get(panel);
  const floatingSubscription = new AbortController(); floating.eventAbort = floatingSubscription;
  f.plugin.toggleFloatingPanel();
  assert.equal(floatingSubscription.signal.aborted, true);
  assert.equal(f.plugin.roomViews.has(panel), false);
  assert.equal(f.dom.window.document.getElementById('siyuan-ai-collab-panel'), null);
});
