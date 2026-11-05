import test from 'node:test';
import assert from 'node:assert/strict';
// The bridge is intentionally a plain Node ESM script; runtime tests import it directly.
// Keep the test typecheck explicit until the Node .mjs declaration resolver is available.
// @ts-expect-error -- declaration resolution for relative .mjs is not supported by this TS setup.
import { validateOwnedSession, filterOwnedSessions } from '../scripts/bridge.mjs';

test('bridge ownership validator accepts only siyuan document-root titles', () => {
  assert.equal(validateOwnedSession({id:'x', title:'siyuan:doc-1:session'}, 'doc-1'), true);
  assert.equal(validateOwnedSession({id:'x', title:'siyuan:doc-2:session'}, 'doc-1'), false);
  assert.equal(validateOwnedSession({id:'x', title:'ordinary api_server session'}, 'doc-1'), false);
  assert.equal(validateOwnedSession({id:'x', title:'siyuan:doc-1:session'}, undefined), false);
});

test('bridge list filtering never exposes non-owned default sessions', () => {
  const sessions=[{id:'1',title:'siyuan:doc-1:a'},{id:'2',title:'ordinary'},{id:'3',title:'siyuan:doc-2:b'}];
  assert.deepEqual(filterOwnedSessions(sessions,'doc-1').map((s: { id: string })=>s.id), ['1']);
});
