import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { BridgeError, HermesBridgeClient } from '../src/bridge.ts';
import { MessageRenderer } from '../src/message-renderer.ts';
import { renderMessageMarkup } from '../src/ui.ts';

const ROOT='20990101000000-aaaaaaa';
type Event = [string, Record<string, unknown>];
const frame = ([event,data]:Event) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const started:Event=['run.started',{run_id:'synthetic-upstream',runId:'synthetic-owner',session_id:'synthetic-session'}];
async function receive(route:'legacy'|'v2', events:Event[], bytes?:Uint8Array[]) {
  const original=globalThis.fetch;let calls=0;const seen:any[]=[];
  globalThis.fetch=async(url,init)=>{
    calls++;assert.equal(init?.method,'POST');
    assert.equal(String(url),`http://127.0.0.1:8782/${route==='v2'?'chats/synthetic-chat':'sessions/synthetic-session'}/chat/stream`);
    assert.equal(JSON.parse(String(init?.body)).message,'synthetic question');
    return new Response(new ReadableStream<Uint8Array>({start(c){for(const chunk of bytes??[new TextEncoder().encode(events.map(frame).join(''))])c.enqueue(chunk);c.close();}}));
  };
  const client=new HermesBridgeClient({bridgeUrl:'http://127.0.0.1:8782',capabilityToken:'f'.repeat(64),documentRootId:ROOT});
  try {
    const result=route==='v2'?await client.streamChatForChat('synthetic-chat','synthetic question',{},event=>seen.push(event))
      :{state:'complete',text:await client.streamChat('synthetic-session','synthetic question',{},event=>seen.push(event))};
    assert.equal(calls,1,'receiving a final body must not resubmit');return {result,seen};
  } finally {globalThis.fetch=original;}
}

// Break caught: consuming only message.delta or only terminal.text loses Studio.output.
for(const route of ['legacy','v2'] as const)for(const field of ['output','text','content']){
  test(`${route} completion-only ${field} preserves the exact final reply`,async()=>{
    const body='  完整答复\n\n第二段 ✅\n';
    const {result,seen}=await receive(route,[started,['run.completed',{[field]:body,usage:{total_tokens:17},session_id:'synthetic-session'}]]);
    assert.deepEqual(result,{state:'complete',text:body});
    assert.equal(seen.filter(event=>event.event==='run.completed').length,1);
  });
}

for(const route of ['legacy','v2'] as const){
  test(`${route} terminal snapshot replaces interim text without appending it twice`,async()=>{
    const {result}=await receive(route,[started,['message.delta',{delta:'准备中'}],['run.completed',{output:'最终正文',text:'其他兼容字段',content:'旧字段'}]]);
    assert.deepEqual(result,{state:'complete',text:'最终正文'});
  });
  test(`${route} blank and malformed completion fields retain received text`,async()=>{
    for(const terminal of [{output:'',text:' \n ',content:null},{output:{text:'not a body'},text:42,content:['not a body']},{usage:{total_tokens:3}},{output:null,text:'',content:false}]){
      const {result}=await receive(route,[started,['message.delta',{delta:'已收到'}],['message.delta',{delta:'\n'}],['message.delta',{delta:'正文'}],['run.completed',terminal]]);
      assert.deepEqual(result,{state:'complete',text:'已收到\n正文'});
    }
  });
  test(`${route} empty preferred final field does not hide a valid compatibility body`,async()=>{
    const {result}=await receive(route,[started,['run.completed',{output:'  ',text:null,content:'兼容正文'}]]);
    assert.equal(result.text,'兼容正文');
  });
  test(`${route} first terminal wins over late delta and another terminal in the same chunk`,async()=>{
    const {result,seen}=await receive(route,[started,['message.delta',{delta:'先前内容'}],['run.completed',{output:'最终内容'}],['message.delta',{delta:'迟到文字'}],['run.failed',{error:'late failure'}],['run.completed',{text:'另一轮内容'}]]);
    assert.deepEqual(result,{state:'complete',text:'最终内容'});
    assert.equal(seen.filter(event=>event.event==='run.completed').length,1);
    assert.equal(seen.some(event=>event.delta==='迟到文字'),false);
  });
  test(`${route} final Chinese body survives byte-split UTF-8 and CRLF frames`,async()=>{
    const body='完整答复：逐字读取 🦋';
    const bytes=new TextEncoder().encode([started,['run.completed',{output:body}] as Event].map(frame).join('').replaceAll('\n','\r\n'));
    const {result}=await receive(route,[],[...bytes].map(byte=>Uint8Array.of(byte)));
    assert.equal(result.text,body);
  });
  test(`${route} non-answer events and non-string deltas do not leak into reply`,async()=>{
    const {result}=await receive(route,[started,['reasoning.delta',{text:'reasoning-only'}],['tool.output',{output:'tool-only'}],['message.delta',{delta:{private:'not-text'}}],['run.completed',{}]]);
    assert.equal(result.text,'');
  });
  for(const field of ['delta','text','content'])test(`${route} supported string ${field} delta is kept when terminal has no body`,async()=>{
    const {result}=await receive(route,[started,['message.delta',{[field]:'逐字答复'}],['run.completed',{}]]);
    assert.equal(result.text,'逐字答复');
  });
}

