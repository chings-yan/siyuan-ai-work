import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
// @ts-ignore bridge runtime module has no generated declaration
import { allowedOrigin, corsHeaders, authorize, hermesEnvPath } from '../scripts/bridge.mjs';
import { sessionScope, isOwnedSession } from '../src/bridge.ts';

test('strict Origin allows only Siyuan 6806 origins', () => {
  assert.equal(allowedOrigin('http://127.0.0.1:6806'), 'http://127.0.0.1:6806');
  assert.equal(allowedOrigin('http://localhost:6806'), 'http://localhost:6806');
  assert.equal(allowedOrigin('http://127.0.0.1:6807'), null);
  assert.equal(allowedOrigin('http://evil.example'), null);
});
test('no wildcard and exact CORS echo with Vary', () => {
  const h = corsHeaders('http://localhost:6806');
  assert.equal(h['Access-Control-Allow-Origin'], 'http://localhost:6806');
  assert.equal(h.Vary, 'Origin');
  assert.equal(h['Access-Control-Allow-Origin'].includes('*'), false);
  assert.equal(corsHeaders('http://localhost:6807')['Access-Control-Allow-Origin'], undefined);
});
test('allowed Origin still requires the private capability token', () => {
  assert.equal(authorize({headers:{origin:'http://127.0.0.1:6806'}}, 'c'.repeat(64)).code, 'unauthorized');
  assert.deepEqual(authorize({headers:{origin:'http://127.0.0.1:6806','x-siyuan-collab-token':'c'.repeat(64)}}, 'c'.repeat(64)), {ok:true});
});
test('wrong port is rejected even with no capability', () => {
  assert.equal(authorize({headers:{origin:'http://127.0.0.1:6807'}}, 'c'.repeat(64)).code, 'origin_denied');
});
test('no Origin requires capability token', () => {
  assert.equal(authorize({headers:{}}, 'c'.repeat(64)).code, 'unauthorized');
  assert.deepEqual(authorize({headers:{'x-siyuan-collab-token':'c'.repeat(64)}}, 'c'.repeat(64)), {ok:true});
});
test('wrong token is rejected', () => {
  assert.equal(authorize({headers:{'x-siyuan-collab-token':'bad'}}, 'c'.repeat(64)).code, 'unauthorized');
});
test('wrong Origin is rejected even with the correct capability token', () => {
  assert.equal(authorize({headers:{origin:'http://127.0.0.1:6807','x-siyuan-collab-token':'c'.repeat(64)}}, 'c'.repeat(64)).code, 'origin_denied');
});
test('preflight advertises only required methods and headers', () => {
  const h = corsHeaders('http://localhost:6806');
  assert.equal(h['Access-Control-Allow-Methods'], 'GET,POST,OPTIONS');
  assert.equal(h['Access-Control-Allow-Headers'], 'Content-Type,X-Siyuan-Collab-Token,X-Siyuan-Document-Root,X-Ekko-Connection-Id,X-Ekko-Device-Id,X-Ekko-Account-User-Id');
});
test('session ownership is document-scoped and does not auto-bind other sessions', () => {
  assert.equal(sessionScope('doc-a'), 'siyuan:doc-a:');
  assert.equal(isOwnedSession('siyuan:doc-a:abc', 'doc-a'), true);
  assert.equal(isOwnedSession('siyuan:doc-b:abc', 'doc-a'), false);
  assert.equal(isOwnedSession('ordinary api_server session', 'doc-a'), false);
});
test('bridge forwards no frontend API authorization contract', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(corsHeaders('http://localhost:6806'), 'Authorization'), false);
});

test('Bridge does not read an upstream env by default and allows an explicit override', () => {
  assert.equal(hermesEnvPath({}), null);
  assert.equal(hermesEnvPath({ SIYUAN_HERMES_ENV: './private.env' }), resolve('private.env'));
});
