import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, streamChatSession, streamThreadChat } from '../src/provider.ts';
import { ReferenceBasket } from '../src/references.ts';
import type { Snapshot } from '../src/core.ts';
const snapshot = {documentId:'d',title:'t',focusBlockId:'b1',selection:'',nearby:[{blockId:'b1',text:'x',sourceMarkdown:'x',expectedOriginal:'x'}],recent:[],contextText:'b1: x',createdAt:'now',degraded:true} as Snapshot;
test('provider requires explicit apiKey and sends bearer authorization', async () => { const oldFetch=globalThis.fetch; let request:RequestInit|undefined; globalThis.fetch=async (_url,init) => {request=init; return new Response(JSON.stringify({choices:[{message:{content:'{"text":"ok","plan":[]}'}}]}),{status:200});}; try { await assert.rejects(() => analyze(snapshot,'q','suggest',{baseUrl:'http://localhost:1234'}),/api key/i); await analyze(snapshot,'q','suggest',{baseUrl:'http://localhost:1234',apiKey:'secret'}); assert.equal((request?.headers as Record<string,string>).Authorization,'Bearer secret'); } finally {globalThis.fetch=oldFetch;} });
test('provider parses safe suggest plan and rejects invalid plan with warning', async () => { const oldFetch=globalThis.fetch; globalThis.fetch=async () => new Response(JSON.stringify({choices:[{message:{content:'```json\n{"text":"改","plan":[{"blockId":"b1","expectedOriginal":"x","replacement":"y"}]}\n```'}}]}),{status:200}); try {const result=await analyze(snapshot,'q','suggest',{baseUrl:'http://x',apiKey:'k'}); assert.equal(result.plan[0].replacement,'y');} finally {globalThis.fetch=oldFetch;} globalThis.fetch=async () => new Response(JSON.stringify({choices:[{message:{content:'{"text":"改","plan":[{"blockId":"evil","expectedOriginal":"x","replacement":"y"}]}'}}]}),{status:200}); try {const result=await analyze(snapshot,'q','suggest',{baseUrl:'http://x',apiKey:'k'}); assert.deepEqual(result.plan,[]); assert.match(result.warning||'',/plan/i);} finally {globalThis.fetch=oldFetch;} });
test('analyze mode always discards returned plan', async () => { const oldFetch=globalThis.fetch; globalThis.fetch=async () => new Response(JSON.stringify({choices:[{message:{content:'{"text":"分析","plan":[{"blockId":"b1","expectedOriginal":"x","replacement":"y"}]}'}}]}),{status:200}); try {const result=await analyze(snapshot,'q','analyze',{baseUrl:'http://x',apiKey:'secret'}); assert.deepEqual(result.plan,[]);} finally {globalThis.fetch=oldFetch;} });
test('provider sends explicit references separately from auxiliary context', async () => { const oldFetch=globalThis.fetch; let body:any; globalThis.fetch=async (_url,init) => { body=JSON.parse(String(init?.body)); return new Response(JSON.stringify({choices:[{message:{content:'{"text":"ok","plan":[]}'}}]}),{status:200}); }; try { const basket=new ReferenceBasket(); basket.add({id:'q1',blockId:'b1',documentRootId:'d',documentTitle:'t',selectedText:'重点',capturedBlockKramdown:'重点',expectedOriginal:'重点',createdAt:'now',startOffset:null,endOffset:null}); await analyze({...snapshot,nearby:[...snapshot.nearby,{blockId:'b2',text:'背景',sourceMarkdown:'背景',expectedOriginal:'背景'}]},'请解释 [引用1]','analyze',{baseUrl:'http://x',apiKey:'secret',references:basket.list()}); const content=body.messages[1].content; assert.match(content,/用户明确引用/); assert.match(content,/辅助背景/); assert.match(content,/blockId=b1/); } finally {globalThis.fetch=oldFetch;} });

