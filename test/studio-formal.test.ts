import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error runtime ESM helper has no declaration
import { findBinding, mergeVisibleSessions } from '../scripts/bridge.mjs';
import { parseSseEvents } from '../src/bridge.ts';
import { filterStudioSessions, createStudioPickerState } from '../src/studio-picker.ts';

test('bindings are keyed and resolved by document root plus session id', () => {
  const bindings = {
    'doc-a:s1': { id: 's1', documentRootId: 'doc-a', profile: 'default', title: 'A' },
    'doc-b:s1': { id: 's1', documentRootId: 'doc-b', profile: 'default', title: 'B' },
  };
  assert.equal(findBinding(bindings, 'doc-a', 's1')?.title, 'A');
  assert.equal(findBinding(bindings, 'doc-b', 's1')?.title, 'B');
  assert.equal(findBinding(bindings, 'doc-c', 's1'), null);
});

test('visible sessions merge only current-root bindings and legacy owned sessions', () => {
  const result = mergeVisibleSessions(
    [{ id: 'legacy', title: 'siyuan:doc:legacy', source: 'api_server' }, { id: 'hidden', title: 'siyuan:other:x' }],
    [{ id: 'studio', title: 'Studio', source: 'studio', profile: 'default' }],
    { 'doc:studio': { id: 'studio', documentRootId: 'doc', profile: 'default', title: 'Studio' }, 'other:x': { id: 'x', documentRootId: 'other', profile: 'default', title: 'Hidden' } },
    'doc',
  ).map((s: any) => s.id);
  assert.deepEqual(result.sort(), ['legacy', 'studio']);
});

test('SSE parser honors event plus data and reports action events once', () => {
  const events = parseSseEvents('event: message.delta\ndata: {"delta":"hi"}\n\nevent: run.completed\ndata: {"content":"hi"}\n\n');
  assert.deepEqual(events, [['message.delta', { delta: 'hi' }], ['run.completed', { content: 'hi' }]]);
});

test('studio picker filters metadata and confirmation is the only load trigger', () => {
  const calls: string[] = [];
  const picker = createStudioPickerState({
    list: async () => { calls.push('list'); return [{ id: 's1', title: 'Alpha', preview: 'needle' }, { id: 's2', title: 'Beta', preview: 'other' }]; },
    bind: async (id) => { calls.push(`bind:${id}`); },
    load: async (id) => { calls.push(`load:${id}`); },
  });
  assert.deepEqual(calls, []);
  return picker.open().then(async () => {
    assert.deepEqual(calls, ['list']);
    assert.deepEqual(filterStudioSessions(picker.sessions, 'needle').map(s => s.id), ['s1']);
    picker.select('s1');
    picker.cancel();
    assert.deepEqual(calls, ['list']);
    await picker.open(); picker.select('s1'); await picker.confirm();
    assert.deepEqual(calls, ['list', 'list', 'bind:s1', 'load:s1']);
  });
});
