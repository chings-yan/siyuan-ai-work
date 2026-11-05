import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error -- plain Node ESM module has no declaration file.
import { createGatewayClient } from '../scripts/hermes-gateway-client.mjs';

type Frame = { id: number; method: string; params: Record<string, unknown> };

function scriptedSocketFactory(sent: Frame[], replies: Record<string, unknown> = {}) {
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    listeners = new Map<string, Set<(event: any) => void>>();
    url: string;
    constructor(url: string) { this.url = url; sockets.push(this); queueMicrotask(() => this.emit('open', {})); }
    addEventListener(type: string, listener: (event: any) => void) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }
    removeEventListener(type: string, listener: (event: any) => void) { this.listeners.get(type)?.delete(listener); }
    emit(type: string, event: any) { for (const listener of this.listeners.get(type) || []) listener(event); }
    event(type: string, session_id = '', payload: Record<string, unknown> = {}) {
      this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id, payload } }) });
    }
    send(raw: string) {
      const frame: Frame = JSON.parse(raw);
      sent.push(frame);
      if (Object.hasOwn(replies, frame.method)) queueMicrotask(() => this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: replies[frame.method] }) }));
    }
    close() { this.emit('close', { code: 1000 }); }
  }
  const factory = (url: string) => {
    const socket = new FakeSocket(url);
    queueMicrotask(() => socket.event('gateway.ready'));
    return socket;
  };
  return { factory, sockets };
}

const options = (socketFactory: any) => ({ baseUrl: 'http://127.0.0.1:9119', token: 'test-token', profile: 'default', socketFactory });

test('create and queued submit use the exact RPC protocol and return queued without completion', async () => {
  const sent: Frame[] = [];
  const { factory, sockets } = scriptedSocketFactory(sent, {
    'session.create': { session_id: 'live-1', stored_session_id: 'stored-1', message_count: 0, messages: [], info: {} },
    'prompt.submit': { status: 'queued', user_row_id: null },
  });
  const gateway = createGatewayClient(options(factory));
  assert.deepEqual(await gateway.create('测试'), { runtimeSessionId: 'live-1', storedSessionId: 'stored-1' });
  const accepted: unknown[] = [];
  assert.deepEqual(await gateway.submit('live-1', '问题', { onEvent: () => {}, onAccepted: (value: unknown) => accepted.push(value) }), { state: 'queued', text: '' });
  assert.deepEqual(accepted, []);
  assert.equal(sockets[0].url, 'ws://127.0.0.1:9119/api/ws?token=test-token');
  assert.deepEqual(sent.find(x => x.method === 'session.create')?.params, { profile: 'default', title: '测试', source: 'siyuan-ai-collab', close_on_disconnect: false });
  assert.deepEqual(sent.find(x => x.method === 'prompt.submit')?.params, { profile: 'default', session_id: 'live-1', text: '问题', queued: true });
  gateway.close();
});

test('history reads authenticated REST without resuming a cold stored session', async () => {
  const sent: Frame[] = [];
  const { factory } = scriptedSocketFactory(sent);
  const calls: any[] = [];
  const gateway = createGatewayClient({ ...options(factory), timeoutMs: 10, fetchImpl: async (url: URL, init: any) => {
    calls.push([url, init]);
    return new Response(JSON.stringify({ session_id: 'stored-1', profile: 'default',
      messages: [{ id: 3, role: 'user', content: ' hello ', timestamp: 123 }],
      pagination: { limit: 500, offset: 0, order: 'oldest', returned: 1 } }));
  } });
  try {
    assert.deepEqual(await gateway.history('stored-1'), { count: 1, messages: [{ role: 'user', text: 'hello', timestamp: 123, row_id: 3 }] });
    assert.equal(sent.length, 0);
    assert.equal(calls[0][0].pathname, '/api/sessions/stored-1/messages');
    assert.deepEqual(Object.fromEntries(calls[0][0].searchParams), { profile: 'default', limit: '500', offset: '0', order: 'oldest', inline_images: 'false' });
    assert.equal(calls[0][1].headers['X-Hermes-Session-Token'], 'test-token');
    assert.equal(calls[0][1].redirect, 'error');
  } finally { gateway.close(); }
});

