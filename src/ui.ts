import type { ConnectionView } from './bridge.ts';
import {connectionLabel} from './work/connection-settings.ts';
import { markdownMarkup } from './message-renderer.ts';
import type { Reference } from './references.ts';
import type { EditPlan } from './core.ts';

export type UIMessage = { role:'user'|'assistant'; content:string; references:Reference[]; status?:string; plan?:EditPlan[]; workflowActions?:boolean };
export type ComposerKey = { key:string; shiftKey?:boolean; isComposing?:boolean };
export type MentionMatch = { query:string; start:number; end:number };
export type MentionAction = { kind:'move'; index:number}|{ kind:'choose'; index:number}|{ kind:'close'}|{ kind:'ignore'};

export function renderChatConnection(chat:{kind:string;state:string}):string {
  const label=chat.kind==='serve'?'Hermes 服务':chat.kind==='studio'?'Studio':chat.kind==='legacy-api'?'旧 API':'待确认来源';
  return `${label}${chat.state==='offline'?' · 未连接':chat.state==='source-unknown'&&chat.kind!=='unresolved'?' · 待确认来源':''}`;
}
export function renderConnectionChoices(connections:ConnectionView[],selected=''):string {
  const states:Record<string,string>={ready:'可用',offline:'未连接',auth_missing:'缺少授权',auth_failed:'授权被拒绝',incompatible:'读取能力待核对',install_mismatch:'安装身份待核对',install_changed:'安装身份待核对',connected:'尚未核验',configured:'尚未核验'};
  return `<option value="">检测后选择服务</option>${selected&&!connections.some(v=>v.id===selected)?`<option value="${esc(selected)}" selected>原选择暂未检测到</option>`:''}${connections.map(item=>`<option value="${esc(item.id)}" ${item.id===selected?'selected':''}>${esc(connectionLabel(item))} · ${esc(states[item.state]||'待核对')}</option>`).join('')}`;
}

export function prepareOutgoingMessage(textarea:HTMLTextAreaElement):string {
  const text=textarea.value.trim();
  if(!text) return '';
  textarea.value='';
  const EventCtor=textarea.ownerDocument?.defaultView?.Event ?? Event;
  textarea.dispatchEvent(new EventCtor('input', { bubbles:true }));
  const popup=textarea.parentElement?.querySelector<HTMLElement>('[data-mention-list]');
  if(popup) { popup.hidden=true; popup.replaceChildren(); }
  return text;
}
export function bindComposerResize(root:HTMLElement, config:{initialHeight?:number;onResize?:(height:number)=>void}={}):()=>void {
  const grip=root.querySelector<HTMLElement>('[data-composer-resize]');
  const textarea=root.querySelector<HTMLTextAreaElement>('.sac-composer textarea');
  const messages=root.querySelector<HTMLElement>('.sac-main, [data-ekko-messages]');
  const view=root.ownerDocument.defaultView;
  if(!grip||!textarea||!messages||!view)return ()=>{};
  const controller=new (view as any).AbortController() as AbortController;
  const options={signal:controller.signal};
  let stopDrag:()=>void=()=>{};
  const minHeight=38, maxHeight=240, minMessagesHeight=80, keyboardStep=12;
  const height=()=>Math.max(minHeight,Math.round(textarea.getBoundingClientRect().height));
  const cssMax=()=>{const value=parseFloat(view.getComputedStyle(textarea).maxHeight);return Number.isFinite(value)?Math.max(minHeight,Math.min(maxHeight,value)):maxHeight;};
  const availableMax=(current:number)=>Math.max(minHeight,Math.min(cssMax(),current+Math.max(0,messages.clientHeight-minMessagesHeight)));
  const setHeight=(next:number,limit:number,save=true)=>{
    const previous=height();
    const value=Math.round(Math.max(minHeight,Math.min(limit,next)));
    textarea.style.height=`${value}px`;
    grip.setAttribute('aria-valuemax',String(Math.round(limit)));
    grip.setAttribute('aria-valuenow',String(value));
    if(save&&value!==previous)config.onResize?.(value);
  };
  if(Number.isFinite(config.initialHeight))setHeight(config.initialHeight!,availableMax(height()),false);
  grip.setAttribute('aria-valuemax',String(Math.round(availableMax(height()))));
  grip.addEventListener('keydown',event=>{
    if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
    event.preventDefault();
    const current=height();
    setHeight(current+(event.key==='ArrowUp'?keyboardStep:-keyboardStep),availableMax(current));
  },options);
  grip.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    stopDrag();
    event.preventDefault();
    const pointerId=event.pointerId, startY=event.clientY, startHeight=height(), limit=availableMax(startHeight);
    const move=(moveEvent:PointerEvent)=>{
      if(moveEvent.pointerId===pointerId)setHeight(startHeight+startY-moveEvent.clientY,limit);
    };
    const stop=(endEvent:PointerEvent)=>{
      if(endEvent.pointerId!==pointerId)return;
      view.removeEventListener('pointermove',move);
      view.removeEventListener('pointerup',stop);
      view.removeEventListener('pointercancel',stop);
      view.removeEventListener('blur',onBlur);
    };
    const onBlur=()=>{
      view.removeEventListener('pointermove',move);
      view.removeEventListener('pointerup',stop);
      view.removeEventListener('pointercancel',stop);
      view.removeEventListener('blur',onBlur);
    };
    stopDrag=onBlur;
    view.addEventListener('pointermove',move);
    view.addEventListener('pointerup',stop);
    view.addEventListener('pointercancel',stop);
    view.addEventListener('blur',onBlur);
  },options);
  return ()=>{stopDrag();controller.abort();};
}
export function applyGeneratingState(root:ParentNode,generating:boolean):void { const button=root.querySelector<HTMLButtonElement>('[data-action="send-stop"]'); const indicator=root.querySelector<HTMLElement>('[data-generating-indicator]'); if(button){const icon=button.querySelector<HTMLElement>('[data-send-icon]'); if(icon) icon.textContent=generating?'■':'↑'; button.setAttribute('aria-label',generating?'停止':'发送');button.classList.toggle('is-generating',generating);} if(indicator) indicator.toggleAttribute('hidden',!generating); }
export function applyStudioInteractionEvent(root:ParentNode,event:string,_data:unknown={}):boolean { if(event!=='approval.requested'&&event!=='clarify.requested') return false; applyGeneratingState(root,false); const status=root.querySelector<HTMLElement>('[data-status]'); const alert=root.querySelector<HTMLElement>('[data-status-alert]'); if(status) status.textContent='需在 Hermes Studio 处理'; if(alert) alert.toggleAttribute('hidden',false); return true; }

