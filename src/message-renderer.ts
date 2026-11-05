/** Native Markdown output is untrusted, including HTML returned by the model. */
const allowed = new Set('P BR HR H1 H2 H3 H4 H5 H6 UL OL LI BLOCKQUOTE PRE CODE EM STRONG DEL S A TABLE THEAD TBODY TFOOT TR TH TD SUP SUB SPAN DIV'.split(' '));
const discard = new Set('SCRIPT STYLE IFRAME OBJECT EMBED SVG MATH FORM INPUT BUTTON TEXTAREA SELECT TEMPLATE LINK META BASE'.split(' '));
const engines = new WeakMap<Document, { MarkdownStr: (name: string, text: string) => string }>();
export const escapeMessage = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function markdownMarkup(value: string, doc?: Document): string {
 if (!doc) return '<div class="sac-markdown-fallback">'+escapeMessage(value)+'</div>';
 let engine = engines.get(doc);
 try {
  if (!engine) { engine = (doc.defaultView as any)?.Lute?.New(); if (engine) engines.set(doc, engine); }
  if (!engine?.MarkdownStr) return '<div class="sac-markdown-fallback" title="原生 Markdown 渲染暂不可用，显示原文">'+escapeMessage(value)+'</div>';
  // Template content remains inert while all attributes and unsupported nodes are removed.
  const template=doc.createElement('template'); template.innerHTML=engine.MarkdownStr('ai-work-message',value);
  const clean=(parent:ParentNode)=>{for(const node of [...parent.childNodes]){
   if(node.nodeType!==1){if(node.nodeType!==3)node.remove();continue;}
   const el=node as HTMLElement, tag=el.tagName;
   if(tag==='IMG'){el.replaceWith(doc.createTextNode('[图片未加载'+(el.getAttribute('alt')?'：'+el.getAttribute('alt'):'')+']'));continue;}
   if(discard.has(tag)){el.remove();continue;}
   clean(el);
   if(!allowed.has(tag)){el.replaceWith(...el.childNodes);continue;}
   const href=el.getAttribute('href'), title=el.getAttribute('title');
   for(const attr of [...el.attributes])el.removeAttribute(attr.name);
   if(tag==='A'&&href&&/^(https?:\/\/|mailto:|siyuan:\/\/blocks\/)/i.test(href.trim())&&!/[\u0000-\u0020\u007f]/.test(href)) {el.setAttribute('href',href);el.setAttribute('rel','noopener noreferrer');}
   if(title)el.setAttribute('title',title);
  }};clean(template.content);
  for(const pre of template.content.querySelectorAll('pre')){if(!pre.querySelector('code')){const code=doc.createElement('code');code.textContent=pre.textContent;pre.replaceChildren(code);}const copy=doc.createElement('button');copy.type='button';copy.dataset.copyCode='';copy.textContent='复制代码';copy.setAttribute('aria-label','复制代码');pre.append(copy);}
  return '<div class="sac-markdown">'+template.innerHTML+'</div>';
 } catch {return '<div class="sac-markdown-fallback" title="Markdown 显示失败，显示原文">'+escapeMessage(value)+'</div>';}
}

