import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, DEFAULT_BRIDGE_URL, HermesBridgeClient, isValidByteStringHeaderValue, isValidDocumentRootId, resolveBridgeUrl } from '../src/bridge.ts';

const VALID_ROOT = '20260826094850-kronins';

test('default Bridge URL is the local Bridge service', () => {
  assert.equal(DEFAULT_BRIDGE_URL, 'http://127.0.0.1:8782');
});

test('missing settings keep the default Bridge URL', () => {
  assert.equal(resolveBridgeUrl(undefined), DEFAULT_BRIDGE_URL);
  assert.equal(resolveBridgeUrl({}), DEFAULT_BRIDGE_URL);
});

test('explicit non-empty bridgeUrl is preserved', () => {
  assert.equal(resolveBridgeUrl({ bridgeUrl: 'http://localhost:9999/' }), 'http://localhost:9999/');
});

test('blank bridgeUrl falls back to the default', () => {
  assert.equal(resolveBridgeUrl({ bridgeUrl: '   ' }), DEFAULT_BRIDGE_URL);
});

test('legacy baseUrl migrates to the default Bridge instead of direct Hermes', () => {
  assert.equal(resolveBridgeUrl({ baseUrl: 'http://127.0.0.1:8000' }), DEFAULT_BRIDGE_URL);
  assert.equal(resolveBridgeUrl({ baseUrl: 'http://127.0.0.1:8642' }), DEFAULT_BRIDGE_URL);
});

test('client attaches capability token to non-health requests', async () => {
  const oldFetch = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(init || {}); return new Response(JSON.stringify({data:[]})); };
  try {
    const { HermesBridgeClient } = await import('../src/bridge.ts');
    const client = new HermesBridgeClient({bridgeUrl: DEFAULT_BRIDGE_URL, capabilityToken:'private-capability', documentRootId:VALID_ROOT});
    await client.listSessions();
    await client.health();
    assert.equal((requests[0].headers as Record<string,string>)['X-Siyuan-Collab-Token'], 'private-capability');
    assert.equal((requests[1].headers as Record<string,string>)['X-Siyuan-Collab-Token'], undefined);
  } finally { globalThis.fetch = oldFetch; }
});

test('Chinese document placeholder is rejected before listSessions fetches', async () => {
  const oldFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return new Response(JSON.stringify({data:[]})); };
  try {
    const client = new HermesBridgeClient({bridgeUrl:DEFAULT_BRIDGE_URL, capabilityToken:'private-capability', documentRootId:'未识别文档'});
    await assert.rejects(() => client.listSessions(), (error:unknown) => error instanceof BridgeError && error.status === 400 && error.code === 'invalid_document_root' && /思源文档/.test(error.message));
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test('CRLF and non-ByteString capability or document root values fail closed', async () => {
  const oldFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return new Response(JSON.stringify({data:[]})); };
  try {
    const invalidConfigs = [
      {capabilityToken:'safe\r\nInjected: yes', documentRootId:VALID_ROOT},
      {capabilityToken:'中文密钥', documentRootId:VALID_ROOT},
      {capabilityToken:'private-capability', documentRootId:`${VALID_ROOT}\r\nInjected: yes`},
      {capabilityToken:'private-capability', documentRootId:'20260826094850-中文值'},
    ];
    for (const config of invalidConfigs) {
      const client = new HermesBridgeClient({bridgeUrl:DEFAULT_BRIDGE_URL, ...config});
      await assert.rejects(() => client.listSessions(), (error:unknown) => error instanceof BridgeError);
    }
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = oldFetch; }
});

test('health fetches without a document root header', async () => {
  const oldFetch = globalThis.fetch;
  const requests:RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(init || {}); return new Response(JSON.stringify({ok:true,service:'bridge'})); };
  try {
    const client = new HermesBridgeClient({bridgeUrl:DEFAULT_BRIDGE_URL, capabilityToken:'private-capability'});
    await client.health();
    assert.equal(requests.length, 1);
    assert.equal((requests[0].headers as Record<string,string>)['X-Siyuan-Document-Root'], undefined);
  } finally { globalThis.fetch = oldFetch; }
});

test('valid SiYuan root is attached to document-scoped requests', async () => {
  const oldFetch = globalThis.fetch;
  const requests:RequestInit[] = [];
  globalThis.fetch = async (_url, init) => { requests.push(init || {}); return new Response(JSON.stringify({data:[]})); };
  try {
    const client = new HermesBridgeClient({bridgeUrl:DEFAULT_BRIDGE_URL, capabilityToken:'private-capability', documentRootId:VALID_ROOT});
    await client.listSessions();
    assert.equal((requests[0].headers as Record<string,string>)['X-Siyuan-Document-Root'], VALID_ROOT);
  } finally { globalThis.fetch = oldFetch; }
});

test('document root and ByteString header validators are exported', () => {
  assert.equal(isValidDocumentRootId(VALID_ROOT), true);
  assert.equal(isValidDocumentRootId('未识别文档'), false);
  assert.equal(isValidByteStringHeaderValue('private-capability'), true);
  assert.equal(isValidByteStringHeaderValue('bad\r\nvalue'), false);
  assert.equal(isValidByteStringHeaderValue('中文密钥'), false);
});

test('client source contains no fixture token or pairing status secret', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/bridge.ts', import.meta.url), 'utf8');
  assert.equal(source.includes('private-capability'), false);
  assert.equal(source.includes('Bridge 未配对'), false);
});

test('session creation normalizes the default Hermes API data response', async () => {
  const { HermesBridgeClient } = await import('../src/bridge.ts');
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({data:{id:'api-test',title:'siyuan:doc-1:test',source:'api_server'}}));
  try {
    const client=new HermesBridgeClient({bridgeUrl:DEFAULT_BRIDGE_URL,capabilityToken:'x',documentRootId:'20260826094850-kronins'});
    const result=await client.createSession('siyuan:doc-1:test');
    assert.equal(result.session.id,'api-test');
    assert.equal(result.session.title,'siyuan:doc-1:test');
  } finally { globalThis.fetch=oldFetch; }
});
