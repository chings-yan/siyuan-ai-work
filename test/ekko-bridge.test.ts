import test from 'node:test';
import assert from 'node:assert/strict';
import { EkkoBridgeClient } from '../src/ekko/bridge.ts';

const ROOT = '20260928123456-abc1234';
const config = { bridgeUrl: 'http://127.0.0.1:8782', capabilityToken: 'test-capability', documentRootId: ROOT };
const expectedIdentity = { connectionId: 'connection-one', deviceId: 'device-one', accountUserId: 7 };

test('房间请求只到本机 Bridge，带能力令牌，发送带文档根和原客户端消息 ID', async () => {
  const old = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ state: 'sent', messageId: 'client-one' }), { headers: { 'Content-Type': 'application/json' } }); };
  try {
    const client = new EkkoBridgeClient(config);
    await client.send('room-one', { clientMessageId: 'client-one', content: '虚构消息', mentions: [] }, expectedIdentity);
    assert.equal(calls[0].url, 'http://127.0.0.1:8782/ekko/rooms/room-one/messages');
    assert.equal(calls[0].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { clientMessageId: 'client-one', content: '虚构消息', mentions: [] });
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers['X-Siyuan-Collab-Token'], 'test-capability');
    assert.equal(headers['X-Siyuan-Document-Root'], ROOT);
    assert.equal(headers['X-Ekko-Connection-Id'], 'connection-one');
    assert.equal(headers['X-Ekko-Device-Id'], 'device-one');
    assert.equal(headers['X-Ekko-Account-User-Id'], '7');
  } finally { globalThis.fetch = old; }
});

test('连接、配对、房间列表、房间和发送状态使用独立路由，密码仅在一次配对请求中', async () => {
  const old = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ connection: null, rooms: [], room: {}, messages: [], agents: [], state: 'unknown' })); };
  try {
    const client = new EkkoBridgeClient(config);
    await client.connection();
    await client.pair({ baseUrl: 'http://127.0.0.1:8748', username: 'demo-user', password: 'temporary-password' });
    await client.rooms({ offset: 0, limit: 20 }, expectedIdentity);
    await client.room('room-one', { limit: 25 }, expectedIdentity);
    await client.sendStatus('room-one', 'client-one', expectedIdentity);
    const statusHeaders = calls[4].init?.headers as Record<string, string>;
    assert.equal(statusHeaders['X-Ekko-Connection-Id'], 'connection-one');
    assert.equal(statusHeaders['X-Ekko-Device-Id'], 'device-one');
    assert.equal(statusHeaders['X-Ekko-Account-User-Id'], '7');
    assert.deepEqual(calls.map(x => new URL(x.url).pathname), ['/ekko/connection', '/ekko/pair', '/ekko/rooms', '/ekko/rooms/room-one', '/ekko/rooms/room-one/send-status/client-one']);
    assert.equal(calls[1].init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { baseUrl: 'http://127.0.0.1:8748', username: 'demo-user', password: 'temporary-password' });
    assert.equal(calls.filter(x => String(x.init?.body).includes('temporary-password')).length, 1);
    assert.equal(JSON.stringify(client).includes('temporary-password'), false);
  } finally { globalThis.fetch = old; }
});

test('拒绝远程 Bridge 地址和缺失文档根，不发请求', async () => {
  const old = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async () => { count++; return new Response('{}'); };
  try {
    await assert.rejects(() => new EkkoBridgeClient({ ...config, bridgeUrl: 'https://example.invalid' }).rooms({}, expectedIdentity), /本机|回环/);
    await assert.rejects(() => new EkkoBridgeClient({ ...config, documentRootId: undefined }).send('room-one', { clientMessageId: 'client-one', content: '测试', mentions: [] }, expectedIdentity), /文档/);
    assert.equal(count, 0);
  } finally { globalThis.fetch = old; }
});
test('发送和核对状态缺少或畸形冻结身份时不发起网络请求', async t => {
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return Response.json({state:'sent'});});
  const client=new EkkoBridgeClient(config);
  for(const value of [undefined,{}, {...expectedIdentity,connectionId:''}, {...expectedIdentity,deviceId:'bad\r\nid'}, {...expectedIdentity,accountUserId:0}, {...expectedIdentity,accountUserId:'7'}]) {
    await assert.rejects(async()=>client.send('room-one',{clientMessageId:'client-one',content:'测试',mentions:[]},value as any),error=>(error as any).code==='expected_identity_invalid');
    await assert.rejects(async()=>client.sendStatus('room-one','client-one',value as any),error=>(error as any).code==='expected_identity_invalid');
  }
  assert.equal(calls,0);
});

