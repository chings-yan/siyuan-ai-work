import { AnswerAdoptionController, type AdoptionMode, type AdoptionPreview, type AdoptionResult, type AdoptionSource, type AdoptionTarget } from './answer-adoption.ts';
import { trapDialogKey } from './dialog-focus.ts';

export type AnswerAdoptionPanelOptions={
 controller:AnswerAdoptionController;source?:AdoptionSource;target?:{documentId:string;title:string};
 listNotebooks:()=>Promise<{id:string;name:string}[]>;copyText:(text:string)=>Promise<void>;
 isCurrent?:()=>boolean;onClose?:()=>void;
};
/** The caller mounts this in a dedicated overlay container. Original messages and drafts are untouched. */
export class AnswerAdoptionPanel {
 private disposed=false;private busy=false;private generation=0;private preview?:AdoptionPreview;private result?:AdoptionResult;
 private mode:AdoptionMode='formatted';private targetKind:'append'|'note'='append';private title='回答摘录';private notebookId='';
 private notebooks:{id:string;name:string}[]=[];private noteLoaded=false;private notice='';
 private pending:{operationId:string;target:AdoptionTarget}[]=[];private returnFocus:HTMLElement|null;
 private focusSelector='button[data-adoption-action="close"]';
 private readonly source?:AdoptionSource;private readonly target?:{documentId:string;title:string};
 constructor(private readonly container:HTMLElement,private readonly options:AnswerAdoptionPanelOptions){
  this.source=options.source?structuredClone(options.source):undefined;this.target=options.target?structuredClone(options.target):undefined;
  this.returnFocus=container.ownerDocument.activeElement as HTMLElement|null;
  container.addEventListener('click',this.click);container.addEventListener('change',this.change);container.addEventListener('input',this.input);container.addEventListener('keydown',this.key);
  this.render();void this.loadPending();
 }
 private readonly key=(event:KeyboardEvent)=>trapDialogKey(event,this.container,this.busy,()=>this.dispose());
 private node<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string):HTMLElementTagNameMap[K]{const el=this.container.ownerDocument.createElement(tag);if(text!==undefined)el.textContent=text;return el;}
 private button(action:string,text:string):HTMLButtonElement{const b=this.node('button',text);b.type='button';b.dataset.adoptionAction=action;b.disabled=this.busy;b.style.cssText='padding:6px 10px;border:1px solid var(--b3-border-color);border-radius:5px;background:var(--b3-theme-surface);color:inherit;font:inherit;cursor:pointer';return b;}
 private current():void{if(this.disposed||this.options.isCurrent?.()===false)throw Error('原回答或当前视图已变化，请关闭后重新预览');}
 private async loadPending():Promise<void>{try{const rows=await this.options.controller.pending();if(!this.disposed){this.pending=rows;this.render();}}catch{if(!this.disposed){this.notice='待核对记录读取失败；未执行写入';this.render();}}}
 private readonly input=(event:Event)=>{const input=event.target as HTMLInputElement;if(input.hasAttribute('data-adoption-title')&&!this.busy&&!this.result){this.title=input.value;this.invalidate(false);}};
 private readonly change=(event:Event)=>{
  const el=event.target as HTMLSelectElement;if(this.busy||this.result||this.disposed)return;
  if(el.hasAttribute('data-adoption-target')){this.targetKind=el.value==='note'?'note':'append';this.invalidate();if(this.targetKind==='note'&&!this.noteLoaded)void this.loadNotebooks();}
  else if(el.hasAttribute('data-adoption-mode')){this.mode=el.value==='plain'?'plain':'formatted';this.invalidate();}
  else if(el.hasAttribute('data-adoption-notebook')){this.notebookId=el.value;this.invalidate();}
 };
 private invalidate(render=true):void{this.generation++;this.preview=undefined;this.notice='';if(render)this.render();else this.container.querySelector('[data-adoption-action="confirm"]')?.remove();}
 private async loadNotebooks():Promise<void>{
  try{const rows=await this.options.listNotebooks();if(this.disposed)return;
   if(rows.some(x=>!/^\d{14}-[a-z0-9]{7}$/.test(x.id)||typeof x.name!=='string')||new Set(rows.map(x=>x.id)).size!==rows.length)throw Error('笔记本列表格式不符');
   this.notebooks=rows;this.noteLoaded=true;this.render();
  }catch{if(!this.disposed){this.notice='笔记本读取失败，请重新选择新笔记或复制回答';this.render();}}
 }
 private chosenTarget():AdoptionTarget{
  if(this.targetKind==='note'){if(!this.notebooks.some(x=>x.id===this.notebookId))throw Error('请明确选择新笔记所在笔记本');return{kind:'note',notebookId:this.notebookId,title:this.title};}
  if(!this.target)throw Error('原文档目标不可用');return{kind:'append',...this.target};
 }
 private readonly click=(event:Event)=>{
  const button=(event.target as Element)?.closest<HTMLButtonElement>('button[data-adoption-action]');if(!button||!this.container.contains(button)||button.disabled||this.busy||this.disposed)return;
  event.preventDefault();event.stopPropagation();void this.perform(button.dataset.adoptionAction!,button.dataset.operation);
 };
 private async perform(action:string,operationId?:string):Promise<void>{
  if(action==='close'){this.dispose();return;}
  const generation=this.generation;this.busy=true;this.render();
  try{
   if(action==='copy'){if(!this.source)throw Error('原回答不在当前窗口');await this.options.copyText(this.source.content);if(this.disposed)return;this.notice='已复制原回答';}
   else if(action==='prepare'){
    this.current();if(!this.source)throw Error('原回答不可用');const preview=await this.options.controller.prepare(this.source,this.chosenTarget(),this.mode);
    if(this.disposed||generation!==this.generation)return;this.current();this.preview=preview;this.notice='请核对以下最终内容与目标，再确认采纳';
   }else if(action==='confirm'){
    this.current();if(!this.preview||this.result)throw Error('请先重新预览');this.result=await this.options.controller.commit(this.preview);
    if(this.disposed)return;this.notice=this.result.message;
   }else if(action==='review'){
    const id=operationId??this.result?.operationId;if(!id)throw Error('待核对记录不可用');const result=await this.options.controller.review(id);
    if(this.disposed)return;this.notice=result.message;if(this.result?.operationId===id)this.result=result;
    this.pending=await this.options.controller.pending();
   }
  }catch(error){if(!this.disposed)this.notice=error instanceof Error?error.message:'处理失败，请保留原回答并核对';}
  finally{if(!this.disposed){this.busy=false;this.render();}}
 }
 private select(attr:string,items:{value:string;text:string}[],value:string):HTMLSelectElement{
  const el=this.node('select');el.setAttribute(attr,'');el.disabled=this.busy||Boolean(this.result);el.style.cssText='width:100%;min-width:0;padding:7px;background:var(--b3-theme-surface);color:inherit;border:1px solid var(--b3-border-color);border-radius:5px;font:inherit';
  for(const item of items){const option=this.node('option',item.text);option.value=item.value;el.append(option);}el.value=value;return el;
 }
 private render():void{
  if(this.disposed)return;const active=this.container.ownerDocument.activeElement as HTMLElement|null;
  const ownsFocus=Boolean(active&&this.container.contains(active));
  if(ownsFocus&&active){
   const action=active.dataset.adoptionAction;
   if(action&&['close','copy','prepare','confirm','review'].includes(action))this.focusSelector=`button[data-adoption-action="${action}"]${active.dataset.operation?`[data-operation="${active.dataset.operation}"]`:''}`;
   else for(const attr of ['data-adoption-target','data-adoption-mode','data-adoption-notebook','data-adoption-title','data-adoption-preview','data-adoption-original-toggle'])if(active.hasAttribute(attr)){this.focusSelector=`[${attr}]`;break;}
  }
  const originalOpen=Boolean(this.container.querySelector<HTMLDetailsElement>('[data-adoption-original]')?.open);
  const dialog=this.node('section');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');dialog.setAttribute('aria-label',this.source?'采纳回答':'核对回答采纳');dialog.tabIndex=-1;dialog.dataset.answerAdoption='';
  dialog.style.cssText='box-sizing:border-box;width:min(640px,calc(100vw - 24px));max-width:100%;max-height:calc(100dvh - 24px);overflow:auto;overscroll-behavior:contain;padding:16px;display:grid;gap:12px;border:1px solid var(--b3-border-color);border-radius:9px;background:var(--b3-theme-background);color:var(--b3-theme-on-background);font:14px/1.5 var(--b3-font-family,system-ui,sans-serif)';
  const header=this.node('header');header.style.cssText='display:flex;justify-content:space-between;gap:12px;align-items:center';header.append(this.node('strong',this.source?'采纳回答':'核对回答采纳'),this.button('close','关闭'));dialog.append(header);
  if(this.source){
   const controls=this.node('div');controls.style.cssText='display:grid;gap:10px';
   const target=this.node('label','保存位置');target.style.cssText='display:grid;gap:4px';target.append(this.select('data-adoption-target',[{value:'append',text:`追加到原文档 · ${this.target?.title??'不可用'}`},{value:'note',text:'新建独立笔记'}],this.targetKind));controls.append(target);
   if(this.targetKind==='note'){
    const notebook=this.node('label','笔记本');notebook.append(this.select('data-adoption-notebook',[{value:'',text:'请选择笔记本'},...this.notebooks.map(x=>({value:x.id,text:x.name}))],this.notebookId));controls.append(notebook);
    const title=this.node('label','新笔记标题');const input=this.node('input');input.dataset.adoptionTitle='';input.value=this.title;input.maxLength=200;input.disabled=this.busy||Boolean(this.result);input.style.cssText='box-sizing:border-box;width:100%;padding:7px;border:1px solid var(--b3-border-color);background:var(--b3-theme-surface);color:inherit';title.append(input);controls.append(title);
   }
   const mode=this.node('label','内容格式');mode.append(this.select('data-adoption-mode',[{value:'formatted',text:'保留支持的 Markdown 格式'},{value:'plain',text:'纯文本代码块（保留为文字）'}],this.mode));controls.append(mode);dialog.append(controls);
   const help=this.node('p','追加不会覆盖原文。图片、嵌入和不支持的格式可改用纯文本或复制；纯文本会作为代码块保存。');help.style.cssText='margin:0;font-size:12px;color:var(--b3-theme-on-surface)';dialog.append(help);
   const detail=this.node('details');detail.dataset.adoptionOriginal='';detail.open=originalOpen;const summary=this.node('summary','查看原回答');summary.dataset.adoptionOriginalToggle='';detail.append(summary);const original=this.node('pre',this.source.content);original.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto;font:inherit';detail.append(original);dialog.append(detail);
   if(this.preview){const label=this.node('strong',`最终内容 · ${this.preview.target.title}`);const body=this.node('pre',this.preview.preview);body.dataset.adoptionPreview='';body.tabIndex=0;body.style.cssText='margin:0;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto;background:var(--b3-theme-surface);border:1px solid var(--b3-border-color);border-radius:5px;font:inherit';dialog.append(label,body);}
   const actions=this.node('div');actions.style.cssText='display:flex;gap:8px;flex-wrap:wrap';actions.append(this.button('copy','复制原回答'));
   if(!this.result){actions.append(this.button('prepare',this.preview?'重新预览':'预览采纳'));if(this.preview)actions.append(this.button('confirm',this.targetKind==='note'?'确认新建笔记':'确认追加到文档末尾'));}
   else if(this.result.state==='unknown')actions.append(this.button('review','只读核对结果'));
   dialog.append(actions);
  }
  if(this.notice||this.busy){const status=this.node('p',this.busy?'正在处理，请稍候…':this.notice);status.setAttribute('role','status');status.style.cssText='margin:0;overflow-wrap:anywhere';dialog.append(status);}
  if(this.pending.length){const pending=this.node('section');pending.append(this.node('strong','此前的待核对采纳'));for(const item of this.pending){const row=this.node('p',item.target.title);const button=this.button('review','只读核对');button.dataset.operation=item.operationId;row.append(' ',button);pending.append(row);}dialog.append(pending);}
  this.container.replaceChildren(dialog);
  if(ownsFocus){const focus=this.container.querySelector<HTMLElement>(this.focusSelector);if(focus&&!focus.hasAttribute('disabled'))focus.focus();else dialog.focus();}
 }
 dispose():void{if(this.disposed)return;const ownedFocus=this.container.contains(this.container.ownerDocument.activeElement);this.disposed=true;this.generation++;this.container.removeEventListener('click',this.click);this.container.removeEventListener('change',this.change);this.container.removeEventListener('input',this.input);this.container.removeEventListener('keydown',this.key);this.container.replaceChildren();if(ownedFocus&&this.returnFocus?.isConnected)this.returnFocus.focus();this.options.onClose?.();}
}
