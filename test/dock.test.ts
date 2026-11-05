import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';

test('bundle registers a visible RightTop dock before async settings load', async () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  Object.assign(globalThis, { document: dom.window.document, window: dom.window, MutationObserver: dom.window.MutationObserver });
  const calls: any[] = [];
  class PluginStub {
    addTab() {}
    eventBus = { on: (name: string) => calls.push({ kind: 'listen', name }), off: () => undefined };
    loadData() { return new Promise(resolve => setTimeout(() => resolve({}), 0)); }
    addIcons(svg: string) { calls.push({ kind: 'icon', svg }); }
    addDock(options: any) {
      calls.push({ kind: 'dock', options });
      const element = document.createElement('div');
      options.init.call({ element });
      assert.match(element.textContent || '', /Work/);
      assert.ok(element.querySelector('[data-action="add-reference"]'), 'dock must offer add-current-selection');
      assert.ok(element.querySelector('[data-references]'), 'dock must render reference basket');
      assert.ok(element.querySelector('[data-action="chat-menu-new"]'), 'dock must offer new conversation');
      assert.ok(element.querySelector('[data-action="toggle-settings"]'), 'connection choice is available through settings');
      assert.ok(element.querySelector('[data-thread-selector]'), 'dock must offer conversation selector');
      assert.ok(element.querySelector('[data-messages]'), 'dock must render message history');
      assert.ok(element.querySelector('[data-action="send-stop"]'), 'dock must offer a unified send/stop action');
      assert.equal(element.querySelector('[data-action="send"]'), null, 'send and stop must not be separate controls');
      assert.equal(element.querySelector('[data-action="stop"]'), null, 'send and stop must not be separate controls');
      assert.equal(element.querySelector('[data-mode="analyze"]'), null, 'legacy analyze control must not be primary UI');
      return { config: options.config };
    }
  }
  const originalLoad = (Module as any)._load;
  (Module as any)._load = function(request: string, parent: any, isMain: boolean) {
    if (request === 'siyuan') return { Plugin: PluginStub, getAllEditor: () => [] };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const require = createRequire(import.meta.url);
    const mod = require('../dist/index.js');
    const instance: any = new mod.default({ app: {}, name: 'siyuan-ai-collab', displayName: '思源 AI 即时协作', i18n: {} });
    instance.onload();
    const injectedStyles = [...document.querySelectorAll('style')].map(style => style.textContent || '').join('\n');
    assert.match(injectedStyles, /\.sac-work\{/,
      'Work styles must be present during onload even when onLayoutReady is not called');
    assert.ok(calls.some(x => x.kind === 'listen' && x.name === 'switch-protyle'),
      'document switching must be observed even when onLayoutReady is not called');
    assert.ok(calls.some(x => x.kind === 'icon'), `bundle did not call addIcons: ${JSON.stringify(calls)}`);
    const dock = calls.find(x => x.kind === 'dock');
    assert.ok(dock, 'addDock must be called synchronously');
    assert.deepEqual(dock.options.config, {
      position: 'RightTop',
      size: { width: 360, height: 360 },
      title: '思源 AI 即时协作',
      icon: 'iconSiyuanAICollab',
    });
    assert.equal(typeof dock.options.init, 'function');
    instance.onLayoutReady = () => undefined;
  } finally {
    (Module as any)._load = originalLoad;
  }
});

import Module from 'node:module';
