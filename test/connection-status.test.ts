import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionStatus, mergeSettings, type BridgeSettings } from '../src/status.ts';
import { BridgeError } from '../src/bridge.ts';

test('successful sync with token reports connected without exposing token', () => {
  assert.equal(connectionStatus({ hasToken: true, syncOk: true }), 'Hermes · 已连接');
  assert.equal(connectionStatus({ hasToken: true, syncOk: false, error: new Error('secret-token') }), 'Hermes · 未连接：连接失败');
  assert.equal(connectionStatus({ hasToken: true, syncOk: false, error: new Error('HTTP 503') }), 'Hermes · 未连接：HTTP 503');
});

test('missing token reports unpaired', () => {
  assert.equal(connectionStatus({ hasToken: false, syncOk: false }), 'AI 尚未配置，可稍后连接');
});

test('identity, auth and unknown source errors have distinct actionable status', () => {
  const describe = (code: string) => connectionStatus({ hasToken: true, syncOk: false, error: new BridgeError('unsafe upstream text', 409, code) });
  assert.match(describe('install_mismatch'), /安装|核对/);
  assert.match(describe('auth_failed'), /认证|凭证/);
  assert.match(describe('source_unknown'), /来源|确认/);
  assert.notEqual(describe('install_mismatch'), describe('auth_failed'));
  assert.notEqual(describe('auth_failed'), describe('source_unknown'));
  assert.equal(describe('install_mismatch').includes('unsafe upstream text'), false);
});

test('saving bridge URL preserves bridge token and never includes it in UI status', () => {
  const current: BridgeSettings = { bridgeUrl: 'http://old', bridgeToken: 'do-not-display' };
  const merged = mergeSettings(current, { bridgeUrl: 'http://new' });
  assert.deepEqual(merged, { bridgeUrl: 'http://new', bridgeToken: 'do-not-display' });
  assert.equal(JSON.stringify(connectionStatus({ hasToken: true, syncOk: true })).includes('do-not-display'), false);
});
