import type { ChatLink } from './store.ts';
import { escapeMessage } from '../message-renderer.ts';

export type ReplyActivityTarget={connection:string;link:ChatLink};
export type ReplyActivityState='waiting'|'unread'|'review';
export type ReplyActivity={key:string;revision:number;target:ReplyActivityTarget;state:ReplyActivityState;acknowledged:boolean;messageId?:string};
/** Observations from this plugin lifetime only; never a remote read cursor or send permission. */
export class ReplyActivityStore {
 private rows=new Map<string,ReplyActivity>();private sequence=0;
 begin(key:string,target:ReplyActivityTarget):number{
  const revision=++this.sequence;
  this.rows.delete(key);this.rows.set(key,{key,revision,target:structuredClone(target),state:'waiting',acknowledged:false});
  while(this.rows.size>100){const old=[...this.rows.values()].find(row=>row.state!=='waiting');if(!old)break;this.rows.delete(old.key);}
  return revision;
 }
 update(key:string,revision:number,state:ReplyActivityState,messageId?:string):boolean{
  const row=this.rows.get(key);if(!row||row.revision!==revision||row.state!=='waiting')return false;
  row.state=state;if(messageId)row.messageId=messageId;return true;
 }
 confirmTarget(key:string,revision:number,confirmed:ChatLink):boolean{
  const row=this.rows.get(key);if(!row||row.revision!==revision||row.state!=='waiting'||confirmed.state!=='ready'||!confirmed.storedSessionId)return false;
  const old=row.target.link;
  if((['chatId','workId','documentRootId','connectionId','adapter','profile','installId','legacyBridgeUrl'] as const).some(field=>old[field]!==confirmed[field])||(old.storedSessionId!==null&&old.storedSessionId!==confirmed.storedSessionId))return false;
  row.target.link=structuredClone(confirmed);return true;
 }
 acknowledge(key:string,revision:number):boolean{
  const row=this.rows.get(key);if(!row||row.revision!==revision||row.state==='waiting')return false;
  row.acknowledged=true;return true;
 }
 cancel(key:string,revision:number):void {const row=this.rows.get(key);if(row?.revision===revision&&row.state==='waiting')this.rows.delete(key);}
 list(connection:string):ReplyActivity[]{return structuredClone([...this.rows.values()].filter(row=>row.target.connection===connection).reverse());}
}

const labels:Record<ReplyActivityState,string>={waiting:'等待回复',unread:'新回复待查看',review:'结果待核对'};
export class ReplyActivityPanel {
 private box:HTMLDetailsElement;private list:HTMLElement;private feedback:HTMLElement;private summary:HTMLElement;private busy=false;private disposed=false;
 constructor(private root:HTMLElement,private port:{rows:()=>ReplyActivity[];open:(row:ReplyActivity)=>Promise<string|void>;acknowledge:(row:ReplyActivity)=>void}){
  this.box=root.ownerDocument.createElement('details');this.box.className='sac-reply-activity';this.box.dataset.replyActivity='';
  this.box.innerHTML='<summary aria-label="回复动态">回复动态 <span data-activity-count></span></summary><section class="sac-activity-tray" aria-label="本次回复动态"><small>仅记录本次启用期间观察到的 Hermes 回复；不是全部远端未读。</small><div data-activity-list></div><p data-activity-feedback role="status"></p></section>';
  this.summary=this.box.querySelector('[data-activity-count]')!;this.list=this.box.querySelector('[data-activity-list]')!;this.feedback=this.box.querySelector('[data-activity-feedback]')!;
  root.querySelector('.sac-dock-tabs')?.append(this.box);this.render();
 }
 render():void{
  if(this.disposed)return;
  const rows=this.port.rows();this.summary.textContent=String(rows.filter(row=>!row.acknowledged).length);
  if(!rows.length){this.list.innerHTML='<p>暂无本次回复记录</p>';return;}
  const focus=this.root.ownerDocument.activeElement as HTMLElement|null;
  const focused=focus&&this.list.contains(focus)?{key:focus.closest<HTMLElement>('[data-activity-key]')?.dataset.activityKey,action:focus.dataset.activityAction}:null;
  const scroll=this.list.scrollTop;
  this.list.innerHTML=rows.map(row=>`<article data-activity-key="${escapeMessage(row.key)}"><strong>${escapeMessage(row.target.link.title||'Hermes 对话')}</strong><small>${row.acknowledged&&row.state==='unread'?'回复已查看':labels[row.state]}${row.acknowledged&&row.state==='review'?'（提示已查看）':''}</small><div><button type="button" data-activity-action="open" ${this.busy?'disabled':''}>打开原会话</button>${row.state!=='waiting'&&!row.acknowledged?'<button type="button" data-activity-action="ack">标为已查看</button>':''}</div></article>`).join('');
  for(const article of this.list.querySelectorAll<HTMLElement>('[data-activity-key]')){
   const row=rows.find(item=>item.key===article.dataset.activityKey)!;
   article.querySelector<HTMLButtonElement>('[data-activity-action="open"]')!.onclick=()=>void this.open(row);
   const ack=article.querySelector<HTMLButtonElement>('[data-activity-action="ack"]');if(ack)ack.onclick=()=>{if(this.disposed)return;this.port.acknowledge(row);this.render();};
  }
  this.list.scrollTop=scroll;
  if(focused){const article=[...this.list.querySelectorAll<HTMLElement>('[data-activity-key]')].find(el=>el.dataset.activityKey===focused.key);const button=article?.querySelector<HTMLElement>(`[data-activity-action="${focused.action==='ack'?'ack':'open'}"]`);(button??this.box.querySelector('summary'))?.focus({preventScroll:true});}
 }
 private async open(row:ReplyActivity){
  if(this.busy||this.disposed)return;this.busy=true;this.render();this.feedback.textContent='正在核对原会话…';
  try{const result=await this.port.open(row);if(!this.disposed)this.feedback.textContent=result||'已打开原会话；查看完成后可标为已查看。';}
  catch(error){if(!this.disposed)this.feedback.textContent=error instanceof Error?error.message:'原会话暂不能打开，请核对后重试';}
  finally{this.busy=false;this.render();}
 }
 dispose(){this.disposed=true;this.box.remove();}
}

export const REPLY_ACTIVITY_CSS=`
.sac .sac-reply-activity{margin-left:auto;min-width:0;font-size:12px}
.sac .sac-reply-activity>summary{cursor:pointer;padding:5px 7px;white-space:nowrap;border-radius:5px}
.sac .sac-activity-tray{position:absolute;inset-inline:8px;top:72px;z-index:45;padding:12px;background:var(--b3-theme-background,#fff);border:1px solid var(--b3-border-color,#ddd);border-radius:8px;box-shadow:0 5px 18px #0002;max-height:min(330px,60%);overflow:auto;overflow-wrap:anywhere;line-height:1.6}
.sac [data-activity-list] article{padding:10px 0;border-bottom:1px solid var(--b3-border-color,#ddd)}
.sac [data-activity-list] strong,.sac [data-activity-list] small{display:block}
.sac [data-activity-list] article>div{display:flex;flex-wrap:wrap;gap:6px;margin-top:5px}
.sac [data-activity-list] button{font-size:12px;padding:4px 8px}
.sac [data-activity-feedback]:empty{display:none}
`;