export function isSendKey(event:ComposerKey):boolean { return event.key === 'Enter' && !event.shiftKey && !event.isComposing; }
export function mentionQueryAtCursor(value:string, cursor:number):MentionMatch|null {
  const before=value.slice(0,cursor); const match=before.match(/(?:^|\s)@([^\s【】]*)$/); if(!match) return null;
  return {query:match[1],start:cursor-match[0].length+match[0].indexOf('@'),end:cursor};
}
export function filterMentionCandidates<T extends {documentTitle:string;selectedText:string;capturedBlockKramdown:string}>(refs:T[], query:string):T[] {
  const needle=query.trim().toLocaleLowerCase(); if(!needle)return [...refs];
  return refs.filter(ref=>[ref.documentTitle,ref.selectedText,ref.capturedBlockKramdown].join('\n').toLocaleLowerCase().includes(needle));
}
export function referenceShortLabel(ref:{documentTitle:string;selectedText:string}, max=48):string {
  const source=(ref.selectedText||ref.documentTitle).replace(/\s+/g,' ').trim(); return source.length>max?`${source.slice(0,max-1)}…`:source;
}
export function referenceMarker(ref:{documentTitle:string;selectedText:string}, number:number):string { return `【引用${number}：${referenceShortLabel(ref)}】`; }
export function applyMentionSelection<T extends {documentTitle:string;selectedText:string}>(value:string,cursor:number,ref:T,number:number):{text:string;cursor:number} {
  const match=mentionQueryAtCursor(value,cursor); if(!match)return {text:value,cursor}; const marker=referenceMarker(ref,number); return {text:value.slice(0,match.start)+marker+value.slice(match.end),cursor:match.start+marker.length};
}
export function mentionKeyAction(event:ComposerKey & {index:number;count:number;open:boolean}):MentionAction {
  if(!event.open||event.isComposing)return {kind:'ignore'}; if(event.key==='Escape')return {kind:'close'};
  if(event.key==='ArrowDown')return {kind:'move',index:event.count?((event.index+1)%event.count):0};
  if(event.key==='ArrowUp')return {kind:'move',index:event.count?((event.index-1+event.count)%event.count):0};
  if(event.key==='Enter'||event.key==='Tab')return {kind:'choose',index:event.index}; return {kind:'ignore'};
}

export function clampMentionIndex(index:number,count:number):number {
  return count > 0 ? Math.max(0, Math.min(index, count - 1)) : 0;
}

export function renderMentionPickerMarkup<T extends {id:string;documentTitle:string;selectedText:string}>(refs:T[], selectedIndex:number, numbers:Map<string,number>):string {
  if(!refs.length) return '<div class="sac-mention-empty" role="status">暂无引用，请先用＋引用添加</div>';
  return refs.map((ref,index)=>`<button type="button" class="sac-mention-option" role="option" aria-selected="${index===selectedIndex}" data-mention-index="${index}" data-reference-id="${esc(ref.id)}" title="${esc(ref.documentTitle)}"><span class="sac-mention-marker">${esc(referenceMarker(ref, numbers.get(ref.id) ?? index + 1))}</span><span class="sac-mention-source">${esc(ref.documentTitle)}</span></button>`).join('');
}