test('SSE 分块读取事件，略过心跳，结束后不自动发言', async () => {
  const old = globalThis.fetch;
  const encoder = new TextEncoder();
  const chunks = ['event: room.message\ndata: {"id":"m1","content":"你好"}\n\n: keepalive\n\n', 'event: room.disconnected\ndata: {"state":"unknown"}\n\n'];
  const calls: string[] = [];
  globalThis.fetch = async url => { calls.push(String(url)); return new Response(new ReadableStream({ start(controller) { for (const part of chunks) controller.enqueue(encoder.encode(part)); controller.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } }); };
  try {
    const events: unknown[] = [];
    await new EkkoBridgeClient(config).events('room-one', event => { events.push(event); }, undefined, expectedIdentity);
    assert.deepEqual(events, [
      { event: 'room.message', data: { id: 'm1', content: '你好' } },
      { event: 'room.disconnected', data: { state: 'unknown' } },
    ]);
    assert.deepEqual(calls, ['http://127.0.0.1:8782/ekko/rooms/room-one/events']);
  } finally { globalThis.fetch = old; }
});

test('错误响应中的敏感值不传播给界面', async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 'ekko_unavailable', message: 'temporary-password test-capability' } }), { status: 503 });
  try {
    await assert.rejects(() => new EkkoBridgeClient(config).pair({ baseUrl: 'http://127.0.0.1:8748', username: 'demo-user', password: 'temporary-password' }), error => error instanceof Error && !error.message.includes('temporary-password') && !error.message.includes('test-capability'));
  } finally { globalThis.fetch = old; }
});
test('all browser reads and events carry frozen identity and preserve identity_changed',async t=>{
 const calls:RequestInit[]=[];t.mock.method(globalThis,'fetch',async(_url:any,init:RequestInit)=>{calls.push(init);return Response.json({error:{code:'identity_changed',message:'secret'}},{status:403});});
 const client=new EkkoBridgeClient(config);
 for(const read of [()=>client.rooms({},expectedIdentity),()=>client.room('room-one',{},expectedIdentity),()=>client.events('room-one',()=>{},undefined,expectedIdentity)])await assert.rejects(read,(e:any)=>e.code==='identity_changed' && e.status===403 && !e.message.includes('secret'));
 for(const call of calls){const headers=call.headers as any;assert.equal(headers['X-Ekko-Connection-Id'],expectedIdentity.connectionId);assert.equal(headers['X-Ekko-Device-Id'],expectedIdentity.deviceId);assert.equal(headers['X-Ekko-Account-User-Id'],'7');}
});

test('optional authorization records preserve exact connection identity and drop invalid auxiliary fields',async t=>{
 const identity={id:'connection-one',deviceId:'device-one',accountUserId:7,accountName:'fictional-user',state:'connected'};
 let connection:any;
 t.mock.method(globalThis,'fetch',async()=>Response.json({connection}));
 const client=new EkkoBridgeClient(config);
 for(const authorization of [undefined,{source:'jwt',expiresAt:1_800_000_000},{source:'app-login-record',expiresAt:1e20},{source:'app-login-record',expiresAt:1_800_000_000,accountUserId:99,token:'fictional-token'}]){
  connection={...identity,authorization};const result=(await client.connection()).connection;
  assert.deepEqual(result,{...identity,...(authorization?.expiresAt===1_800_000_000&&authorization.source==='app-login-record'?{authorization:{source:'app-login-record',expiresAt:1_800_000_000}}:{})});
 }
 connection={...identity,accountUserId:'7',authorization:{source:'app-login-record',expiresAt:1_800_000_000}};assert.equal((await client.connection()).connection,null);
});