type Entry = { node: HTMLElement; signature: string; original: string };
/** One instance per message viewport. Keys include the full runtime session identity. */
export class MessageRenderer<T extends {id:string;content:string}> {
 private entries=new Map<string,Entry>();
 private key='';
 private positions=new Map<string,number>();
 private latest:HTMLButtonElement;
 private listeners:AbortController;
 private resizeObserver?:ResizeObserver;
 constructor(private area:HTMLElement,private markup:(item:T,doc:Document)=>string){
  const doc=area.ownerDocument;this.listeners=new (doc.defaultView as any).AbortController();
  this.latest=doc.createElement('button');this.latest.type='button';this.latest.dataset.messageLatest='';this.latest.className='sac-message-latest';this.latest.textContent='回到最新 ↓';this.latest.hidden=true;
  if(area.hasAttribute('data-chat-only'))this.latest.dataset.chatOnly='';
  area.after(this.latest);
  const signal=this.listeners.signal;
  this.latest.addEventListener('click',()=>{area.scrollTop=area.scrollHeight;this.latest.hidden=true;},{signal});
  area.addEventListener('scroll',()=>{if(this.atBottom())this.latest.hidden=true;this.positions.set(this.key,area.scrollTop);this.positionLatest();},{signal});
  area.addEventListener('click',event=>{void this.copy(event);},{signal});
  doc.defaultView?.addEventListener('resize',()=>this.positionLatest(),{signal});
  const Observer=(doc.defaultView as any)?.ResizeObserver;if(Observer){this.resizeObserver=new Observer(()=>this.positionLatest());this.resizeObserver!.observe(area);}
 }
 private positionLatest(){
  if(this.latest.hidden)return;
  const parent=this.latest.offsetParent as HTMLElement|null;if(!parent)return;
  const view=this.area.getBoundingClientRect(),host=parent.getBoundingClientRect(),button=this.latest.getBoundingClientRect();
  this.latest.style.left=(view.left-host.left-parent.clientLeft+parent.scrollLeft+(view.width-button.width)/2)+'px';
  this.latest.style.top=(view.bottom-host.top-parent.clientTop+parent.scrollTop-button.height-6)+'px';
 }
 /** Explicit local actions may reveal a message while ordinary arrivals preserve reading position. */
 revealMessage(id:string,bodySelector?:string):void{
  const entry=this.entries.get(id);if(!entry)return;
  const target=bodySelector?entry.node.querySelector<HTMLElement>(bodySelector)??entry.node:entry.node;
  this.area.scrollTop+=target.getBoundingClientRect().top-this.area.getBoundingClientRect().top-this.area.clientTop;
  this.positions.set(this.key,this.area.scrollTop);this.latest.hidden=true;this.positionLatest();
 }
 private atBottom(){return this.area.scrollHeight-this.area.clientHeight-this.area.scrollTop<36;}
 private async copy(event:Event){
  const target=(event.target as Element).closest<HTMLButtonElement>('[data-copy-reply],[data-copy-code]');if(!target||!this.area.contains(target))return;
  const article=target.closest<HTMLElement>('[data-message-id]');const entry=article&&this.entries.get(article.dataset.messageId!);if(!entry)return;
  const value=target.hasAttribute('data-copy-code')?target.parentElement?.querySelector('code')?.textContent??'':entry.original;
  try{const clipboard=this.area.ownerDocument.defaultView?.navigator.clipboard;if(!clipboard?.writeText)throw new Error('clipboard unavailable');await clipboard.writeText(value);target.textContent='已复制';}
  catch{target.textContent='复制失败，请选择文字复制';}
 }
 render(key:string,items:T[],empty:string='',leading?:HTMLElement,prepend=false):void{
  const area=this.area, switched=key!==this.key, bottom=this.atBottom(), top=area.scrollTop,height=area.scrollHeight;
  const viewport=area.getBoundingClientRect();
  const anchor=[...this.entries.values()].map(x=>x.node).find(node=>node.getBoundingClientRect().bottom>viewport.top);
  const offset=anchor?anchor.getBoundingClientRect().top-viewport.top:0;
  if(switched){if(this.key)this.positions.set(this.key,top);this.key=key;this.entries.clear();area.replaceChildren();this.latest.hidden=true;}
  area.querySelector('[data-message-empty]')?.remove();
  const wanted=new Set(items.map(x=>x.id));for(const [id,entry] of this.entries)if(!wanted.has(id)){entry.node.remove();this.entries.delete(id);}
  let changed=switched;
  if(leading){const old=area.querySelector('[data-message-leading]');if(old!==leading)old?.remove();leading.dataset.messageLeading='';if(area.firstChild!==leading)area.prepend(leading);}else area.querySelector('[data-message-leading]')?.remove();
  let previous:Element|null=leading??null;
  for(const item of items){const signature=JSON.stringify(item);let entry=this.entries.get(item.id);
   if(!entry){const template=area.ownerDocument.createElement('template');template.innerHTML=this.markup(item,area.ownerDocument);const node=template.content.firstElementChild as HTMLElement;node.dataset.messageId=item.id;entry={node,signature,original:item.content};this.entries.set(item.id,entry);changed=true;}
   else if(entry.signature!==signature){const template=area.ownerDocument.createElement('template');template.innerHTML=this.markup(item,area.ownerDocument);entry.node.replaceChildren(...template.content.firstElementChild!.childNodes);entry.signature=signature;entry.original=item.content;changed=true;}
   const expected=previous?previous.nextElementSibling:area.firstElementChild;if(expected!==entry.node)area.insertBefore(entry.node,expected);previous=entry.node;
  }
  if(!items.length){const wrapper=area.ownerDocument.createElement('div');wrapper.dataset.messageEmpty='';wrapper.innerHTML=empty;area.append(wrapper);}
  if(switched){area.scrollTop=this.positions.get(key)??area.scrollHeight;this.latest.hidden=this.atBottom();}
  else if(prepend){area.scrollTop=anchor?.isConnected?area.scrollTop+anchor.getBoundingClientRect().top-area.getBoundingClientRect().top-offset:top+area.scrollHeight-height;}
  else if(changed&&bottom){area.scrollTop=area.scrollHeight;this.latest.hidden=true;}
  else {area.scrollTop=top;if(changed)this.latest.hidden=false;}
  this.positionLatest();
 }
 dispose(){this.listeners.abort();this.resizeObserver?.disconnect();this.latest.remove();this.entries.clear();}
}
