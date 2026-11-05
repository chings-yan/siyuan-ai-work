import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, HermesBridgeClient } from '../src/bridge.ts';

const client = () => new HermesBridgeClient({ bridgeUrl: 'http://127.0.0.1:8782', documentRootId: '20260826094850-kronins' });

function response(body: string, controller?: ReadableStreamDefaultController<Uint8Array>) {
  return new Response(new ReadableStream<Uint8Array>({ start(c) { if (controller) Object.assign(controller, c); else { c.enqueue(new TextEncoder().encode(body)); c.close(); } } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('streamChat preserves SSE event names, emits message deltas, and completes once', async () => {
  const oldFetch = globalThis.fetch;
  const chunks = [
    'event: message.delta\ndata: {"delta":"你"}\n\n',
    'event: message.delta\ndata: {"delta":"好"}\n\n',
    'event: run.completed\ndata: {"usage":{"total_tokens":2}}\n\n',
  ];
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk)); c.close(); } }), { status: 200 });
  try {
    const events: any[] = [];
    const result = await client().streamChat('s', 'q', undefined, (event) => events.push(event));
    assert.equal(result, '你好');
    assert.deepEqual(events.filter(x => x.delta).map(x => x.delta), ['你', '好']);
    assert.equal(events.at(-1)?.done, true);
  } finally { globalThis.fetch = oldFetch; }
});

test('streamChat turns approval and clarify events into interaction-required BridgeError and cancels reader', async () => {
  const oldFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('event: approval.requested\ndata: {"message":"approve"}\n\n')); }, cancel() { cancelled = true; } }), { status: 200 });
  try {
    await assert.rejects(() => client().streamChat('s', 'q'), (error: any) => error instanceof BridgeError && error.code === 'studio_interaction_required' && error.message === '需在 Hermes Studio 处理');
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = oldFetch; }
});

test('streamChat reports run.failed and forwards abort to fetch', async () => {
  const oldFetch = globalThis.fetch;
  let seenSignal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => { seenSignal = init?.signal as AbortSignal; return new Response('event: run.failed\ndata: {"error":"坏了"}\n\n', { status: 200 }); };
  try {
    await assert.rejects(() => client().streamChat('s', 'q', undefined, undefined, new AbortController().signal), /坏了/);
    const controller = new AbortController();
    globalThis.fetch = async (_url, init) => { seenSignal = init?.signal as AbortSignal; return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true })); };
    const promise = client().streamChat('s', 'q', undefined, undefined, controller.signal); controller.abort(); await assert.rejects(promise, /aborted/i); assert.ok(seenSignal);
  } finally { globalThis.fetch = oldFetch; }
});