test('streaming submit filters other sessions and takes final status and text', async () => {
  const sent: Frame[] = [];
  const { factory, sockets } = scriptedSocketFactory(sent, { 'prompt.submit': { status: 'streaming', user_row_id: 42 } });
  const gateway = createGatewayClient(options(factory));
  const events: string[] = [];
  const accepted: any[] = [];
  const pending = gateway.submit('live-1', 'hello', { onEvent: (event: any) => events.push(event.type), onAccepted: (value: any) => accepted.push(value) });
  await new Promise(resolve => setTimeout(resolve, 0));
  sockets[0].event('message.delta', 'other', { text: 'wrong' });
  sockets[0].event('message.delta', 'live-1', { text: 'part' });
  sockets[0].event('message.complete', 'live-1', { status: 'complete', text: 'final' });
  assert.deepEqual(await pending, { state: 'complete', text: 'final', userRowId: 42 });
  assert.deepEqual(events, ['message.delta', 'message.complete']);
  assert.deepEqual(accepted, [{ status: 'streaming', userRowId: 42 }]);
  gateway.close();
});

test('disconnect after submit without a terminal event is unknown and never resends', async () => {
  const sent: Frame[] = [];
  const { factory, sockets } = scriptedSocketFactory(sent, { 'prompt.submit': { status: 'streaming' } });
  const gateway = createGatewayClient(options(factory));
  const pending = gateway.submit('live-1', 'hello', { onEvent: () => {} });
  await new Promise(resolve => setTimeout(resolve, 0));
  sockets[0].close();
  assert.deepEqual(await pending, { state: 'unknown', text: '' });
  assert.equal(sent.filter(x => x.method === 'prompt.submit').length, 1);
});

test('multiple event frames assemble text and a failed terminal status wins', async () => {
  const sent: Frame[] = [];
  const { factory, sockets } = scriptedSocketFactory(sent, { 'prompt.submit': { status: 'streaming' } });
  const gateway = createGatewayClient(options(factory));
  const pending = gateway.submit('live-1', 'hello');
  await new Promise(resolve => setTimeout(resolve, 0));
  sockets[0].event('message.delta', 'live-1', { text: 'a' });
  sockets[0].event('message.delta', 'live-1', { text: 'b' });
  sockets[0].event('message.complete', 'live-1', { status: 'error' });
  sockets[0].close();
  assert.deepEqual(await pending, { state: 'failed', text: 'ab' });
});

test('completion before submit response still retains numeric user row ID', async () => {
  const sent: Frame[] = [];
  let socket: any;
  const factory = (url: string) => {
    const scripted = scriptedSocketFactory(sent);
    socket = scripted.factory(url);
    const originalSend = socket.send.bind(socket);
    socket.send = (raw: string) => {
      originalSend(raw);
      const frame: Frame = JSON.parse(raw);
      if (frame.method === 'prompt.submit') {
        socket.event('message.complete', 'live-1', { status: 'complete', text: 'ok' });
        queueMicrotask(() => socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { status: 'streaming', user_row_id: 9 } }) }));
      }
    };
    return socket;
  };
  const gateway = createGatewayClient(options(factory));
  assert.deepEqual(await gateway.submit('live-1', 'hello'), { state: 'complete', text: 'ok', userRowId: 9 });
  gateway.close();
});

test('RPC timeout and terminal timeout do not resend submitted prompts', async () => {
  for (const replies of [{}, { 'prompt.submit': { status: 'streaming' } }]) {
    const sent: Frame[] = [];
    const { factory } = scriptedSocketFactory(sent, replies);
    const gateway = createGatewayClient({ ...options(factory), timeoutMs: 10, turnTimeoutMs: 10 });
    assert.deepEqual(await gateway.submit('live-1', 'hello'), { state: 'unknown', text: '' });
    assert.equal(sent.filter(x => x.method === 'prompt.submit').length, 1);
    gateway.close();
  }
});

test('handshake rejection sends no side effect RPC and hides token', async () => {
  const sent: Frame[] = [];
  const factory = (_url: string) => {
    const listeners = new Map<string, (event: any) => void>();
    const socket = {
      addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      send: () => { throw new Error('must not send'); },
      close: () => {},
    };
    queueMicrotask(() => listeners.get('error')?.({ status: 401 }));
    return socket;
  };
  const gateway = createGatewayClient(options(factory));
  await assert.rejects(gateway.create('测试'), error => !String(error).includes('test-token'));
  assert.equal(sent.length, 0);
  gateway.close();
});

test('create timeout is reported once, without retrying the side effect', async () => {
  const sent: Frame[] = [];
  const { factory } = scriptedSocketFactory(sent);
  const gateway = createGatewayClient({ ...options(factory), timeoutMs: 10, turnTimeoutMs: 10 });
  await assert.rejects(gateway.create('测试'), /结果未知/);
  assert.equal(sent.filter(x => x.method === 'session.create').length, 1);
  gateway.close();
});

