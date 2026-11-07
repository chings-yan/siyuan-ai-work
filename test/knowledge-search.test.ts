import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeKnowledgeScope, type KnowledgeScope} from '../src/knowledge/scope';
import {searchKnowledge, readKnowledgeBlock, type KnowledgeApi} from '../src/knowledge/search';

const root='20990101000000-aaaaaaa', block='20990101000001-bbbbbbb', box='20990101000002-ccccccc';
const other='20990101000003-ddddddd';
const doc={rootId:root,box,path:`/${root}.sy`,title:'虚构文档'};
const scope:KnowledgeScope={kind:'documents',documents:[doc]};
const row={id:block,rootID:root,box,path:doc.path,hPath:'/虚构文档',content:'<mark>摘要</mark>'};
const page=(blocks:unknown[]=[row],pageCount=1)=>({blocks,pageCount,matchedBlockCount:blocks.length,matchedRootCount:1});
const result={id:block,rootId:root,box,path:doc.path,title:'/虚构文档',snippet:'不是正文'};

test('bounded scopes reject empty, malformed paths and conflicting roots without broadening',async()=>{
 let calls=0; const api:KnowledgeApi=async()=>{calls++;return page()};
 for(const documents of [[],[{...doc,path:'/bad.sy'}],[doc,{...doc,box:other}]]) {
  assert.throws(()=>freezeKnowledgeScope({kind:'documents',documents}));
  await assert.rejects(searchKnowledge(api,{scope:{kind:'documents',documents},query:'关键词',mode:'keyword'}));
 }
 assert.equal(calls,0);
});
test('freezes source identity and uses native method zero with an exact box path',async()=>{
 const mutable={...doc};const frozen=freezeKnowledgeScope({kind:'documents',documents:[mutable]});mutable.path='/bad.sy';
 const requests:unknown[]=[];const found=await searchKnowledge(async(path,body)=>{requests.push({path,body});return page()}, {scope:frozen,query:'  关键词  ',mode:'keyword'});
 assert.equal(found.results[0].id,block);assert.equal(found.results[0].snippet,row.content);
 const request=requests[0] as any;assert.equal(request.path,'/api/search/fullTextSearchBlock');assert.equal(request.body.method,0);
 assert.equal(request.body.notebook,box);
 assert.deepEqual(request.body.paths,[`${box}/${root}.sy`]);assert.equal(request.body.query,'关键词');assert.equal(request.body.groupBy,0);
});
test('whole-library paths are available only through explicit all scope',async()=>{
 let paths:unknown;await searchKnowledge(async(_path,body)=>{paths=body.paths;return page()}, {scope:{kind:'all'},query:'关键词',mode:'keyword'});
 assert.deepEqual(paths,[]);
});
test('rejects wrong source and malformed pagination rather than yielding a reference',async()=>{
 for(const body of [page([{...row,rootID:other}]),page([{...row,box:other}]),page([{...row,path:`/${other}.sy`}]),page([{...row,id:'invalid'}]),{...page(),pageCount:-1},{...page(),blocks:null},page([row,{...row,content:'冲突'}])]){
  await assert.rejects(searchKnowledge(async()=>body,{scope,query:'词',mode:'keyword'}));
 }
});
test('separates notebook requests and reports partial failure without discarding verified rows',async()=>{
 const doc2={rootId:other,box:other,path:`/${other}.sy`,title:'第二篇'};const calls:any[]=[];
 const found=await searchKnowledge(async(_path,body)=>{calls.push(body.paths);if((body.paths as string[])[0].startsWith(other))throw Error('offline');return page()}, {scope:{kind:'documents',documents:[doc,doc2]},query:'词',mode:'keyword'});
 assert.equal(found.results.length,1);assert.equal(found.issues.length,1);assert.equal(found.hasMore,false);assert.equal(calls.length,2);
});
test('semantic capability must be enabled and valid before semantic provider can run',async()=>{
 for(const stat of [{enabled:false,indexed:0,pending:0,failed:0},{enabled:'yes',indexed:2,pending:0,failed:0}]){
  const calls:string[]=[];await assert.rejects(searchKnowledge(async(path)=>{calls.push(path);return stat}, {scope,query:'词',mode:'semantic'}));assert.deepEqual(calls,['/api/ai/embeddingStat']);
 }
});
test('semantic empty is explicitly uncertain and incomplete index is reported',async()=>{
 const paths:string[]=[];const found=await searchKnowledge(async(path)=>{paths.push(path);return path.endsWith('embeddingStat')?{enabled:true,indexed:2,pending:1,failed:0}:page([],0)}, {scope,query:'词',mode:'semantic'});
 assert.equal(found.semanticEmpty,true);assert.equal(found.issues.length,1);assert.deepEqual(paths,['/api/ai/embeddingStat','/api/search/semanticSearchBlock']);
});
test('timeouts and cancellation settle even when a provider ignores AbortSignal',async()=>{
 const api:KnowledgeApi=()=>new Promise(()=>{});const start=Date.now();await assert.rejects(searchKnowledge(api,{scope,query:'词',mode:'keyword',timeoutMs:20}),/超时/);assert.ok(Date.now()-start<1000);
 const ac=new AbortController();const pending=searchKnowledge(api,{scope,query:'词',mode:'keyword',signal:ac.signal});ac.abort();await assert.rejects(pending,/取消/);
});
test('exact reference reads body and source twice rather than copying a search snippet',async()=>{
 const requests:string[]=[];const exact=await readKnowledgeBlock(async(path,body)=>{requests.push(path);assert.equal(body.id,block);return path.endsWith('getBlockInfo')?{rootID:root,box,path:doc.path}:{id:block,kramdown:'准确 **原文**'}},scope,result);
 assert.equal(exact.markdown,'准确 **原文**');assert.deepEqual(requests,['/api/block/getBlockInfo','/api/block/getBlockKramdown','/api/block/getBlockInfo']);
});
test('reference rejects mismatched body id, illegal info id, and source moving during read',async()=>{
 for(const failure of ['body','info','move']){
  let reads=0;await assert.rejects(readKnowledgeBlock(async(path)=>{
   if(path.endsWith('getBlockKramdown'))return {id:failure==='body'?other:block,kramdown:'正文'};
   reads++;return {id:failure==='info'?'broken':block,rootID:failure==='move'&&reads===2?other:root,box,path:doc.path};
  },scope,result));
 }
});
test('conflicting block identity across notebooks invalidates the whole search instead of retaining the first guess',async()=>{
 const second={rootId:other,box:other,path:`/${other}.sy`,title:'第二篇'};
 await assert.rejects(searchKnowledge(async(_path,body)=>page([{...row,...((body.paths as string[])[0].startsWith(other)?{rootID:other,box:other,path:second.path}:{})}]),{scope:{kind:'documents',documents:[doc,second]},query:'词',mode:'keyword'}),/冲突/);
});
test('total deadline preserves only verified groups and aborts a hanging group without starting later reads',async()=>{
 const third='20990101000004-eeeeeee';
 const documents=[doc,{rootId:other,box:other,path:`/${other}.sy`,title:'第二篇'},{rootId:third,box:third,path:`/${third}.sy`,title:'第三篇'}];
 const calls:string[]=[];let release!:(value:unknown)=>void;let stalledSignal:AbortSignal|undefined;
 const started=Date.now();const found=await searchKnowledge(async(_path,body,signal)=>{
  const notebook=body.notebook as string;calls.push(notebook);if(notebook===box)return page();
  stalledSignal=signal;return new Promise(resolve=>release=resolve);
 },{scope:{kind:'documents',documents},query:'词',mode:'keyword',timeoutMs:30});
 assert.ok(Date.now()-started<1000);assert.deepEqual(found.results.map(item=>item.id),[block]);assert.match(found.issues.join(' '),/部分.*超时/);
 assert.equal(stalledSignal?.aborted,true);assert.deepEqual(calls,[box,other]);
 release(page([{...row,id:other,rootID:other,box:other,path:`/${other}.sy`}]));await new Promise(resolve=>setTimeout(resolve,0));
 assert.deepEqual(calls,[box,other]);assert.deepEqual(found.results.map(item=>item.id),[block]);
});
test('user cancellation discards partial results instead of converting cancellation into partial success',async()=>{
 const controller=new AbortController();const calls:string[]=[];
 await assert.rejects(searchKnowledge(async(_path,body)=>{
  const notebook=body.notebook as string;calls.push(notebook);if(notebook===box)return page();
  controller.abort();return new Promise(()=>{});
 },{scope:{kind:'documents',documents:[doc,{rootId:other,box:other,path:`/${other}.sy`,title:'第二篇'}]},query:'词',mode:'keyword',signal:controller.signal}),/取消/);
 assert.deepEqual(calls,[box,other]);
});
test('page 100 reports truncation and does not advertise an unsupported page 101',async()=>{
 const found=await searchKnowledge(async()=>page([row],101),{scope,query:'词',mode:'keyword',page:100});
 assert.equal(found.hasMore,false);assert.match(found.issues.join(' '),/100.*上限/);
});