const hermesMark = (className:string) => `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h3v6h7V4h3v16h-3v-7H7v7H4V4Z"></path><path d="m19 2 .7 1.6L21.5 4l-1.8.7L19 6.5l-.7-1.8L16.5 4l1.8-.4L19 2Z"></path></svg>`;

export function createChatShell():string { return `<section class="sac" role="application" aria-label="思源 AI 对话">
  <header class="sac-header">
    <div class="sac-header-primary"><div class="sac-work-menu-anchor" data-work-quick-anchor><button type="button" class="sac-work-switch" data-action="work-picker" aria-label="选择 Work" aria-haspopup="true" aria-expanded="false"><span data-work-title>选择 Work</span> ▾</button><div class="sac-work-quick-menu" data-work-quick-menu hidden></div></div><button type="button" data-work-action="home" aria-label="主页">⌂</button><button type="button" data-work-action="manage" aria-label="管理 Work">管理</button><div class="sac-task-menu-anchor" data-recent-task-anchor><button type="button" data-work-action="recent-tasks" aria-label="最近任务" aria-expanded="false">任务</button><div class="sac-task-menu" data-recent-task-menu hidden></div></div><button type="button" class="sac-icon-button" data-action="toggle-settings" aria-label="更多设置">•••</button></div>
    <nav class="sac-dock-tabs" aria-label="侧栏视图"><button type="button" data-dock-tab="chat" aria-current="page" aria-label="对话">对话</button><button type="button" data-dock-tab="associations" aria-label="文档关联">文档关联</button><button type="button" data-dock-tab="knowledge" aria-label="知识检索">检索</button></nav>
    <div class="sac-header-secondary"><label class="sac-current-chat"><span class="sac-session-kind" data-current-session-kind data-kind="hermes">AI 对话</span><select data-thread-selector aria-label="当前会话"></select></label><span class="sac-connection" data-connection title="Bridge 未配对"><span data-connection-label>未配对</span><button type="button" data-action="reconnect-hermes" aria-label="重新连接 Hermes" title="只读重连 Hermes" hidden>↻</button></span><div class="sac-chat-menu-anchor" data-chat-menu-anchor><button type="button" class="sac-icon-button" data-action="chat-actions-menu" aria-label="新增或关联会话" aria-expanded="false">＋</button><div class="sac-chat-menu" data-chat-menu hidden><button type="button" data-action="chat-menu-new" aria-label="新建并打开 Hermes 对话">新建 Hermes 对话</button><button type="button" data-action="associate-studio" aria-label="关联已有 Hermes 对话">关联 Hermes 对话</button><button type="button" data-action="associate-ekko" aria-label="关联 EKKO 房间">关联 EKKO 房间</button></div></div></div>
  </header>
  <div class="sac-status-alert" data-status-alert role="status" aria-live="polite" hidden><span data-status></span><span data-pending-chats hidden></span><button type="button" data-action="review-send" aria-label="只读核对原 Hermes 会话" hidden>读取原会话核对</button><button type="button" data-action="confirm-send-reviewed" aria-label="确认已核对此轮结果" hidden>我已核对此轮</button><button type="button" data-action="retry-connection" aria-label="重新连接 Hermes" hidden>重连</button><button type="button" data-action="open-associated-chat" aria-label="打开刚关联的对话" hidden>打开对话</button><button type="button" data-action="dismiss-status" aria-label="关闭状态提示">×</button></div>
  <section class="sac-document-panel" data-document-associations aria-label="当前文档关联" hidden></section>
  <section data-knowledge-panel aria-label="知识检索" hidden></section>
  <main data-messages data-chat-only class="sac-main" aria-live="polite"></main>
  <div data-references data-chat-only class="sac-reference-chips" hidden aria-label="引用篮子"></div>
  <form class="sac-composer" data-chat-only data-composer><div class="sac-composer-resize" data-composer-resize role="separator" aria-orientation="horizontal" aria-label="调整消息输入框高度" aria-valuemin="38" aria-valuemax="240" aria-valuenow="38" tabindex="0" title="上下拖动调整输入框高度"></div><div class="sac-mention-wrap"><textarea placeholder="输入消息…" aria-label="消息" rows="1"></textarea><div data-mention-list class="sac-mention-list" hidden role="listbox" aria-label="可用引用"></div></div><div class="sac-toolbar"><div class="sac-tools"><button type="button" class="sac-tool" data-action="add-reference" aria-label="引用当前选区"><span aria-hidden="true">＠</span><span>引用</span></button><button type="button" class="sac-tool" data-action="snapshot" aria-label="刷新当前文档上下文"><span aria-hidden="true">↻</span><span>上下文</span></button><button type="button" class="sac-tool" data-action="selection-task-draft" aria-label="从文档选区整理任务草稿">待办草稿</button></div><button type="button" class="sac-send-stop" data-action="send-stop" aria-label="发送"><span data-send-icon aria-hidden="true">↑</span><span data-generating-indicator class="sac-thinking-indicator" hidden aria-live="polite"><i></i><i></i><i></i></span></button></div></form>
  <section class="sac-ekko" data-ekko-panel aria-label="EKKO 房间" hidden></section>
</section>`; }

