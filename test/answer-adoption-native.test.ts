import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { SiYuanAnswerAdoptionNative } from '../src/work/answer-adoption-native.ts';

const root='20990101000000-aaaaaaa',box='20990101000001-bbbbbbb',operation='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
function fixture(){
 const doc=new JSDOM('').window.document;let serial=2;const calls:{path:string;body:Record<string,unknown>}[]=[];const blocks=new Map<string,string>();let children:string[]=[],fault='',activeRoot=root;
 const serialize=(s:string)=>s.split('\n\n').map(text=>{const p=doc.createElement('div');p.setAttribute('data-type','NodeParagraph');p.setAttribute('data-node-id',`20990101000002-${String(serial++).padStart(7,'0')}`);const inner=doc.createElement('div');inner.setAttribute('contenteditable','true');inner.textContent=text;p.append(inner);return p.outerHTML;}).join('');
 const md=(s:string)=>{const t=doc.createElement('template');t.innerHTML=s;return [...t.content.children].map(x=>x.querySelector('[contenteditable]')?.textContent??'').join('\n\n')+'\n';};
 let roundtripDom='';const Lute={NewNodeID:()=>`20990101000002-${String(serial++).padStart(7,'0')}`,New:()=>({SetKramdownIAL:()=>{},SetSuperBlock:()=>{},SetBlockRef:()=>{},SetSanitize:()=>{},SetHTMLTag2TextMark:()=>{},SetTextMark:()=>{},SetProtyleWYSIWYG:()=>{},Md2BlockDOM:(s:string)=>s==='OWN-CONTROLLED-MARKDOWN'?roundtripDom:serialize(s),BlockDOM2StdMd:md,BlockDOM2Md:(s:string)=>{roundtripDom=s;return'OWN-CONTROLLED-MARKDOWN';}})};
 const api=async(path:string,body:Record<string,unknown>):Promise<unknown>=>{calls.push({path,body});const id=String(body.id);if(path==='/api/block/getBlockInfo')return {rootID:fault==='wrong-root'&&id!==root?box:activeRoot,box,path:`/${activeRoot}.sy`};
 if(path==='/api/notebook/lsNotebooks')return {notebooks:[{id:box,name:'虚构笔记本',closed:false}]};
 if(path==='/api/attr/getBlockAttrs')return {title:fault==='wrong-title'?'其他笔记':'独立笔记'};
 if(path==='/api/block/getChildBlocks')return children.map(id=>({id}));if(path==='/api/block/getBlockDOM')return {id,dom:id===root?[...blocks.values()].join(''):blocks.get(id)};
 if(path==='/api/block/appendBlock'||path==='/api/filetree/createDocWithMd'){const creating=path.endsWith('createDocWithMd');const t=doc.createElement('template');t.innerHTML=creating?roundtripDom:String(body.data);const top=[...t.content.children];children=top.map(x=>x.getAttribute('data-node-id')!);for(const el of top)blocks.set(el.getAttribute('data-node-id')!,el.outerHTML);if(creating){activeRoot='20990101000003-ddddddd';return activeRoot;}return [{doOperations:[{action:'insert',id:children[0],data:fault==='first-only'?top[0].outerHTML:String(body.data),parentID:root,previousID:'',retData:null}],undoOperations:null}];}
 throw Error(`unexpected API ${path}`);};
 const native=new SiYuanAnswerAdoptionNative({api,document:doc,lute:Lute});
 return {doc,native,calls,blocks,setFault:(value:string)=>fault=value};
}
test('append validates full multi-block transaction and direct trees without SQL',async()=>{
 const f=fixture(),p=await f.native.prepare('first\n\nsecond',{kind:'append',documentId:root,title:'原文档'},operation,'formatted');
 assert.equal(p.proof.topIds.length,2);assert.equal(f.calls.some(x=>x.path.includes('append')),false);
 await f.native.checkTarget(p);const receipt=await f.native.write(p);await f.native.verify(p,receipt);
 assert.equal(f.calls.filter(x=>x.path==='/api/block/appendBlock').length,1);assert.equal(f.calls.some(x=>x.path.includes('/sql')),false);
 assert.equal(f.calls.filter(x=>x.path==='/api/block/getBlockDOM'&&x.body.id!==root).length,2);
});
test('first block receipt never proves the rest of an answer',async()=>{
 const f=fixture(),p=await f.native.prepare('first\n\nsecond',{kind:'append',documentId:root,title:'原文档'},operation,'formatted');f.setFault('first-only');await assert.rejects(f.native.write(p),/回执|完整|不符/);
});
test('direct readback must retain marker, exact body, complete block set and original root',async()=>{
 for(const fault of ['body','marker','missing','wrong-root']){const f=fixture(),p=await f.native.prepare('first\n\nsecond',{kind:'append',documentId:root,title:'原文档'},operation,'formatted');const receipt=await f.native.write(p);const id=p.proof.topIds[1];
 if(fault==='body')f.blocks.set(id,f.blocks.get(id)!.replace('second','changed'));
 if(fault==='marker')f.blocks.set(id,f.blocks.get(id)!.replace(operation,'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'));
 if(fault==='missing')f.blocks.delete(id);if(fault==='wrong-root')f.setFault(fault);
 await assert.rejects(f.native.verify(p,receipt));}
});
test('missing actual native Lute capabilities refuse before any mutation',async()=>{
 const f=fixture();const native=new SiYuanAnswerAdoptionNative({api:async()=>{throw Error('no API');},document:f.doc,lute:{New:()=>({}),NewNodeID:()=>root}});
 await assert.rejects(native.prepare('text',{kind:'append',documentId:root,title:'doc'},operation,'formatted'),/Lute|能力/);
});
test('an independent new note uses one create, exact title and complete direct readback',async()=>{
 const f=fixture(),plan=await f.native.prepare('first\n\nsecond',{kind:'note',notebookId:box,title:'独立笔记'},operation,'formatted');await f.native.checkTarget(plan);const receipt=await f.native.write(plan);await f.native.verify(plan,receipt);
 assert.equal(f.calls.filter(x=>x.path==='/api/filetree/createDocWithMd').length,1);assert.equal(f.calls.some(x=>x.path==='/api/attr/setBlockAttrs'||x.path==='/api/query/sql'),false);
 await f.native.verify(plan);assert.equal(f.calls.filter(x=>x.path==='/api/filetree/createDocWithMd').length,1);
 f.setFault('wrong-title');await assert.rejects(f.native.verify(plan,receipt),/标题|目标/);
});
test('existing block identity collision refuses before append',async()=>{
 const f=fixture(),plan=await f.native.prepare('first',{kind:'append',documentId:root,title:'doc'},operation,'formatted');f.blocks.set(plan.proof.topIds[0],plan.dom);await assert.rejects(f.native.checkTarget(plan),/冲突/);assert.equal(f.calls.some(x=>x.path==='/api/block/appendBlock'),false);
});