test('V2 terminal failure or queued state cannot be promoted by a later completion',async()=>{
  for(const [event,state] of [['run.failed','failed'],['run.unknown','unknown'],['run.queued','queued'],['run.interrupted','interrupted']]){
    const {result}=await receive('v2',[started,['message.delta',{delta:'已到达片段'}],[event,{output:'not a successful answer'}],['run.completed',{output:'wrong turn'}]]);
    assert.deepEqual(result,{state,text:'已到达片段'});
  }
});
for(const event of ['run.unknown','run.interrupted','run.queued'])test(`legacy ${event} cannot be promoted by a later completion`,async()=>{
  await assert.rejects(receive('legacy',[started,['message.delta',{delta:'已到达片段'}],[event,{}],['message.delta',{delta:'迟到文字'}],['run.completed',{output:'wrong turn'}]]),
    (error:any)=>error instanceof BridgeError&&error.code==='chat_result_unknown');
});
test('a truncated stream keeps partial text unknown without a completion receipt',async()=>{
  const events:Event[]=[started,['message.delta',{delta:'片段'}]];
  assert.deepEqual((await receive('v2',events)).result,{state:'unknown',text:'片段'});
  await assert.rejects(receive('legacy',events),(error:any)=>error instanceof BridgeError&&error.code==='chat_result_unknown');
});

// Break caught: a complete empty record currently offers copy but gives no explanation.
test('empty assistant record has a visible notice and same-ID body restores exact copying',async()=>{
  const dom=new JSDOM('<div><main></main></div>');const area=dom.window.document.querySelector('main')!;
  const copies:string[]=[];Object.defineProperty(dom.window.navigator,'clipboard',{value:{writeText:async(value:string)=>{copies.push(value);}}});
  const renderer=new MessageRenderer<any>(area,renderMessageMarkup);
  const empty={id:'synthetic-empty',role:'assistant',content:' \n ',references:[],status:'complete'};
  try {
    renderer.render('synthetic-scope',[empty]);
    assert.match(area.textContent||'',/未收到.*正文/);
    assert.equal(area.querySelector('[data-copy-reply]'),null);
    assert.equal(empty.content,' \n ','presentation must not rewrite the source record');
    const node=area.querySelector('[data-message-id]');
    const content='后来读到的完整正文\n第二行';renderer.render('synthetic-scope',[{...empty,content}]);
    assert.equal(area.querySelector('[data-message-id]'),node);
    assert.doesNotMatch(area.textContent||'',/未收到.*正文/);
    area.querySelector<HTMLButtonElement>('[data-copy-reply]')!.click();await Promise.resolve();
    assert.deepEqual(copies,[content]);
  } finally {renderer.dispose();dom.window.close();}
});