test('list and interrupt use profile and runtime ID; token is URL encoded', async () => {
  const sent: Frame[] = [];
  const { factory, sockets } = scriptedSocketFactory(sent, {
    'session.list': { sessions: [] },
    'session.interrupt': { status: 'interrupted', interrupted: true },
  });
  const gateway = createGatewayClient({ ...options(factory), token: 'a b&c' });
  assert.deepEqual(await gateway.list(), { sessions: [] });
  assert.deepEqual(await gateway.interrupt('live-1'), { status: 'interrupted', interrupted: true });
  assert.equal(sockets[0].url, 'ws://127.0.0.1:9119/api/ws?token=a%20b%26c');
  assert.deepEqual(sent.map(x => [x.method, x.params]), [
    ['session.list', { profile: 'default' }],
    ['session.interrupt', { profile: 'default', session_id: 'live-1' }],
  ]);
  gateway.close();
});

test('confirmed terminal before RPC ack survives later disconnect', async () => {
  const sent: Frame[] = [];
  const scripted = scriptedSocketFactory(sent);
  const factory = (url: string) => {
    const socket = scripted.factory(url);
    const send = socket.send.bind(socket);
    socket.send = (raw: string) => {
      send(raw);
      if (JSON.parse(raw).method === 'prompt.submit') {
        socket.event('message.complete', 'live-1', { status: 'complete', text: 'confirmed' });
        socket.close();
      }
    };
    return socket;
  };
  const gateway = createGatewayClient(options(factory));
  assert.deepEqual(await gateway.submit('live-1', 'hello'), { state: 'complete', text: 'confirmed' });
  assert.equal(sent.filter(x => x.method === 'prompt.submit').length, 1);
  gateway.close();
});

test('explicit invalid params RPC rejection is failed, not unknown', async () => {
  const sent: Frame[] = [];
  const scripted = scriptedSocketFactory(sent);
  const factory = (url: string) => {
    const socket = scripted.factory(url);
    const send = socket.send.bind(socket);
    socket.send = (raw: string) => {
      send(raw);
      const frame: Frame = JSON.parse(raw);
      if (frame.method === 'prompt.submit') queueMicrotask(() => socket.emit('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32602, message: 'invalid params' } }),
      }));
    };
    return socket;
  };
  const gateway = createGatewayClient(options(factory));
  assert.deepEqual(await gateway.submit('live-1', 'hello'), { state: 'failed', text: '' });
  gateway.close();
});

test('submit handshake rejection returns ChatRunResult and sends nothing', async () => {
  const sent: Frame[] = [];
  const factory = (_url: string) => {
    const listeners = new Map<string, (event: any) => void>();
    queueMicrotask(() => listeners.get('error')?.({ status: 401 }));
    return {
      addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      send: (raw: string) => sent.push(JSON.parse(raw)),
      close: () => {},
    };
  };
  const gateway = createGatewayClient(options(factory));
  assert.deepEqual(await gateway.submit('live-1', 'hello'), { state: 'unknown', text: '' });
  assert.equal(sent.length, 0);
  gateway.close();
});

test('abort while waiting for gateway.ready prevents prompt submission', async () => {
  const sent: Frame[] = [];
  let ready: () => void = () => {};
  const factory = (_url: string) => {
    const listeners = new Map<string, (event: any) => void>();
    ready = () => listeners.get('message')?.({ data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', session_id: '', payload: {} } }) });
    return {
      addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
      send: (raw: string) => sent.push(JSON.parse(raw)),
      close: () => {},
    };
  };
  const gateway = createGatewayClient({ ...options(factory), timeoutMs: 20 });
  const controller = new AbortController();
  const pending = gateway.submit('live-1', 'hello', { signal: controller.signal });
  controller.abort();
  ready();
  assert.deepEqual(await pending, { state: 'unknown', text: '' });
  assert.equal(sent.length, 0);
  gateway.close();
});

test('cancellation after ready but before socket.send still sends zero prompt frames', async () => {
  const sent: Frame[] = [];
  const { factory } = scriptedSocketFactory(sent);
  let checks = 0;
  const signal = {
    get aborted() { return ++checks >= 3; },
    addEventListener() {},
    removeEventListener() {},
  } as unknown as AbortSignal;
  const gateway = createGatewayClient(options(factory));
  assert.deepEqual(await gateway.submit('live-1', 'hello', { signal }), { state: 'unknown', text: '' });
  assert.ok(checks >= 3);
  assert.equal(sent.filter(x => x.method === 'prompt.submit').length, 0);
  gateway.close();
});


test('queued acknowledgement discards preceding Desktop events even with a numeric row ID', async () => {
  const sent: Frame[] = [];
  const scripted = scriptedSocketFactory(sent);
  const factory = (url: string) => {
    const socket = scripted.factory(url);
    const send = socket.send.bind(socket);
    socket.send = (raw: string) => {
      send(raw);
      const frame = JSON.parse(raw);
      if (frame.method === 'prompt.submit') {
        socket.event('message.delta', 'live-1', { text: 'old Desktop reply' });
        socket.event('message.complete', 'live-1', { status: 'complete', text: 'old final' });
        queueMicrotask(() => socket.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { status: 'queued', user_row_id: 77 } }) }));
      }
    };
    return socket;
  };
  const events: unknown[] = [];
  const gateway = createGatewayClient(options(factory));
  try {
    assert.deepEqual(await gateway.submit('live-1', 'new question', { onEvent: (event: unknown) => events.push(event) }), { state: 'queued', text: '', userRowId: 77 });
    assert.deepEqual(events, []);
    assert.equal(sent.filter(frame => frame.method === 'prompt.submit').length, 1);
  } finally { gateway.close(); }
});