test('stream provider sends frozen context separately and preserves nonterminal result', async () => {
  const oldFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(String(init?.body)); return new Response('event: message.delta\ndata: {"delta":"部分"}\n\nevent: run.unknown\ndata: {}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); };
  try {
    const scoped = { ...snapshot, documentId: '20260923123456-abcdefg', contextText: '冻结资料' };
    const result = await streamChatSession('local-1', '原始问题', scoped, { bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: 'c'.repeat(64), documentRootId: scoped.documentId }, () => {});
    assert.deepEqual(result, { state: 'unknown', text: '部分' });
    assert.equal(body.message, '原始问题');
    assert.match(body.system_message, /冻结资料/);
  } finally { globalThis.fetch = oldFetch; }
});

test('explicit old Studio or legacy API binding keeps its old route and broken stream is unknown', async () => {
  const oldFetch = globalThis.fetch;
  const paths: string[] = [];
  let terminal = true;
  globalThis.fetch = async (url) => { paths.push(new URL(String(url)).pathname); return new Response(terminal ? 'event: message.delta\ndata: {"delta":"旧回复"}\n\nevent: run.completed\ndata: {}\n\n' : 'event: message.delta\ndata: {"delta":"半句"}\n\n', { status: 200 }); };
  try {
    const scoped = { ...snapshot, documentId: '20260923123456-abcdefg' };
    const config = { bridgeUrl: 'http://127.0.0.1:8785', capabilityToken: 'c'.repeat(64), documentRootId: scoped.documentId };
    const studio = { id: 'local-studio', adapter: 'studio' as const, state: 'ready' as const, storedSessionId: 'stored-studio', legacyBridgeUrl: 'http://127.0.0.1:8784' };
    assert.deepEqual(await streamThreadChat(studio, '问题', scoped, config, () => {}), { state: 'complete', text: '旧回复' });
    terminal = false;
    const legacyApi = { ...studio, adapter: 'legacy-api' as const, storedSessionId: 'stored-api' };
    assert.deepEqual(await streamThreadChat(legacyApi, '问题', scoped, config, () => {}), { state: 'unknown', text: '半句' });
    assert.deepEqual(paths, ['/sessions/stored-studio/chat/stream', '/sessions/stored-api/chat/stream']);
  } finally { globalThis.fetch = oldFetch; }
});

test('legacy route failure does not fall back to a new Chat route', async () => {
  const oldFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async url => { paths.push(new URL(String(url)).pathname); return new Response(JSON.stringify({ error: { code: 'chat_busy', message: 'busy' } }), { status: 409 }); };
  try {
    const scoped = { ...snapshot, documentId: '20260923123456-abcdefg' };
    const thread = { id: 'local-studio', adapter: 'studio' as const, state: 'ready' as const, storedSessionId: 'stored-studio', legacyBridgeUrl: 'http://127.0.0.1:8784' };
    await assert.rejects(streamThreadChat(thread, '问题', scoped, { bridgeUrl: 'http://127.0.0.1:8785', capabilityToken: 'c'.repeat(64), documentRootId: scoped.documentId }, () => {}));
    assert.deepEqual(paths, ['/sessions/stored-studio/chat/stream']);
  } finally { globalThis.fetch = oldFetch; }
});

test('Studio uses the new route only with an explicit neutral binding', async () => {
  const oldFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = async url => { paths.push(new URL(String(url)).pathname); return new Response('event: run.completed\ndata: {"text":"新绑定回复"}\n\n', { status: 200 }); };
  try {
    const scoped = { ...snapshot, documentId: '20260923123456-abcdefg' };
    const config = { bridgeUrl: 'http://127.0.0.1:8785', capabilityToken: 'c'.repeat(64), documentRootId: scoped.documentId };
    const thread = { id: 'local-studio', adapter: 'studio' as const, state: 'ready' as const, storedSessionId: 'stored-studio', connectionId: 'studio-default' };
    assert.deepEqual(await streamThreadChat(thread, '问题', scoped, config, () => {}), { state: 'complete', text: '新绑定回复' });
    await assert.rejects(streamThreadChat({ ...thread, connectionId: undefined }, '问题', scoped, config, () => {}), /绑定|来源/);
    assert.deepEqual(paths, ['/chats/local-studio/chat/stream']);
  } finally { globalThis.fetch = oldFetch; }
});
