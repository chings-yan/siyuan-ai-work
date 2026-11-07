import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {KnowledgePanel,type KnowledgePanelPorts} from '../src/knowledge/panel';
const rootId='20990101000000-aaaaaaa',id='20990101000001-bbbbbbb',box='20990101000002-ccccccc';
const source={rootId,box,path:`/${rootId}.sy`,title:'虚构文档'};
const row={id,rootID:rootId,box,path:source.path,hPath:'/虚构文档',content:'<img src=x onerror=evil()>高亮'};
const page={blocks:[row],pageCount:1,matchedBlockCount:1,matchedRootCount:1};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function settle(){for(let i=0;i<5;i++)await tick();}
function setup(overrides:Partial<KnowledgePanelPorts>={}){
 const dom=new JSDOM('<body><input id="draft" value="保留草稿"><main></main></body>',{pretendToBeVisual:true});
 const root=dom.window.document.querySelector<HTMLElement>('main')!;const calls:string[]=[],added:any[]=[];let scene='a';let text='准确正文';
 const ports:KnowledgePanelPorts={currentScene:()=>scene,getScope:async()=>({kind:'documents',documents:[source]}),api:async(path)=>{calls.push(path);return path.endsWith('getBlockInfo')?{rootID:rootId,box,path:source.path}:path.endsWith('getBlockKramdown')?{id,kramdown:text}:page},addReference:async(block,isCurrent)=>{if(isCurrent())added.push(block)},openDocument:()=>{},...overrides};
 const panel=new KnowledgePanel(root,ports);panel.show();
 const el=<T extends HTMLElement>(selector:string)=>{const found=root.querySelector<T>(selector);assert.ok(found,`missing ${selector}`);return found};
 const query=(value='关键词')=>{const input=el<HTMLInputElement>('[data-knowledge-query]');input.value=value;input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
 const search=async()=>{query();el<HTMLButtonElement>('[data-knowledge-search]').click();await settle()};
 return {dom,root,panel,ports,calls,added,el,query,search,setScene:(v:string)=>scene=v,setText:(v:string)=>text=v};
}
test('panel defaults to current document and keyword, and never searches on show or mode choice',()=>{
 const f=setup();assert.equal(f.el<HTMLSelectElement>('[data-knowledge-scope]').value,'current');assert.equal(f.el<HTMLSelectElement>('[data-knowledge-mode]').value,'keyword');
 const mode=f.el<HTMLSelectElement>('[data-knowledge-mode]');mode.value='semantic';mode.dispatchEvent(new f.dom.window.Event('change'));assert.match(f.root.textContent!,/已配置.*模型/);assert.deepEqual(f.calls,[]);f.panel.dispose();
});
test('result snippets are inert text; preview and reference use fresh exact block reads',async()=>{
 const f=setup();await f.search();assert.equal(f.root.querySelector('img'),null);assert.match(f.root.textContent!,/onerror=evil/);
 f.el<HTMLButtonElement>('[data-knowledge-preview]').click();await settle();assert.equal(f.el('[data-knowledge-body]').textContent,'准确正文');
 f.setText('更新后的准确正文');f.el<HTMLButtonElement>('[data-knowledge-add]').click();await settle();assert.equal(f.added[0].markdown,'更新后的准确正文');assert.equal(f.calls.filter(p=>p.endsWith('getBlockKramdown')).length,2);f.panel.dispose();
});
test('query change invalidates late search without stealing focus from the existing draft',async()=>{
 let resolve!:(v:unknown)=>void;const f=setup({api:()=>new Promise(r=>resolve=r)});f.query();f.el<HTMLButtonElement>('[data-knowledge-search]').click();await tick();
 f.query('另一词');const draft=f.dom.window.document.querySelector<HTMLInputElement>('#draft')!;draft.focus();resolve(page);await settle();
 assert.equal(f.root.querySelector('[data-knowledge-preview]'),null);assert.equal(f.dom.window.document.activeElement,draft);assert.equal(draft.value,'保留草稿');f.panel.dispose();
});
test('scope change, hide, dispose, and scene change prevent a late selection adding references',async()=>{
 for(const invalidate of ['scope','hide','dispose','scene'] as const){
  const f=setup();await f.search();let resolve!:(v:unknown)=>void;f.ports.api=async()=>new Promise(r=>resolve=r);
  f.el<HTMLButtonElement>('[data-knowledge-add]').click();await tick();
  if(invalidate==='scope'){const select=f.el<HTMLSelectElement>('[data-knowledge-scope]');select.value='all';select.dispatchEvent(new f.dom.window.Event('change'))}
  else if(invalidate==='scene')f.setScene('b');else f.panel[invalidate]();
  resolve({rootID:rootId,box,path:source.path});await settle();assert.equal(f.added.length,0);f.panel.dispose();
 }
});
test('failed repeat query preserves previous verified results with a failure notice',async()=>{
 const f=setup();await f.search();f.ports.api=async()=>{throw Error('private error detail')};f.el<HTMLButtonElement>('[data-knowledge-search]').click();await settle();
 assert.ok(f.root.querySelector('[data-knowledge-preview]'));assert.match(f.el('[data-knowledge-status]').textContent!,/失败.*保留/);assert.doesNotMatch(f.root.textContent!,/private error/);f.panel.dispose();
});
test('scope membership changing before a selection causes no block read or reference',async()=>{
 const f=setup();await f.search();const before=f.calls.length;f.ports.getScope=async()=>({kind:'all'});f.el<HTMLButtonElement>('[data-knowledge-add]').click();await settle();assert.equal(f.added.length,0);assert.equal(f.calls.length,before);f.panel.dispose();
});
test('load more appends verified results and Enter submits through the form',async()=>{
 const f=setup({api:async(_path,body)=>body.page===1?{...page,pageCount:2}: {...page,blocks:[{...row,id:'20990101000003-ddddddd'}],pageCount:2}});
 f.query();f.el<HTMLFormElement>('[data-knowledge-form]').dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await settle();
 f.el<HTMLButtonElement>('[data-knowledge-more]').click();await settle();assert.equal(f.root.querySelectorAll('[data-knowledge-result]').length,2);f.panel.dispose();
});
test('results from an earlier scene cannot be selected even without a documentChanged notification',async()=>{
 const f=setup();await f.search();const before=f.calls.length;f.setScene('changed');f.el<HTMLButtonElement>('[data-knowledge-add]').click();await settle();assert.equal(f.added.length,0);assert.equal(f.calls.length,before);f.panel.dispose();
});
test('partial-page warning persists when a later page succeeds',async()=>{
 const second='20990101000003-ddddddd';
 const f=setup({getScope:async()=>({kind:'documents',documents:[source,{rootId:second,box:second,path:`/${second}.sy`,title:'第二篇'}]}),api:async(_path,body)=>{
  if((body.paths as string[])[0].startsWith(second)&&body.page===1)throw Error('fail');
  return (body.paths as string[])[0].startsWith(second)?{blocks:[],pageCount:0,matchedBlockCount:0,matchedRootCount:0}:{...page,blocks:[{...row,id:body.page===1?id:'20990101000004-eeeeeee'}],pageCount:2};
 }});await f.search();assert.match(f.el('[data-knowledge-status]').textContent!,/部分.*失败/);f.el<HTMLButtonElement>('[data-knowledge-more]').click();await settle();assert.match(f.el('[data-knowledge-status]').textContent!,/部分.*失败/);f.panel.dispose();
});
test('scope reads receive a cancellation signal and stop when the panel hides',async()=>{
 let scopeSignal:AbortSignal|undefined;
 const f=setup({getScope:async(_choice,signal)=>{scopeSignal=signal;return new Promise(()=>{})}});
 f.query();f.el<HTMLButtonElement>('[data-knowledge-search]').click();await tick();
 assert.ok(scopeSignal);assert.equal(scopeSignal.aborted,false);f.panel.hide();assert.equal(scopeSignal.aborted,true);await settle();assert.equal(f.calls.length,0);f.panel.dispose();
});
test('scope metadata receives the bounded read deadline signal, not only the view signal',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let scopeSignal:AbortSignal|undefined;
 const f=setup({getScope:async(_choice,signal)=>{scopeSignal=signal;return new Promise(()=>{})}});
 f.query();f.el<HTMLButtonElement>('[data-knowledge-search]').click();for(let i=0;i<8;i++)await Promise.resolve();
 assert.ok(scopeSignal);t.mock.timers.tick(8001);for(let i=0;i<8;i++)await Promise.resolve();
 assert.equal(scopeSignal.aborted,true);assert.equal(f.calls.length,0);assert.match(f.el('[data-knowledge-status]').textContent!,/失败/);f.panel.dispose();t.mock.timers.reset();
});
test('last supported page hides load more and exposes a truncation notice',async()=>{
 const requested:number[]=[];const f=setup({api:async(_path,body)=>{const current=body.page as number;requested.push(current);return {...page,blocks:[{...row,id:`20990101000001-b${String(current).padStart(6,'0')}`}],pageCount:101}}});
 await f.search();for(let i=2;i<=100;i++){f.el<HTMLButtonElement>('[data-knowledge-more]').click();await settle();}
 assert.equal(f.el<HTMLButtonElement>('[data-knowledge-more]').hidden,true);assert.match(f.el('[data-knowledge-status]').textContent!,/100.*上限/);assert.equal(requested.length,100);assert.equal(requested.at(-1),100);f.panel.dispose();
});