test('acknowledged turn outlives RPC deadline and completes before its separate deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Frame[] = [];
  const { factory, sockets } = scriptedSocketFactory(sent, { 'prompt.submit': { status: 'streaming', user_row_id: 42 } });
  const gateway = createGatewayClient({ ...options(factory), timeoutMs: 10, turnTimeoutMs: 100 });
  let settled = false;
  const result = gateway.submit('live-1', 'hello').then((value: unknown) => { settled = true; return value; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(11);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  try {
    assert.equal(settled, false);
    sockets[0].event('message.complete', 'live-1', { status: 'complete', text: 'late response' });
    assert.deepEqual(await result, { state: 'complete', text: 'late response', userRowId: 42 });
    assert.equal(sent.filter(frame => frame.method === 'prompt.submit').length, 1);
  } finally { gateway.close(); }
});

test('separate turn deadline resolves unknown once and close removes listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Frame[] = [];
  const { factory, sockets } = scriptedSocketFactory(sent, { 'prompt.submit': { status: 'streaming' } });
  const gateway = createGatewayClient({ ...options(factory), timeoutMs: 10, turnTimeoutMs: 100 });
  let settled = 0;
  const result = gateway.submit('live-1', 'hello').then((value: unknown) => { settled++; return value; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(99);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  try {
    assert.equal(settled, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(await result, { state: 'unknown', text: '' });
    t.mock.timers.tick(1000);
    gateway.close();
    assert.equal(settled, 1);
    assert.equal(sent.filter(frame => frame.method === 'prompt.submit').length, 1);
    assert.equal([...sockets[0].listeners.values()].flatMap(listeners => [...listeners]).length, 0);
  } finally { gateway.close(); }
});

test('turn timeout rejects invalid values at construction', () => {
  for (const turnTimeoutMs of [0, -1, Infinity, NaN]) assert.throws(() => createGatewayClient({ ...options(() => {}), turnTimeoutMs }), /超时/);
});

test('abort before acknowledgement settles unknown immediately and clears its RPC listener', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sent: Frame[] = [];
  const { factory } = scriptedSocketFactory(sent);
  const controller = new AbortController();
  const abortListeners = new Set<any>();
  const signal = { get aborted() { return controller.signal.aborted; },
    addEventListener(_type: string, listener: any) { abortListeners.add(listener); controller.signal.addEventListener('abort', listener); },
    removeEventListener(_type: string, listener: any) { abortListeners.delete(listener); controller.signal.removeEventListener('abort', listener); },
  };
  const gateway = createGatewayClient({ ...options(factory), timeoutMs: 10, turnTimeoutMs: 100 });
  let settled = false;
  const result = gateway.submit('live-1', 'hello', { signal }).then((value: unknown) => { settled = true; return value; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  controller.abort();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  try {
    assert.equal(settled, true);
    assert.deepEqual(await result, { state: 'unknown', text: '' });
    assert.equal(abortListeners.size, 0);
    t.mock.timers.tick(200);
    assert.equal(sent.filter(frame => frame.method === 'prompt.submit').length, 1);
  } finally { gateway.close(); }
});

test('default acknowledged turn waits thirty minutes rather than ten seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { factory } = scriptedSocketFactory([], { 'prompt.submit': { status: 'streaming' } });
  const gateway = createGatewayClient(options(factory));
  let settled = false;
  const result = gateway.submit('live-1', 'hello').then((value: unknown) => { settled = true; return value; });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  t.mock.timers.tick(30 * 60 * 1000 - 1);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  try {
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await result, { state: 'unknown', text: '' });
  } finally { gateway.close(); }
});