function esc(value:string):string { return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }

export function renderEmptyStateMarkup():string { return `<div class="sac-empty">${hermesMark('sac-empty-icon')}<h2>一起处理当前文档</h2><p>围绕正在编辑的内容，随时开始协作。</p><div class="sac-empty-capabilities"><span class="sac-empty-capability"><i aria-hidden="true">＠</i>引用选区聚焦重点</span><span class="sac-empty-capability"><i aria-hidden="true">↻</i>刷新当前有界上下文</span><span class="sac-empty-capability"><i aria-hidden="true">↗</i>延续 Hermes 对话</span></div></div>`; }

export function renderReferenceBasketMarkup(references:Reference[]):string {
  if(!references.length)return '';
  const characters=references.map(ref=>Array.from(ref.selectedText).length);
  const totalCharacters=characters.reduce((total,count)=>total+count,0);
  return `<span class="sac-reference-count">本轮引用 ${references.length} · 选区 ${totalCharacters} 字符</span>${references.map((ref,index)=>`<div class="sac-reference-chip"><details class="sac-reference-preview"><summary><span class="sac-reference-source">引用${index+1} · ${esc(ref.documentTitle || '未提供标题')}</span><span class="sac-reference-preview-hint">选区 ${characters[index]} 字符</span><span class="sac-reference-text">${esc(referenceShortLabel(ref,32))}</span></summary><div class="sac-reference-preview-content"><dl><dt>来源文档</dt><dd>${esc(ref.documentTitle || '未提供标题')}</dd><dt>文档标识</dt><dd>${esc(ref.documentRootId)}</dd><dt>块标识</dt><dd>${esc(ref.blockId)}</dd></dl><pre tabindex="0" aria-label="引用${index+1}选区原文"><code>${esc(ref.selectedText).replace(/\r/g,'&#13;')}</code></pre></div></details><button type="button" aria-label="删除引用${index+1}" data-remove-reference="${esc(ref.id)}">×</button></div>`).join('')}`;
}

export function renderMessageMarkup(message:UIMessage, doc?:Document):string {
  const role=message.role==='user'?'user':'assistant';
  const refs=message.role==='user'&&message.references.length?`<div class="sac-message-refs">${message.references.map((ref,index)=>`<span class="sac-message-ref">引用${index+1} · ${esc(ref.documentTitle)} · ${esc(referenceShortLabel(ref,36))}</span>`).join('')}</div>`:'';
  const plan=message.role==='assistant'&&message.plan?.length?'<button type="button" class="sac-plan-toggle" data-action="view-plan" aria-label="查看修改建议">查看修改建议</button>':'';
  const state=message.status==='error'?'失败':message.status==='not-sent'?'未发送':message.status==='waiting'?'等待回复':message.status==='unknown'?'结果待核对':message.status==='cancelled'||message.status==='stop-pending'?'停止待确认':'';
  const hasBody=Boolean(message.content.trim());
  const actions=role==='assistant'&&hasBody&&message.status==='complete'&&message.workflowActions?'<span class="sac-answer-actions"><button type="button" data-message-action="adopt">采纳到文档</button><button type="button" data-message-action="task-draft">整理任务</button></span>':'';
  const body=role==='assistant'&&!hasBody&&message.status==='complete'?'<p class="sac-message-state" role="status">未收到这条回复的正文，请在原 Hermes 会话核对。</p>':markdownMarkup(message.content,doc);
  return `<article class="sac-message sac-message-${role}"><div class="sac-message-author"><span class="sac-message-avatar" aria-hidden="true">${role==='user'?'你':'H'}</span><span>${role==='user'?'你':'Hermes'}</span></div><div class="sac-message-content"><div class="sac-message-body">${body}</div>${refs}${plan}${role==='assistant'&&hasBody?'<button type="button" class="sac-copy-reply" data-copy-reply>复制回复</button>':''}${actions}</div>${state?`<small class="sac-message-state" role="status">${state}</small>`:''}</article>`;
}
