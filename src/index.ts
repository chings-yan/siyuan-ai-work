import pluginManifest from '../plugin.json';
import { workStatusLabels, workStatusDescriptions } from './work/status-ui.ts';
import { documentLinkConfirmation } from './work/document-link.ts';
import { STUDIO_PARTIAL_READ_NOTICE,BridgeInspectionError,inspectLocalBridge,detectLocalBridge,EkkoSettingsConnection,validatedConnections,validConnectionId,connectionLabel,connectionAdvice,type BridgeInspection,type BridgeSettingsInput } from './work/connection-settings.ts';
import { bindDismissibleMenu } from './work/dismissible-menu.ts';
import { SettingsDialog } from './work/settings-dialog.ts';
import { WorkQuickPicker } from './work/quick-picker.ts';
import { WorkGoalForm } from './work/goal-form.ts';
import { WorkCreateForm, WORK_CREATE_CSS } from './work/create-form.ts';
import { WorkCreator } from './work/create.ts';
import { WorkNativeTab } from './work/native-tab.ts';
import { WorkPage, WORK_PAGE_CSS, type WorkPageContext, type WorkPageRoute } from './work/page.ts';
import { WorkCatalog } from './work/catalog.ts';
import { SessionMemory, sessionChoices, sessionKey, sessionLabel, sessionDetails, stableChatTitle, type SessionChoice, type SessionChat, type HermesDraft } from './work/sessions.ts';
import { TaskDialog } from './task/dialog.ts';
import { NativeTaskAdapter } from './task/native.ts';
import type { RoomDraft } from './ekko/ui.ts';
import { MessageRenderer } from './message-renderer.ts';
import { Plugin, getAllEditor, openTab } from 'siyuan';
import { buildSnapshot, parseKramdownResponse, isValidDocumentRootId, type Snapshot } from './core.ts';
import { extractEditorContext, enrichEditorContext, selectActiveEditor, readEditorDocumentTitle } from './editor-context.ts';
import { streamThreadChat } from './provider.ts';
import { DEFAULT_BRIDGE_URL, checkedBridgeUrl, BridgeError, validatedStudioReadWarning, createBridgeClient, bridgeMessagesToChat, readThreadMessages, resolveBridgeUrl, type ConnectionView, type ChatView } from './bridge.ts';
import { CSS } from './styles.ts';
import { ReferenceBasket } from './references.ts';
import { appendAssistantTurn, appendUserTurn, upsertAssistantTurn, newThread, switchThread, type ChatThread } from './chat.ts';
import { applyGeneratingState, applyMentionSelection, bindComposerResize, clampMentionIndex, createChatShell, filterMentionCandidates, isSendKey, mentionKeyAction, mentionQueryAtCursor, prepareOutgoingMessage, renderChatConnection, renderConnectionChoices, renderEmptyStateMarkup, renderMentionPickerMarkup, renderMessageMarkup, renderReferenceBasketMarkup } from './ui.ts';
import { mountStudioPicker, renderStudioSessionOptions } from './studio-picker.ts';
import { connectionFailureMessage, connectionStatus } from './status.ts';
import { ReconnectController } from './reconnect.ts';
import { WorkStore, type ChatLink, type ContextRef } from './work/store.ts';
import { WorkService } from './work/service.ts';
import { SiYuanWorkHost } from './work/siyuan-host.ts';
import { WorkController, WORK_CSS, type ContextChoice } from './work/controller.ts';
import { buildContextPayload, refreshSelection, freezeRequest } from './work/context.ts';
import { parseProposal } from './work/proposal.ts';
import { NativeTaskReader } from './task/reader.ts';
import { applyApprovedProposal, WriteFailure, type FrozenProposal } from './work/write.ts';

import { RoomLinkStore } from './work/room-store.ts';
import { EkkoBridgeClient } from './ekko/bridge.ts';
import { EkkoRoomUI, type RoomSourceOption } from './ekko/ui.ts';
import type { SelectedRoomSource } from './ekko/context.ts';
import { PendingRoomSendStore } from './ekko/pending.ts';

declare const window:any;
export default class SiyuanAICollab extends Plugin {
 private dock:any; private floatingPanel?:HTMLElement; private styleElement?:HTMLStyleElement; private snapshot:Snapshot|null=null; private pendingProposal:FrozenProposal|null=null; private proposalNeedsReview=false; private recentBlockIds:string[]=[]; private observer?:MutationObserver; private bridgeUrl=DEFAULT_BRIDGE_URL; private bridgeToken=''; private connectionText='Bridge 未配对'; private connectionOk=false; private connectionViews:ConnectionView[]=[]; private selectedConnectionId='serve-local'; private confirmedConnectionId?:string; private workLoadSeq=0; private newChatInFlight=false; private associationOpen=false; private associationRoot?:HTMLElement; private associationOverlay?:HTMLElement; private associationGeneration=0; private activeBindingKeys=new Set<string>(); private references=new ReferenceBasket(); private quoteSeq=0; private threads:ChatThread[]=[]; private activeThreadId=''; private pendingPinsByThread=new Map<string,ContextRef[]>(); private abortController?:AbortController; private sendInFlight=false; private activeRunPhase:'preparing'|'submitting'|null=null; private preSubmitCancelled=false; private activeRunChatId=''; private activeRunBridge?:{chatId:string;documentRootId:string;bridgeUrl:string;capabilityToken:string}; private mentionIndex=0; private mentionOpen=false; private reconnectController?:ReconnectController;
 private readonly sessionMemory = new SessionMemory();
 private chatScopePreparationVersion=0;
 private disposed=false; private preparing=false; private accepting=false; private historyVersion=0; private snapshotVersion=0; private chatReadStatus?:{chatId:string;connection:string;ready:boolean};
  private historyFailure:{workId:string|null;connection:string;chatId:string;documentRootId:string}|null=null;
 private readonly viewCleanup=new Map<HTMLElement,()=>void>();
 private readonly roomDrafts = new Map<string, RoomDraft>();
 private activeDraft?: HermesDraft;
 private closeRoomAssociation?:()=>void;
 private threadWorkId = ''; private threadConnection = ''; private workLoadVersion=0; private newChatBusy=false;
 private readonly sessionRows = new WeakMap<HTMLElement, SessionChoice[]>();
 private readonly sessionVersions = new WeakMap<HTMLElement, number>();
 private readonly statusRetry = new WeakMap<HTMLElement, () => Promise<void>>();
 private readonly operationNotices=new WeakMap<HTMLElement,string>();
 private readonly surfaces=new WeakMap<HTMLElement,string>();
 private readonly workStore = new WorkStore({ loadData: key => this.loadData(key), saveData: (key, value) => this.saveData(key, value) });
 private readonly roomStore = new RoomLinkStore({ loadData: key => this.loadData(key), saveData: (key, value) => this.saveData(key, value) }, () => this.workStore.listWorks());
 private readonly pendingRoomSendStore = new PendingRoomSendStore({ loadData: key => this.loadData(key), saveData: (key, value) => this.saveData(key, value) });
 private readonly roomViews = new Map<HTMLElement, EkkoRoomUI>();
 private readonly workHost = new SiYuanWorkHost((path, body) => this.api(path, body));
 private readonly workService = new WorkService(this.workHost, this.workStore);
 private readonly taskReader = new NativeTaskReader();
 private readonly nativeTaskAdapter = new NativeTaskAdapter(this.app,{getAllEditor});
 private readonly taskDialog = new TaskDialog(document,{native:this.nativeTaskAdapter,reader:this.taskReader,controller:{checkSelectableTask:(taskId,workId)=>this.workController.checkSelectableTask(taskId,workId),linkSelectedTask:(workId,task,current)=>this.workController.linkSelectedTask(workId,task,current)},documentTitle:id=>this.workHost.getDocumentTitle(id),readWork:id=>this.workService.readWork(id),listWorks:async()=>Promise.all((await this.workStore.listWorks()).map(async id=>({id,title:await this.workHost.getDocumentTitle(id)})))});
 private readonly workCreator = new WorkCreator(this.workHost,this.workStore,this.workService,this.taskReader);
 private readonly workCreateForm = new WorkCreateForm(this.workCreator,async id=>{await this.workController.enterWork(id);this.showChatDock();},()=>this.readWorkNotebookSetting(),async id=>{if(!(await this.workHost.getDocumentPath(id)))throw new Error('问题文档不存在或暂不可读取');await openTab({app:this.app,doc:{id}});});
  private readonly workGoalForm = new WorkGoalForm(this.workCreator,async()=>{this.workTab?.refresh();});
 private workTab?: WorkNativeTab;
 private settingsDialog?: SettingsDialog;
 private settingsSaving=false;
 private lastSettingsInspection:BridgeInspection|null=null;
 private lastSettingsSaveOutcome:BridgeInspection['saveOutcome'];
 private settingsReportVersion=0;
 private lastSettingsReportVersion=0;
 private lastVerifiedSettingsWriteVersion=0;
 private roomConnectionVersion=0;
 private readonly ekkoSettings=new EkkoSettingsConnection(()=>({bridgeUrl:this.bridgeUrl,capabilityToken:this.bridgeToken}),()=>this.disposed||this.chatBusy()||Boolean(this.pendingProposal)||[...this.roomViews.values()].some(view=>view.isSending),()=>{this.roomConnectionVersion++;if(!this.disposed)this.roomViews.forEach(view=>view.connectionChanged());});
 private defaultWorkNotebookId='';
 private readonly quickPickers=new Map<HTMLElement,WorkQuickPicker>();
 private readonly workCatalog = new WorkCatalog({store:{listWorks:()=>this.workStore.listWorks(),getResume:id=>this.workStore.getResume(id),listTasks:id=>this.workStore.listTasks(id),listChats:id=>this.listSessionChats(id)},rooms:this.roomStore,host:this.workHost,service:this.workService,taskReader:this.taskReader});
 private readonly workController: WorkController = new WorkController({ host: this.workHost, store: this.workStore, service: this.workService, taskReader: this.taskReader,
   currentDocumentId: () => this.currentDocumentId(), currentFocusBlockId: () => this.currentFocusBlockId(), currentChatId: () => this.activeThreadId || null,
   currentConnection:()=>this.connectionIdentity(),
   currentChat: (): { title: string; linked: boolean } | null => { const active=this.threads.find(thread=>thread.id===this.activeThreadId); return active ? { title:active.title||'当前对话', linked:Boolean(active.connectionId) } : null; },
   onCreateTask:async(workId,documentId,current)=>this.openTaskDialog(workId||undefined,documentId?{documentId,title:'',focusBlockId:null}:null,current),
   onLinkTask:async(workId,current)=>this.openTaskDialog(workId,null,current,'link'),
   onOpenPage: route => { void this.openWorkPage(route); },
   onBeginCreate: async id => { await this.workCreateForm.open(id?{documentId:id,title:await this.workHost.getDocumentTitle(id)}:null,'current'); },
   onContextChanged: choice => {if(this.activeDraft)this.activeDraft.context=choice;},
   isBusy: () => this.chatBusy(), hasPendingWrite: () => Boolean(this.pendingProposal),
   canBrowseDocuments: () => this.activeRunPhase==='submitting' && Boolean(this.abortController) && !this.preparing && !this.accepting && !this.settingsSaving,
   openDocument: (id, focus) => openTab({ app: this.app, doc: { id: focus || id, action: focus ? ['cb-get-focus'] : [] } }),
   onWorkChanged: async id => { await this.onWorkChanged(id); await Promise.all([...this.roomViews.values()].map(view => view.workChanged())); }, onLinkCurrentChat: () => this.linkCurrentChat(), status: message => document.querySelectorAll<HTMLElement>('.sac').forEach(root => this.setStatus(root, message)) });
 private readonly onProtyleSwitch = () => { void this.workController.refreshFromEditor().then(() => this.roomViews.forEach(view => void view.documentChanged())); };
 private readonly onEditorActivity = (event: Event) => { if ((event.target as Element)?.closest?.('.protyle')) this.workController.noteFocus(); };
 onload(){ this.workTab=new WorkNativeTab(this,openTab,(element,context)=>this.mountWorkPage(element,context)); this.addIcons('<symbol id="iconSiyuanAICollab" viewBox="0 0 32 32"><path d="M6 5h4v9h12V5h4v22h-4v-9H10v9H6V5Z"/><path d="m27 1 1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/></symbol>'); const style=document.createElement('style');style.textContent=CSS+'\n'+WORK_CSS+'\n'+WORK_PAGE_CSS+'\n'+WORK_CREATE_CSS;document.head.appendChild(style);this.styleElement=style; const plugin=this; this.reconnectController=new ReconnectController({hasToken:()=>Boolean(plugin.bridgeToken),refresh:()=>plugin.syncHermesSessions(),onFailure:error=>plugin.updateConnectionUI(false,error),onSuccess:()=>plugin.updateConnectionUI(true)}); this.dock=this.addDock({config:{position:'RightTop',size:{width:360,height:360},title:'思源 AI 即时协作',icon:'iconSiyuanAICollab'},data:{},type:'siyuan-ai-collab',init:function(this:any){plugin.render(this.element);},destroy:function(this:any){plugin.disposeRoomView(this.element);}}); void this.restoreConnectionSettings().catch(error=>plugin.updateConnectionUI(false,error)); this.observer=new MutationObserver(m=>{for(const x of m){const b=(x.target as Element).closest?.('[data-node-id]');const id=b?.getAttribute('data-node-id');if(id)this.recentBlockIds=[id,...this.recentBlockIds.filter(v=>v!==id)].slice(0,20);}});this.observer.observe(document.body,{subtree:true,childList:true,characterData:true});this.eventBus.on('switch-protyle',this.onProtyleSwitch);document.addEventListener('pointerup',this.onEditorActivity,true);document.addEventListener('keyup',this.onEditorActivity,true);window.setTimeout(()=>{if(!this.disposed)void this.workController.refreshFromEditor();},0); }
 onLayoutReady(){this.addTopBar({icon:'iconSiyuanAICollab',title:'思源 AI Work',position:'right',callback:()=>{void this.openWorkPage({kind:'home'});}});}
  onunload(){this.disposed=true;this.settingsDialog?.dispose();++this.workLoadVersion;++this.historyVersion;this.closeAssociation();this.closeRoomAssociation?.();this.workCreateForm.dispose();this.workGoalForm.dispose();this.taskDialog.dispose();this.workTab?.dispose();this.workTab=undefined;this.reconnectController?.unload();this.observer?.disconnect();this.styleElement?.remove();this.eventBus.off('switch-protyle',this.onProtyleSwitch);document.removeEventListener('pointerup',this.onEditorActivity,true);document.removeEventListener('keyup',this.onEditorActivity,true);void this.workController.flushResume().catch(()=>undefined);this.workController.detach();for(const root of [...this.roomViews.keys()])this.disposeRoomView(root);this.floatingPanel?.remove();this.references.clear();this.threads=[];this.dock=undefined;}
 private toggleFloatingPanel(){const existing=document.getElementById('siyuan-ai-collab-panel');if(existing){this.disposeRoomView(existing);existing.remove();this.floatingPanel=undefined;return;}const panel=document.createElement('aside');panel.id='siyuan-ai-collab-panel';panel.className='sac-floating';document.body.appendChild(panel);this.floatingPanel=panel;this.render(panel);}
 private bridgeClient(documentRootId:string){return createBridgeClient({bridgeUrl:this.bridgeUrl,capabilityToken:this.bridgeToken},documentRootId);}
 private threadFromLink(link:ChatLink,previous?:ChatThread):ChatThread{return {id:link.chatId,storedSessionId:link.storedSessionId||undefined,hermesSessionId:link.state==='ready'?link.storedSessionId||undefined:undefined,adapter:link.adapter,state:link.state,profile:link.profile,installId:link.installId||undefined,legacyBridgeUrl:link.legacyBridgeUrl,documentRootId:link.documentRootId,connectionId:link.connectionId,title:link.title,messages:previous?.messages||[],createdAt:previous?.createdAt||new Date().toISOString()};}
 private chatLinkFromView(chat:ChatView,workId:string|null):ChatLink{
  if(!['serve','studio','legacy-api'].includes(chat.kind)||!['creating','pending','ready','unknown'].includes(chat.state)||!chat.chatId||!chat.connectionId||!chat.profile||!chat.documentRootId)throw new Error('Bridge Chat 响应不完整，不能保存正式关系');
  return {chatId:chat.chatId,workId,documentRootId:chat.documentRootId,connectionId:chat.connectionId,adapter:chat.kind,profile:chat.profile,storedSessionId:chat.storedSessionId,installId:chat.installId,title:chat.title,state:chat.state as ChatLink['state']};
 }
  private renderConnectionChoices(root:HTMLElement){const choice=root.querySelector<HTMLSelectElement>('[data-connection-choice]');if(choice){choice.innerHTML=renderConnectionChoices(this.connectionViews,this.selectedConnectionId);choice.value=this.selectedConnectionId;}const disabled=this.newChatInFlight||this.selectedConnection()?.kind==='legacy-api';root.querySelectorAll<HTMLButtonElement>('[data-action="new-thread"],[data-action="chat-menu-new"]').forEach(button=>button.disabled=disabled);}
 private selectedConnection(){return this.connectionViews.find(view=>view.id===this.selectedConnectionId);}
 private checkSelectedConnection(){if(!this.confirmedConnectionId||this.confirmedConnectionId!==this.selectedConnectionId)throw Error('请先在 Hermes 设置中选择服务并检测连接，再新建或关联');const connection=this.selectedConnection();if(!connection)throw new Error('所选 Hermes 连接不可用，请刷新连接');if(connection.kind!=='legacy-api'&&connection.state!=='ready')throw new Error('Hermes 服务未连接，请检查服务或显式选择其他连接');if(connection.state==='offline'||connection.state==='auth_missing'||connection.state==='auth_failed'||connection.state==='incompatible'||connection.state==='install_changed'||connection.state==='install_mismatch')throw new Error('所选 Hermes 连接不可用，请核对后重试');return connection;}
  private setChatMenuOpen(root:HTMLElement,open:boolean){const menu=root.querySelector<HTMLElement>('[data-chat-menu]'),button=root.querySelector<HTMLButtonElement>('[data-action="chat-actions-menu"]');if(!menu||!button)return;const next=open&&!this.associationOpen;menu.hidden=!next;button.setAttribute('aria-expanded',String(next));if(next)menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();}
  private setAssociationOpen(root:HTMLElement,open:boolean){this.associationOpen=open;if(open){this.associationRoot=root;this.setChatMenuOpen(root,false);}else if(this.associationRoot===root)this.associationRoot=undefined;document.querySelectorAll<HTMLButtonElement>('.sac [data-action="associate-studio"],.sac [data-action="chat-actions-menu"]').forEach(button=>button.disabled=open);}
 private invalidateAssociationFor(root?:HTMLElement){if(!root||this.associationRoot!==root)return;this.associationGeneration++;this.associationOverlay?.remove();this.associationOverlay=undefined;this.setAssociationOpen(root,false);}
 private async priorUnknownCandidate(workId:string|null,documentRootId:string,connectionId:string,storedSessionId:string):Promise<{chatId:string;state:string}|null>{
  const links=workId?await this.workStore.listChats(workId):await this.workStore.listDocumentChats(documentRootId);
  const formal=links.find(link=>link.documentRootId===documentRootId&&link.connectionId===connectionId&&link.storedSessionId===storedSessionId);
  if(formal)return {chatId:formal.chatId,state:formal.state};
  const pending=await this.workStore.listPending();
  const markers=[`connectionId=${connectionId}`,`documentRootId=${documentRootId}`,`storedSessionId=${storedSessionId}`];
  const unresolved=pending.find(item=>item.kind==='chat'&&item.workId===workId&&item.state==='unknown'&&markers.every(marker=>item.details.split(/\s+/).includes(marker)));
  return unresolved?{chatId:unresolved.id.replace(/^chat:/,''),state:'unknown'}:null;
 }
  private async preserveUnstoredChat(root:HTMLElement,link:ChatLink,operation:string,showUi=true,activate=true):Promise<void>{
  const originScope=this.chatScopeKey(),originDocument=this.currentDocumentId(),originConnection=this.connectionIdentity(),originGeneration=this.workLoadSeq,originNavigation=this.workController.navigationVersion,originView=this.viewCleanup.get(root);
  const current=()=>showUi&&!this.disposed&&root.isConnected&&this.chatScopeKey()===originScope&&this.currentDocumentId()===originDocument&&this.connectionIdentity()===originConnection&&this.workLoadSeq===originGeneration&&this.workController.navigationVersion===originNavigation&&this.viewCleanup.get(root)===originView;
  const evidence=`${operation} 回执后本地正式关系保存失败；chatId=${link.chatId} connectionId=${link.connectionId} documentRootId=${link.documentRootId}${link.storedSessionId?` storedSessionId=${link.storedSessionId}`:''}`;
  let pendingSaved=false;
  try{await this.workStore.setPending({id:`chat:${link.chatId}`,kind:'chat',workId:link.workId,state:'unknown',details:evidence,updatedAt:new Date().toISOString()});pendingSaved=true;}catch{/* 显示 ID 供人工核对，不能重试外部写入 */}
   if(current()&&this.chatScopeCurrent(link.workId,link.documentRootId)){if(activate)this.saveDraft(root);const unknown={...link,state:'unknown' as const};this.threads=[...this.threads.filter(thread=>thread.id!==link.chatId),this.threadFromLink(unknown)];if(activate){this.activeThreadId=link.chatId;this.activateDraft();this.rememberThreads();}document.querySelectorAll<HTMLElement>('.sac').forEach(panel=>{this.renderThreads(panel);if(activate)this.renderMessages(panel);});}
  if(current())this.setStatus(root,`${operation} 已获 Bridge 回执，但本地关系保存失败；Chat ID：${link.chatId}${pendingSaved?'，已记录未决事项':'，未决事项也未保存'}。请核对后处理，勿重复请求。`);
 }
 private async linkCurrentChat():Promise<void>{
  const workId=this.workController.currentWorkId;
  const thread=this.ensureThread();
  if(!workId||!thread)throw new Error('请先选择 Work 和 Chat');
  if(thread.adapter==='unresolved')throw new Error('请先新建或关联 Hermes Chat，不能把待确认来源的本地占位对话写成正式关系');
  await this.workStore.linkChat({chatId:thread.id,workId,documentRootId:thread.documentRootId,connectionId:thread.connectionId!,adapter:thread.adapter,profile:thread.profile,storedSessionId:thread.storedSessionId||null,installId:thread.installId||null,title:thread.title,state:thread.state});
  this.workController.noteChat();
  document.querySelectorAll<HTMLElement>('.sac').forEach(root=>this.setStatus(root,'当前 Chat 已关联 Work'));
 }
 private async startNewChat(root:HTMLElement):Promise<void>{
  if(this.newChatInFlight)return;
  this.newChatInFlight=true;this.renderConnectionChoices(root);document.querySelectorAll<HTMLElement>('.sac').forEach(panel=>this.renderConnectionChoices(panel));
  try{await this.startNewChatOnce(root);}finally{this.newChatInFlight=false;this.renderConnectionChoices(root);document.querySelectorAll<HTMLElement>('.sac').forEach(panel=>this.renderConnectionChoices(panel));}
 }
 private async startNewChatOnce(root:HTMLElement):Promise<void>{
  const documentRootId=this.currentDocumentId();
  if(!documentRootId){this.setStatus(root,'请先打开一个思源文档');return;}
  if(this.chatBusy()||this.pendingProposal||this.workController.isTransitioning){this.setStatus(root,'请先处理正在生成或待接受的建议');return;}
  const preparation=this.prepareChatOperation(root,documentRootId);
  let workId:string|null;
  try{workId=await preparation.scope;}catch(error){if(preparation.isCurrent())this.setScopePreparationStatus(root,error instanceof Error?error.message:String(error));return;}
  if(!preparation.isCurrent())return;
  let connection:ConnectionView;
  try{connection=this.checkSelectedConnection();}catch(error){this.setStatus(root,error instanceof Error?error.message:String(error));return;}
  if(connection.kind==='legacy-api'){this.setStatus(root,'旧 API 连接只能关联已有会话，不能新建 Chat');return;}
  const originConnection=this.connectionIdentity(),originGeneration=this.workLoadSeq,originNavigation=this.workController.navigationVersion,originView=this.viewCleanup.get(root);
  const isCurrent=()=>this.chatScopeCurrent(workId,documentRootId)&&root.isConnected&&originConnection===this.connectionIdentity()&&originGeneration===this.workLoadSeq&&originNavigation===this.workController.navigationVersion&&originView===this.viewCleanup.get(root);
  try{
   const links=workId?await this.workStore.listChats(workId):await this.workStore.listDocumentChats(documentRootId);
   const pending=await this.workStore.listPending();
   const unknown=links.find(link=>link.connectionId===connection.id&&link.documentRootId===documentRootId&&link.state==='unknown');
   const unresolved=pending.find(item=>item.kind==='chat'&&item.workId===workId&&item.id.startsWith('chat:')&&item.details.split(/\s+/).includes(`connectionId=${connection.id}`)&&item.details.split(/\s+/).includes(`documentRootId=${documentRootId}`));
   if(unknown||unresolved){if(isCurrent())this.setStatus(root,`已有未决新建 Chat ID：${unknown?.chatId||unresolved!.id.slice(5)}，请先核对结果，不能重复新建。`);return;}
  }catch(error){if(isCurrent())this.setStatus(root,`正式关系或未决记录无法读取，已停止新建：${error instanceof Error?error.message:String(error)}`);return;}
  if(!isCurrent())return;
  const old=this.ensureThread();
  let oldPins:ContextRef[]=[];
  try{if(old)oldPins=await this.workStore.getPins(old.id);}catch(error){if(isCurrent())this.setStatus(root,`旧 Chat 固定资料无法读取，已停止新建：${error instanceof Error?error.message:String(error)}`);return;}
  if(!isCurrent())return;
  const carryPins=oldPins.length>0&&window.confirm(`旧 Chat 有 ${oldPins.length} 项固定资料。新 Chat 是否沿用？`);
  let handoff='';
  if(old?.state==='ready'&&old.storedSessionId&&window.confirm('是否让旧 Hermes Chat 生成简短接力信息？这会额外调用一次模型，结果可查看和编辑。')){
   try{
    if(!this.snapshot||this.snapshot.documentId!==old.documentRootId)throw new Error('旧 Chat 缺少当前文档快照');
    const result=await streamThreadChat(old,'请为用户即将新建的对话生成 100–300 汉字的接力信息，只说明尚未写入文档但对继续讨论有用的事项；不要声称已修改正文。',this.snapshot,{bridgeUrl:this.bridgeUrl,capabilityToken:this.bridgeToken,documentRootId:old.documentRootId,references:[]},()=>{});
    if(!isCurrent())return;
    if(result.state!=='complete')throw new Error('接力信息结果未确认');
    handoff=window.prompt('检查并编辑接力信息；清空可取消携带',result.text)?.trim()||'';
   }catch(error){if(isCurrent())this.setStatus(root,`旧 Chat 暂不可用，新 Chat 将不继承讨论：${error instanceof Error?error.message:String(error)}`);}
  }
  if(!isCurrent()||this.chatBusy()||this.pendingProposal)return;
  const local=newThread(documentRootId,'新对话');
  let responseSeen=false;
  let acceptedLink:ChatLink|undefined,formalSaved=false;
  try{
   const {chat}=await this.bridgeClient(documentRootId).createChat(local.id,connection.id,local.title);
   responseSeen=true;
   if(chat.chatId!==local.id||chat.documentRootId!==documentRootId||chat.connectionId!==connection.id||chat.kind!==connection.kind||chat.profile!==connection.profile||chat.installId!==connection.installId)throw new Error('Bridge Chat 绑定与请求不符；请核对');
   const link=this.chatLinkFromView(chat,workId);acceptedLink=link;await this.workStore.linkChat(link);formalSaved=true;
   let pinsError:unknown;
   if(carryPins)try{await this.workStore.setPins(link.chatId,oldPins.map(x=>({...x})));}catch(error){pinsError=error;}
   if(!isCurrent()){return;}
   this.saveDraft(root);const thread=this.threadFromLink(link);this.threads.push(thread);this.activeThreadId=thread.id;this.activateDraft();this.rememberThreads();
   this.workController.noteChat();this.renderThreads(root);this.renderMessages(root);
   if(pinsError)this.setStatus(root,`新 Chat 已保存，但固定资料沿用失败：${pinsError instanceof Error?pinsError.message:String(pinsError)}`);
   if(handoff){const textarea=root.querySelector<HTMLTextAreaElement>('textarea');if(textarea){textarea.value=`【用户确认的接力信息】\n${handoff}\n\n`;textarea.dispatchEvent(new Event('input',{bubbles:true}));}}
  }catch(error){
   if(acceptedLink&&!formalSaved){await this.preserveUnstoredChat(root,acceptedLink,'新建 Chat',isCurrent());return;}
   if(responseSeen||!(error instanceof BridgeError)||error.status>=500){
    const unknown:ChatLink={chatId:local.id,workId,documentRootId,connectionId:connection.id,adapter:connection.kind,profile:connection.profile,storedSessionId:null,installId:connection.installId,title:local.title,state:'unknown'};
    try{await this.workStore.linkChat(unknown);if(isCurrent()){this.saveDraft(root);this.threads.push(this.threadFromLink(unknown));this.activeThreadId=unknown.chatId;this.activateDraft();this.rememberThreads();this.renderThreads(root);this.renderMessages(root);}}
    catch{await this.preserveUnstoredChat(root,unknown,'新建 Chat',isCurrent());return;}
   }
   if(isCurrent())this.setStatus(root,`新 Chat ${local.id} 结果待核对：${error instanceof Error?error.message:String(error)}；请勿重复点击新建。`);
  }
 }
  private async selectChat(root:HTMLElement,chatId:string,connectionId?:string):Promise<void>{
   if(this.chatBusy()||this.pendingProposal||this.workController.isTransitioning){this.setStatus(root,'请先处理当前生成、导航或修改建议');return;}
   const selected=this.threads.find(thread=>thread.id===chatId&&(!connectionId||thread.connectionId===connectionId));
   if(!selected){this.setStatus(root,'所选对话不属于当前 Work，请重新选择');return;}
   this.saveDraft(root);++this.historyVersion;this.roomViews.get(root)?.leave();this.activeThreadId=chatId;this.activateDraft();await this.restoreDurableNotice();this.rememberThreads();this.workController.noteChat();
   document.querySelectorAll<HTMLElement>('.sac').forEach(panel=>{this.renderThreads(panel);this.renderMessages(panel);});
   if(selected.adapter==='unresolved'||selected.state!=='ready'){this.setStatus(root,'对话来源或创建结果仍待确认，暂不能读取历史');return;}
   const generation=this.workLoadSeq;
   try{if(await this.loadThreadMessages(selected,generation)===false)return;if(this.activeThreadId===chatId&&generation===this.workLoadSeq){document.querySelectorAll<HTMLElement>('.sac').forEach(panel=>this.renderMessages(panel));this.setStatus(root,'Hermes · 已连接');}}
   catch(error){if(this.activeThreadId===chatId&&generation===this.workLoadSeq)this.setStatus(root,`Chat 历史暂不可读取：${error instanceof Error?error.message:String(error)}`);}
  }
 private async onWorkChanged(workId:string|null,isCurrent:()=>boolean=()=>true,onSelected?:(chatId:string)=>void):Promise<void>{
  if(!isCurrent())return;
  for(const root of this.roomViews.keys())this.saveDraft(root);this.rememberThreads();
  const generation=++this.workLoadSeq,connection=this.connectionIdentity();++this.historyVersion;
  const documentId=this.workController.activeDocumentId||this.currentDocumentId(),scopeId=this.chatScopeKey(workId,documentId);
  const scope=this.sessionMemory.scope(scopeId,connection);
  const currentScope=()=>isCurrent()&&!this.disposed&&connection===this.connectionIdentity()&&generation===this.workLoadSeq&&this.workController.currentWorkId===workId&&(workId!==null||this.workController.activeDocumentId===documentId);
  document.querySelectorAll<HTMLElement>('.sac').forEach(root=>{this.renderPendingChatNotice(root,'');this.setStatus(root,'');});
  const links=workId?await this.workStore.listChats(workId):await this.workStore.listDocumentChats(documentId);
  if(!currentScope())return;
  if(!links.length){const doc=documentId||workId!;const fresh=scope.threads[0]||newThread(doc,'新对话');this.threads=[fresh];this.activeThreadId=fresh.id;}
  else{
   const previous=new Map(scope.threads.map(thread=>[thread.id,thread]));
   this.threads=links.map(link=>this.threadFromLink(link,previous.get(link.chatId)));
   const resume=workId?await this.workStore.getResume(workId):null;
   if(!currentScope())return;
   const desired=scope.selected||resume?.chatId;this.activeThreadId=this.threads.some(thread=>thread.id===desired)?desired!:this.threads[0].id;
  }
  onSelected?.(this.activeThreadId);
  document.querySelectorAll<HTMLElement>('.sac').forEach(root=>{this.renderThreads(root);this.renderMessages(root);});
  this.threadWorkId=scopeId;this.threadConnection=connection;this.activateDraft();await this.restoreDurableNotice(currentScope);if(!currentScope())return;this.rememberThreads();
  for(const link of links.filter(item=>item.state==='source-unknown')){
   if(!currentScope())return;
   const sourceBridgeUrl=link.legacyBridgeUrl||link.connectionId;
   try{
    const client=createBridgeClient({bridgeUrl:sourceBridgeUrl,capabilityToken:this.bridgeToken},link.documentRootId);
    const classification=(await client.legacyBindings()).data.find(item=>item.chatId===link.chatId&&item.documentRootId===link.documentRootId&&item.storedSessionId===link.legacyCandidateId);
    if(!classification||!currentScope())continue;
    const previous=scope.threads.find(thread=>thread.id===link.chatId);
    const draft=previous?this.sessionMemory.draft(scopeId,this.draftIdentity(previous,connection),link.chatId):undefined;
    await this.workStore.resolveLegacyChat(link.chatId,classification,sourceBridgeUrl);
    const resolved=await this.workStore.chatLink(link.chatId);
    if(resolved){
     const current=currentScope();
     const selected=current&&this.activeThreadId===link.chatId;
     if(selected)for(const root of this.roomViews.keys())this.saveDraft(root);
     const updated=this.threadFromLink(resolved,scope.threads.find(thread=>thread.id===link.chatId)||previous);
     // A committed identity migration belongs to its original private scope even after navigation.
     if(draft)Object.assign(this.sessionMemory.draft(scopeId,this.draftIdentity(updated,connection),link.chatId),draft);
     scope.threads=scope.threads.map(thread=>thread.id===link.chatId?updated:thread);
     if(current){this.threads=scope.threads;if(selected)this.activateDraft();this.rememberThreads();document.querySelectorAll<HTMLElement>('.sac').forEach(root=>this.renderThreads(root));}
    }
   }catch(error){if(currentScope()&&this.activeThreadId===link.chatId)document.querySelectorAll<HTMLElement>('.sac').forEach(root=>this.setStatus(root,`旧 Chat 来源仍待确认：${error instanceof Error?error.message:String(error)}`));}
  }
  if(!currentScope())return;
  const active=this.threads.find(thread=>thread.id===this.activeThreadId);
  let historyIssue='';
  if(active&&active.adapter!=='unresolved')try{await this.loadThreadMessages(active,generation,currentScope);}catch(error){historyIssue=`Chat 历史暂不可读取：${error instanceof Error?error.message:String(error)}`;}
  if(currentScope()){
   document.querySelectorAll<HTMLElement>('.sac').forEach(root=>this.renderMessages(root));
   try{
    const pending=(await this.workStore.listPending()).filter(item=>item.kind==='chat'&&item.workId===workId&&item.state==='unknown'&&(workId!==null||links.some(link=>item.id===`chat:${link.chatId}`||item.id===`chat-run:${link.chatId}`)||item.details.split(/\s+/).includes(`documentRootId=${documentId}`)));
    if(currentScope()){const ids=pending.map(item=>item.id.replace(/^chat:/,'')).join('、');const issue=pending.length?`Chat ID ${ids} 有未决关系，请人工核对；未自动关联或重发。`:'';document.querySelectorAll<HTMLElement>('.sac').forEach(root=>{this.renderPendingChatNotice(root,issue);if(historyIssue)this.setStatus(root,historyIssue);});}
   }catch(error){if(currentScope())document.querySelectorAll<HTMLElement>('.sac').forEach(root=>{this.renderPendingChatNotice(root,`未决 Chat 记录读取失败；正式 Chat 仍可查看：${error instanceof Error?error.message:String(error)}`);if(historyIssue)this.setStatus(root,historyIssue);});}
  }
 }
 private async associateStudio(root:HTMLElement,targetWorkId?:string,pageCurrent:()=>boolean=()=>true){
  if(this.associationOpen)return;
  const documentRootId=targetWorkId||this.currentDocumentId();
  const preparation=this.prepareChatOperation(root,documentRootId,targetWorkId,pageCurrent);
  let workId:string|null;
  try{workId=await preparation.scope;}catch(error){if(preparation.isCurrent())this.setScopePreparationStatus(root,error instanceof Error?error.message:String(error));return;}
  if(!preparation.isCurrent())return;
  const originWorkId=this.workController.currentWorkId,originDocumentId=this.currentDocumentId(),bridgeUrl=this.bridgeUrl,bridgeToken=this.bridgeToken;
  if(!isValidDocumentRootId(documentRootId)){this.setStatus(root,'请先打开一个思源文档');return;}
  let connection:ConnectionView;
  try{connection=this.checkSelectedConnection();}catch(error){this.setStatus(root,error instanceof Error?error.message:String(error));return;}
  const client=this.bridgeClient(documentRootId);
  const generation=++this.associationGeneration,navigation=this.workController.navigationVersion,sceneGeneration=this.workLoadSeq,originScope=this.chatScopeKey(),originView=this.viewCleanup.get(root);
  this.setAssociationOpen(root,true);
  const sceneCurrent=()=>!this.disposed&&pageCurrent()&&this.workController.navigationVersion===navigation&&this.workLoadSeq===sceneGeneration&&this.chatScopeKey()===originScope&&this.viewCleanup.get(root)===originView&&root.isConnected&&this.bridgeUrl===bridgeUrl&&this.bridgeToken===bridgeToken&&this.workController.currentWorkId===originWorkId&&this.currentDocumentId()===originDocumentId;
  const isCurrent=()=>sceneCurrent()&&this.associationRoot===root&&this.associationGeneration===generation;
  try{
   const overlay=document.createElement('div');overlay.className='sac-studio-picker';
   this.associationOverlay=overlay;
   const closePicker=()=>{if(this.associationRoot===root&&this.associationGeneration===generation&&this.associationOverlay===overlay)this.invalidateAssociationFor(root);};
    overlay.innerHTML='<div role="dialog" aria-label="关联 Hermes 对话" tabindex="-1"><input data-studio-search aria-label="搜索 Hermes 对话" placeholder="搜索对话" disabled><small data-studio-read-warning hidden></small><div data-studio-options role="radiogroup" aria-label="Hermes 对话"><small data-studio-loading>正在读取可关联对话…</small></div><div class="sac-studio-actions"><button type="button" data-studio-cancel aria-label="取消关联">取消</button><button type="button" data-studio-confirm aria-label="确认关联" disabled>确认关联</button></div></div>';
   const options=overlay.querySelector<HTMLElement>('[data-studio-options]')!,search=overlay.querySelector<HTMLInputElement>('[data-studio-search]')!,confirm=overlay.querySelector<HTMLButtonElement>('[data-studio-confirm]')!,cancel=overlay.querySelector<HTMLButtonElement>('[data-studio-cancel]')!;
    let sessions:Awaited<ReturnType<typeof client.listCandidates>>['data']=[],selected='',bindingInFlight=false;
   const draw=()=>{options.innerHTML=renderStudioSessionOptions(sessions,search.value);options.querySelectorAll<HTMLInputElement>('input').forEach(input=>input.onchange=()=>{selected=input.value;if(!bindingInFlight)confirm.disabled=false;});};
   search.oninput=draw;cancel.addEventListener('click',()=>{if(!bindingInFlight)closePicker();});
    overlay.addEventListener('keydown',event=>{if(event.key==='Escape'&&!bindingInFlight){event.preventDefault();closePicker();}});
   confirm.onclick=async()=>{
    if(!isCurrent()||bindingInFlight||!selected||!sessions.some(session=>session.id===selected))return;
    bindingInFlight=true;confirm.disabled=true;cancel.disabled=true;
    const bindingKey=`${workId}\u0000${documentRootId}\u0000${connection.id}\u0000${selected}`;
    if(this.activeBindingKeys.has(bindingKey)){this.setStatus(root,'该会话关联仍在处理中，请等待原请求结果');bindingInFlight=false;confirm.disabled=false;cancel.disabled=false;return;}
    try{const prior=await this.priorUnknownCandidate(workId,documentRootId,connection.id,selected);if(prior){if(isCurrent())this.setStatus(root,prior.state==='unknown'?`已有未决关联 Chat ID：${prior.chatId}，请先核对结果，不能为同一会话重新分配 ID。`:`该会话已关联 Chat ID：${prior.chatId}，请打开原 Chat，不能重复关联。`);bindingInFlight=false;confirm.disabled=false;cancel.disabled=false;return;}}
    catch(error){if(isCurrent())this.setStatus(root,`未决关联检查失败，已阻止关联：${error instanceof Error?error.message:String(error)}`);bindingInFlight=false;confirm.disabled=false;cancel.disabled=false;return;}
    if(!isCurrent()){bindingInFlight=false;return;}
    const local=newThread(documentRootId,String(sessions.find(session=>session.id===selected)?.title||'Hermes 会话'));
    let attempted=false,responseSeen=false,formalSaved=false;
    let acceptedLink:ChatLink|undefined;
    try{
     if(!isCurrent()||workId&&!(await this.workService.readWork(workId)))throw new Error('Work 或文档已切换，请重新选择');
     if(!isCurrent())throw new Error('页面或连接已变化，请重新选择');
     attempted=true;
     this.activeBindingKeys.add(bindingKey);
     const {chat}=await client.bindChat(local.id,connection.id,selected,local.title);
     responseSeen=true;
     if(chat.chatId!==local.id||chat.documentRootId!==documentRootId||chat.connectionId!==connection.id||chat.storedSessionId!==selected||chat.kind!==connection.kind||chat.profile!==connection.profile||chat.installId!==connection.installId)throw new Error('Bridge 关联响应与选择不符；请核对');
     const link=this.chatLinkFromView(chat,workId);acceptedLink=link;await this.workStore.linkChat(link);formalSaved=true;
     const showUi=isCurrent();closePicker();
     if(!showUi)return;
      const thread=this.threadFromLink(link);if(this.chatScopeCurrent(workId,documentRootId)){this.threads.push(thread);this.rememberThreads();document.querySelectorAll<HTMLElement>('.sac').forEach(panel=>this.renderThreads(panel));}
      this.workTab?.refresh();this.showAssociatedChatAction(root,thread.id,workId,`对话已关联到${workId?'所选 Work':'当前文档'}；当前对话未切换。可点击“打开对话”或在上方选择。`);
    }catch(error){
      if(acceptedLink&&!formalSaved){const showUi=isCurrent();closePicker();await this.preserveUnstoredChat(root,acceptedLink,'关联 Chat',showUi,false);return;}
     if(attempted&&(responseSeen||!(error instanceof BridgeError)||error.status>=500)){
      const unknown:ChatLink={chatId:local.id,workId,documentRootId,connectionId:connection.id,adapter:connection.kind,profile:connection.profile,storedSessionId:selected,installId:connection.installId,title:local.title,state:'unknown'};
       let showUi=false;
       try{await this.workStore.linkChat(unknown);showUi=isCurrent();closePicker();if(showUi&&this.chatScopeCurrent(workId,documentRootId)){this.threads.push(this.threadFromLink(unknown));this.rememberThreads();document.querySelectorAll<HTMLElement>('.sac').forEach(panel=>this.renderThreads(panel));}}
       catch{const showUi=isCurrent();closePicker();await this.preserveUnstoredChat(root,unknown,'关联 Chat',showUi,false);return;}
       // Closing the picker invalidates isCurrent; retain only this freshly checked result,
       // and keep the independent scene guard for any synchronous rendering callbacks.
       if(showUi&&sceneCurrent())this.setStatus(root,`关联 Chat ${local.id} 结果需核对：${error instanceof Error?error.message:String(error)}；当前对话未切换，请勿重复确认。`);
       return;
     }else if(!attempted||(error instanceof BridgeError&&error.status<500)){bindingInFlight=false;confirm.disabled=false;cancel.disabled=false;}
      if(isCurrent())this.setStatus(root,`关联 Chat ${local.id} 结果需核对：${error instanceof Error?error.message:String(error)}；当前对话未切换，请勿重复确认。`);
    }finally{if(attempted)this.activeBindingKeys.delete(bindingKey);}
   };
    mountStudioPicker(root,overlay);overlay.querySelector<HTMLElement>('[role="dialog"]')?.focus({preventScroll:true});
    const listed=await client.listCandidates(connection.id);
    sessions=listed.data;
    if(!isCurrent()){this.invalidateAssociationFor(root);return;}
    const notice=overlay.querySelector<HTMLElement>('[data-studio-read-warning]')!;
    if(connection.kind==='studio'&&validatedStudioReadWarning(listed.readWarning)){notice.textContent=STUDIO_PARTIAL_READ_NOTICE;notice.hidden=false;}
    search.disabled=false;draw();search.focus({preventScroll:true});
  }catch(error){if(isCurrent()){this.invalidateAssociationFor(root);this.setStatus(root,`读取候选对话失败：${error instanceof Error?error.message:String(error)}`);}}
 }
 private actualConnection(){
  const thread=this.threads.find(t=>t.id===this.activeThreadId);
  return thread?.adapter&&thread.adapter!=='unresolved'?this.connectionViews.find(v=>v.id===thread.connectionId):this.selectedConnection();
 }
 private currentConnectionReady():boolean{
  const thread=this.threads.find(t=>t.id===this.activeThreadId),view=this.actualConnection();
  const read=this.chatReadStatus,readMatches=Boolean(thread&&read?.chatId===thread.id&&read.connection===this.connectionIdentity());
  if(readMatches&&!read?.ready)return false;
  if(thread?.legacyBridgeUrl||view?.kind==='legacy-api'&&view.state==='configured')return Boolean(readMatches&&read?.ready);
  return Boolean(view?.state==='ready'&&(!thread?.adapter||thread.adapter==='unresolved'||view.profile===thread.profile&&(thread.adapter!=='serve'||view.installId===thread.installId)));
 }
 private async syncHermesSessions():Promise<boolean>{
  if(this.disposed||this.chatBusy()||this.pendingProposal||this.workController.isTransitioning)return false;
  if(!this.bridgeUrl||!this.bridgeToken)throw new Error('Bridge 未配对');
  const connection=this.connectionIdentity(),selected=this.selectedConnectionId,confirmed=this.confirmedConnectionId,chatId=this.activeThreadId,workId=this.workController.currentWorkId,documentId=this.currentDocumentId(),generation=this.workLoadSeq,navigation=this.workController.navigationVersion;
  let version=++this.historyVersion;
  const current=()=>!this.disposed&&!this.chatBusy()&&!this.pendingProposal&&!this.workController.isTransitioning&&connection===this.connectionIdentity()&&selected===this.selectedConnectionId&&confirmed===this.confirmedConnectionId&&chatId===this.activeThreadId&&workId===this.workController.currentWorkId&&documentId===this.currentDocumentId()&&generation===this.workLoadSeq&&navigation===this.workController.navigationVersion&&version===this.historyVersion;
  try{
   const views=validatedConnections((await createBridgeClient({bridgeUrl:this.bridgeUrl,capabilityToken:this.bridgeToken,signal:AbortSignal.timeout(10000)},'').listConnections()).data);
   if(!current())return false;
   this.connectionViews=views;
   const thread=this.threads.find(t=>t.id===chatId);
   if(thread?.state==='ready'&&thread.adapter!=='unresolved'){
    const original=views.find(v=>v.id===thread.connectionId);
    if(!thread.legacyBridgeUrl&&(!original||original.state!=='ready'&&!(thread.adapter==='legacy-api'&&original.state==='configured')))throw Error('原 Chat 的 Hermes 服务不可用，请核对原连接');
    const reading=this.loadThreadMessages(thread);
    // The owned history read advances historyVersion; newer competing reads invalidate this refresh.
    version=this.historyVersion;
    if(await reading===false)return false;
   }else if(this.selectedConnection()?.state!=='ready')throw Error('所选 Hermes 连接不可用，请核对后重试');
   return current();
  }catch(error){if(!current())return false;throw error;}
 }
 private async loadThreadMessages(thread:ChatThread|undefined,generation=this.workLoadSeq,isCurrent:()=>boolean=()=>true):Promise<boolean>{
  if(!isCurrent())return false;
  if(!thread||!isValidDocumentRootId(thread.documentRootId))throw new Error('请先打开一个思源文档');
  const version=++this.historyVersion,connection=this.connectionIdentity(),workId=this.workController.currentWorkId,documentId=this.currentDocumentId(),navigation=this.workController.navigationVersion,selected=this.selectedConnectionId,confirmed=this.confirmedConnectionId;
  const current=()=>isCurrent()&&!this.disposed&&version===this.historyVersion&&connection===this.connectionIdentity()&&generation===this.workLoadSeq&&this.activeThreadId===thread.id&&this.workController.currentWorkId===workId&&this.currentDocumentId()===documentId&&this.workController.navigationVersion===navigation&&this.selectedConnectionId===selected&&this.confirmedConnectionId===confirmed;
  try{
   const data=await readThreadMessages(thread,{bridgeUrl:this.bridgeUrl,capabilityToken:this.bridgeToken});
   if(!data||!current())return false;
   const pendingItems=await this.workStore.listPending();
   if(!current())return false;
   const pending=pendingItems.some(item=>item.id===`chat-run:${thread.id}`);
   const messages=bridgeMessagesToChat(data.data).map((m,i)=>({id:`hermes-${thread.id}-${i}`,role:m.role,content:m.content,references:[],status:'complete' as const}));
   this.chatReadStatus={chatId:thread.id,connection,ready:true};
   this.threads=this.threads.map(x=>x.id===thread.id?{...x,messages:pending?[...messages,...x.messages.filter(old=>!messages.some(remote=>remote.role===old.role&&remote.content===old.content))]:messages}:x);this.rememberThreads();
   return true;
  }catch(error){
   if(!current())return false;
   this.chatReadStatus={chatId:thread.id,connection,ready:false};throw error;
  }
 }
 private async ensureHermesSession(thread:ChatThread){if(thread.hermesSessionId)return thread.hermesSessionId;if(!this.bridgeUrl)throw new Error('未配置 Bridge 地址');if(!isValidDocumentRootId(thread.documentRootId))throw new Error('请先打开一个思源文档');const created=await this.bridgeClient(thread.documentRootId).createSession(`[思源] ${thread.title}`.slice(0,200),thread.id);const updated={...thread,hermesSessionId:created.session.id,connectionId:this.bridgeUrl,title:String(created.session.title||thread.title)};this.threads=this.threads.map(x=>x.id===thread.id?updated:x);return created.session.id;}
 private currentEditor(){return selectActiveEditor({document,editors:getAllEditor()});}
 private currentDocumentId(){const rootID=this.currentEditor()?.protyle?.block?.rootID||'';return isValidDocumentRootId(rootID)?rootID:'';}
 private currentFocusBlockId(){const editor=this.currentEditor();if(!editor)return null;const input=extractEditorContext({document,activeProtyle:editor.protyle?.element||null,rootID:this.currentDocumentId()});return input.focusBlockId||null;}
 private ensureThread():ChatThread|undefined{const existing=switchThread(this.threads,this.activeThreadId);if(existing)return existing;const documentRootId=this.currentDocumentId();if(!isValidDocumentRootId(documentRootId))return undefined;const thread=newThread(documentRootId,'当前对话');this.threads=[thread];this.activeThreadId=thread.id;return thread;}
 private async roomAvailableSources(workId:string|null):Promise<RoomSourceOption[]>{
  const documentId=this.currentDocumentId();
  const options:RoomSourceOption[]=[];
  const editor=this.currentEditor();
  if(documentId&&editor){
   const selected=extractEditorContext({document,activeProtyle:editor.protyle?.element||null,rootID:documentId});
   if(selected.focusBlockId&&selected.selection){
    const originalBlock=await this.readBlockMarkdown(selected.focusBlockId);
    if(originalBlock.includes(selected.selection))options.push({label:`当前选区 · ${selected.title||documentId}`,source:{kind:'selection',documentId,blockId:selected.focusBlockId,selectedText:selected.selection,originalBlock}});
   }
  }
  const descendants=workId?await this.workHost.listDescendantDocuments(workId):[];
  const external=workId?await this.workService.listExternalDocuments(workId):[];
  for(const id of [...new Set([documentId,workId,...descendants,...external].filter(isValidDocumentRootId))]){
   const title=await this.workHost.getDocumentTitle(id);
   options.push({label:`${id===documentId?'当前文档全文 · ':''}${title||id} · 全文`,source:{kind:'document',documentId:id}});
  }
  return options;
 }
 private async roomLoadSource(source:SelectedRoomSource){
  const title=await this.workHost.getDocumentTitle(source.documentId);
  if(source.kind==='document')return {kind:'document' as const,documentId:source.documentId,title:title||source.documentId,text:await this.workHost.getDocumentMarkdown(source.documentId)};
  return {kind:'block' as const,documentId:source.documentId,blockId:source.blockId,title:title||source.documentId,text:await this.readBlockMarkdown(source.blockId)};
 }
 private render(root:HTMLElement){
  this.disposeRoomView(root);
  root.innerHTML=createChatShell();this.workController.attach(root);
  const shell=root.querySelector<HTMLElement>('.sac')!;
  this.mountQuickPicker(root,shell);
  const view:EkkoRoomUI=new EkkoRoomUI(shell,{openConnectionSettings:()=>this.openSettings(root,'ekko'),drafts:this.roomDrafts,onChanged:()=>this.refreshSessionViews(),client:()=>new EkkoBridgeClient({bridgeUrl:this.bridgeUrl,capabilityToken:this.bridgeToken}),store:this.roomStore,pendingStore:this.pendingRoomSendStore,
   isCurrent:()=>!this.disposed&&!this.settingsSaving&&root.isConnected&&this.roomViews.get(root)===view,getSceneIdentity:()=>JSON.stringify([this.connectionIdentity(),this.roomConnectionVersion,this.workController.navigationVersion,this.workLoadSeq]),getBridgeIdentity:()=>JSON.stringify([this.connectionIdentity(),this.roomConnectionVersion]),getWorkId:()=>this.workController.currentWorkId,getDocumentRootId:()=>this.currentDocumentId(),
   availableSources:id=>this.roomAvailableSources(id),loadSource:source=>this.roomLoadSource(source)});
  this.roomViews.set(root,view);
  const events=new (root.ownerDocument.defaultView as any).AbortController() as AbortController;this.bind(root,events.signal);root.querySelector<HTMLButtonElement>('[data-action="retry-connection"]')!.onclick=()=>void this.retryStatus(root);const resizeCleanup=bindComposerResize(root);const menuCleanup=bindDismissibleMenu(root.querySelector('.sac-chat-menu-anchor'),root.querySelector('[data-chat-menu]'),root.querySelector('[data-action="chat-actions-menu"]'),()=>this.setChatMenuOpen(root,false));this.viewCleanup.set(root,()=>{events.abort();resizeCleanup();menuCleanup();const area=root.querySelector<HTMLElement>('[data-messages]');if(area)this.messageRenderers.get(area)?.dispose();for(const el of root.querySelectorAll<HTMLElement>('*')){el.onclick=null;el.onchange=null;}});this.renderConnection(root);this.ensureThread();this.renderThreads(root);this.renderMessages(root);this.renderReferences(root);this.activateDraft();this.renderStatus(root);applyGeneratingState(root,this.chatBusy());void this.workController.refreshFromEditor();if(this.bridgeToken&&!this.connectionOk)void this.refreshConnection();
 }
 private bind(root:HTMLElement,signal?:AbortSignal){this.bindChatActions(root);
  root.querySelector<HTMLButtonElement>('[data-action="reconnect-hermes"]')!.onclick=async()=>{const button=root.querySelector<HTMLButtonElement>('[data-action="reconnect-hermes"]')!;if(!this.isHermesSurface(root)||button.disabled)return;button.disabled=true;try{await this.refreshConnection();}finally{if(this.roomViews.has(root))button.disabled=false;}};
  root.querySelector<HTMLButtonElement>('[data-action="review-send"]')!.onclick=()=>void this.reviewSend(root);
  root.querySelector<HTMLButtonElement>('[data-action="confirm-send-reviewed"]')!.onclick=()=>{if(!this.isHermesSurface(root))return;this.setStatus(root,'人工核对不会解除共享服务未决请求；请继续核对原会话与 Bridge 执行状态。');};
 root.querySelector<HTMLButtonElement>('[data-action="associate-studio"]')!.onclick=()=>this.associateStudio(root);root.querySelector<HTMLButtonElement>('[data-action="dismiss-status"]')!.onclick=()=>this.setStatus(root,'');root.querySelector<HTMLSelectElement>('[data-thread-selector]')!.onchange=()=>void this.selectSession(root);root.querySelector<HTMLButtonElement>('[data-action="toggle-settings"]')!.onclick=()=>this.openSettings(root);root.querySelector<HTMLButtonElement>('[data-action="add-reference"]')!.onclick=()=>this.addCurrentReference(root);root.querySelector<HTMLButtonElement>('[data-action="snapshot"]')!.onclick=()=>this.takeSnapshot(root);root.querySelector<HTMLButtonElement>('[data-action="send-stop"]')!.onclick=()=>{if(!this.isHermesSurface(root))return;if(this.sendInFlight)void this.stopCurrentRun(root);else void this.send(root);};const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!; textarea.addEventListener('input',()=>{this.saveDraft(root);for(const other of this.roomViews.keys())if(other!==root){const input=other.querySelector<HTMLTextAreaElement>('[data-composer] textarea');if(input)input.value=textarea.value;}this.updateMentionPicker(root);},{signal}); textarea.addEventListener('keydown',event=>{const refs=this.currentMentionCandidates(textarea);const action=mentionKeyAction({key:event.key,index:this.mentionIndex,count:refs.length,open:this.mentionOpen,isComposing:event.isComposing});if(action.kind==='move'){event.preventDefault();this.mentionIndex=action.index;this.renderMentionPicker(root,refs);return;}if(action.kind==='choose'){event.preventDefault();const chosen=refs[action.index];if(chosen){const result=applyMentionSelection(textarea.value,textarea.selectionStart,chosen,this.references.numberOf(chosen.id));textarea.value=result.text;textarea.setSelectionRange(result.cursor,result.cursor);}this.closeMentionPicker(root);return;}if(action.kind==='close'){event.preventDefault();this.closeMentionPicker(root);return;}if(!this.mentionOpen&&isSendKey(event)){event.preventDefault();void this.send(root);}},{signal});root.querySelector<HTMLFormElement>('[data-composer]')!.addEventListener('submit',event=>{event.preventDefault();if(!this.mentionOpen)void this.send(root);},{signal});textarea.addEventListener('blur',()=>{window.setTimeout(()=>{if(!signal?.aborted&&!root.querySelector('.sac-mention-option:hover'))this.closeMentionPicker(root);},0);},{signal});root.addEventListener('pointerdown',event=>{if(!(event.target as Element).closest('.sac-mention-wrap'))this.closeMentionPicker(root);},{signal});}
 private currentMentionCandidates(textarea:HTMLTextAreaElement){const match=mentionQueryAtCursor(textarea.value,textarea.selectionStart);if(!match)return [];return filterMentionCandidates(this.references.list(),match.query);}
  private mentionNumbers(){return new Map(this.references.list().map((r,i)=>[r.id,i+1]));}
  private updateMentionPicker(root:HTMLElement){const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;const match=mentionQueryAtCursor(textarea.value,textarea.selectionStart);const refs=match?filterMentionCandidates(this.references.list(),match.query):[];if(match){this.mentionOpen=true;this.mentionIndex=clampMentionIndex(this.mentionIndex,refs.length);this.renderMentionPicker(root,refs);}else this.closeMentionPicker(root);}
  private renderMentionPicker(root:HTMLElement,refs:ReturnType<ReferenceBasket['list']>){const list=root.querySelector<HTMLElement>('[data-mention-list]')!;list.toggleAttribute('hidden',!this.mentionOpen);if(!this.mentionOpen)return;this.mentionIndex=clampMentionIndex(this.mentionIndex,refs.length);list.innerHTML=renderMentionPickerMarkup(refs,this.mentionIndex,this.mentionNumbers());list.querySelectorAll<HTMLButtonElement>('.sac-mention-option').forEach(option=>{option.addEventListener('pointerdown',event=>{event.preventDefault();const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;const ref=this.references.list().find(r=>r.id===option.dataset.referenceId);if(!ref)return;const result=applyMentionSelection(textarea.value,textarea.selectionStart,ref,this.references.numberOf(ref.id));textarea.value=result.text;textarea.setSelectionRange(result.cursor,result.cursor);textarea.dispatchEvent(new Event('input',{bubbles:true}));this.closeMentionPicker(root);});});}
  private closeMentionPicker(root:HTMLElement){this.mentionOpen=false;const list=root.querySelector<HTMLElement>('[data-mention-list]');if(list)list.toggleAttribute('hidden',true);}
 private showAssociatedChatAction(root:HTMLElement,chatId:string,workId:string|null,message:string){this.setStatus(root,message);const button=root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]');if(button){button.dataset.chatId=chatId;button.dataset.workId=workId||'';button.hidden=false;}}
 private setStatus(root:HTMLElement,text:string,retry?:()=>Promise<void>){
  if(this.disposed||![...this.roomViews.keys()].some(view=>view===root||view.contains(root)))return;
  if(text==='Hermes · 已连接'){this.updateConnectionUI(true);return;}
  if(text.startsWith('Hermes · 未连接')){this.connectionOk=false;this.connectionText=text;this.renderConnection(root);}
  else this.operationNotices.set(root,text);
  if(retry)this.statusRetry.set(root,retry);else this.statusRetry.delete(root);
  this.renderStatus(root);
 }
 private renderPendingChatNotice(root:HTMLElement,text:string){const el=root.querySelector<HTMLElement>('[data-pending-chats]');if(el){el.textContent=text;el.toggleAttribute('hidden',!text);}const alert=root.querySelector<HTMLElement>('[data-status-alert]');if(alert)alert.toggleAttribute('hidden',!text&&!root.querySelector<HTMLElement>('[data-status]')?.textContent);}
 private renderConnection(root:HTMLElement){const inChat=this.isHermesSurface(root),connected=this.connectionOk&&this.currentConnectionReady();const badge=root.querySelector<HTMLElement>('[data-connection]');badge?.toggleAttribute('hidden',!inChat);const label=root.querySelector<HTMLElement>('[data-connection-label]');if(badge)badge.dataset.state=connected?'connected':(this.connectionText.includes('未连接')?'error':'disconnected');if(badge){const actual=this.actualConnection();badge.title=actual?`${connectionLabel(actual)}：${connectionAdvice(actual)}${!connected?'；原 Chat 未连接，请重连核对':''}`:this.connectionText;}if(label)label.textContent=connected?'已连接':!this.bridgeToken?'未配置':this.connectionText.includes('Studio 授权未通过')?'授权待更新':'未连接';const retry=root.querySelector<HTMLButtonElement>('[data-action="reconnect-hermes"]');if(retry)retry.hidden=!inChat||!this.bridgeToken||connected;}
 private updateConnectionUI(syncOk:boolean,error?:unknown){if(this.disposed)return;const text=connectionStatus({hasToken:Boolean(this.bridgeToken),syncOk,error});this.connectionText=text;this.connectionOk=syncOk;if(!syncOk){const actual=this.actualConnection();if(actual?.state==='ready')this.connectionViews=this.connectionViews.map(v=>v.id===actual.id?{...v,state:'offline'}:v);}this.roomViews.forEach((_view,root)=>{this.renderConnection(root);this.renderStatus(root);if(syncOk){this.ensureThread();this.renderThreads(root);this.renderMessages(root);}});}
 private refreshConnection(){if(!this.bridgeToken){this.updateConnectionUI(false);return Promise.resolve();}return this.reconnectController?.refreshNow()??Promise.resolve();}
 private renderThreads(root:HTMLElement){
  root=[...this.roomViews.keys()].find(container=>container===root||container.contains(root))||root;
  const surface=this.isHermesSurface(root)?'chat':'ekko',previousSurface=this.surfaces.get(root);if(previousSurface&&previousSurface!==surface)++this.historyVersion;this.surfaces.set(root,surface);this.renderConnection(root);this.renderStatus(root);
  const select=root.querySelector<HTMLSelectElement>('[data-thread-selector]');if(!select)return;
  const version=(this.sessionVersions.get(root)||0)+1;this.sessionVersions.set(root,version);
  const workId=this.workController.currentWorkId,documentId=this.currentDocumentId(),navigation=this.workController.navigationVersion,view=this.roomViews.get(root);
  const chats:SessionChat[]=this.threads.map(t=>this.sessionChat(t,workId));
  const draw=(rooms:Awaited<ReturnType<RoomLinkStore['listForWork']>>)=>{
   if(this.disposed||!this.roomViews.has(root)||this.sessionVersions.get(root)!==version||this.workController.currentWorkId!==(workId||null)||this.currentDocumentId()!==documentId||this.workController.navigationVersion!==navigation||this.roomViews.get(root)!==view)return;
   const rows=sessionChoices(workId,chats,rooms,documentId);this.sessionRows.set(root,rows);
   const room=this.roomViews.get(root)?.activeLink;const inRoom=root.querySelector<HTMLElement>('.sac')?.dataset.surface==='ekko';
   const current=inRoom&&room?sessionKey({kind:'ekko',link:room}):sessionKey({kind:'hermes',link:chats.find(t=>t.chatId===this.activeThreadId)||this.sessionChat(newThread('',''),workId)});
   select.innerHTML=rows.length?(['hermes','ekko'] as const).map(kind=>{
    const group=rows.filter(row=>row.kind===kind);
    return group.length?`<optgroup label="${kind==='hermes'?'AI 对话 · Hermes':'协作房间 · EKKO'}">${group.map(row=>`<option value="${escapeHtml(sessionKey(row))}" title="${escapeHtml(sessionDetails(row))}" ${sessionKey(row)===current?'selected':''}>${escapeHtml(sessionLabel(row))}</option>`).join('')}</optgroup>`:'';
   }).join(''):'<option value="">暂无会话</option>';select.disabled=!rows.length;const selected=rows.find(row=>sessionKey(row)===current);select.title=selected?sessionDetails(selected):'';
   const kindLabel=root.querySelector<HTMLElement>('[data-current-session-kind]');
   if(kindLabel){kindLabel.textContent=inRoom?'协作房间':'AI 对话';kindLabel.dataset.kind=inRoom?'ekko':'hermes';}
  };
  draw([]);if(isValidDocumentRootId(documentId))void (workId?this.roomStore.listForWork(workId):this.roomStore.listForDocument(documentId)).then(draw).catch(error=>{if(this.sessionVersions.get(root)===version&&this.currentDocumentId()===documentId&&this.roomViews.get(root)===view)this.setStatus(root,`房间关联读取失败：${error.message}`);});
 }
  private renderMessages(root:HTMLElement){const area=root.querySelector<HTMLElement>('[data-messages]')!;const thread=this.ensureThread();const failed=this.historyFailure;const historyUnavailable=thread?.hermesSessionId&&failed?.workId===this.workController.currentWorkId&&failed?.connection===this.connectionIdentity()&&failed?.chatId===thread.id&&failed?.documentRootId===thread.documentRootId;let renderer=this.messageRenderers.get(area);if(!renderer){renderer=new MessageRenderer<any>(area,renderMessageMarkup);this.messageRenderers.set(area,renderer);}renderer.render(JSON.stringify([this.workController.currentWorkId,this.draftIdentity(),thread?.id]),thread?.messages||[],historyUnavailable?'<div class="sac-empty"><h2>历史暂不可读取</h2><p>已保留原对话的关联。恢复 Hermes 连接后重试，无需新建对话。</p></div>':renderEmptyStateMarkup());this.renderProposal(root);}
 private renderProposal(root:HTMLElement){
  let panel=root.querySelector<HTMLElement>('[data-proposal]');
  if(!panel){panel=document.createElement('section');panel.dataset.proposal='';panel.dataset.chatOnly='';panel.className='sac-proposal';root.querySelector('[data-messages]')?.after(panel);}
  const proposal=this.pendingProposal;
  if(!proposal||proposal.threadId!==this.activeThreadId){panel.hidden=true;panel.innerHTML='';return;}
  panel.hidden=false;
  panel.innerHTML=`<strong>修改建议 · ${proposal.items.length} 块</strong><small>目标文档 ${escapeHtml(proposal.targetDocumentId)}；接受前会核对文档根与原文。</small>${proposal.items.map(item=>`<details><summary>块 ${escapeHtml(item.blockId)}</summary><div>原文</div><pre>${escapeHtml(item.expectedOriginal)}</pre><div>建议</div><pre>${escapeHtml(item.replacement)}</pre></details>`).join('')}<div><button type="button" data-accept-proposal>接受并写入</button><button type="button" data-reject-proposal>放弃建议</button></div>`;
  panel.querySelector<HTMLButtonElement>('[data-accept-proposal]')!.onclick=()=>void this.accept(root);
  panel.querySelector<HTMLButtonElement>('[data-accept-proposal]')!.disabled=this.proposalNeedsReview;
  panel.querySelector<HTMLButtonElement>('[data-reject-proposal]')!.onclick=()=>{this.pendingProposal=null;this.proposalNeedsReview=false;this.renderProposal(root);this.setStatus(root,'已关闭修改建议；如曾尝试写入，请按未决提示核对正文');};
 }
 private renderReferences(root:HTMLElement){const area=root.querySelector<HTMLElement>('[data-references]')!;const refs=this.references.list();this.workController.updateReferenceSummary?.(refs.length);area.toggleAttribute('hidden',refs.length===0);area.innerHTML=renderReferenceBasketMarkup(refs);area.querySelectorAll<HTMLButtonElement>('[data-remove-reference]').forEach(button=>button.onclick=()=>{this.references.remove(button.dataset.removeReference!);for(const viewRoot of this.roomViews.keys())this.renderReferences(viewRoot);});}
 private async addCurrentReference(root:HTMLElement){const basket=this.references;const documentRootId=this.currentDocumentId();if(!isValidDocumentRootId(documentRootId)){this.setStatus(root,'请先打开一个思源文档');return;}const editor=this.currentEditor();const input=extractEditorContext({document,activeProtyle:editor?.protyle?.element||null,rootID:documentRootId});if(!input.focusBlockId||!input.selection){this.setStatus(root,'请先选择要引用的文字');return;}try{const k=parseKramdownResponse(await this.api('/api/block/getBlockKramdown',{id:input.focusBlockId}));if(this.disposed)return;basket.add({id:`quote-${++this.quoteSeq}`,blockId:input.focusBlockId,documentRootId:input.documentId,documentTitle:input.title,selectedText:input.selection,startOffset:null,endOffset:null,capturedBlockKramdown:k,expectedOriginal:k,createdAt:new Date().toISOString()});if(this.references===basket){for(const viewRoot of this.roomViews.keys())this.renderReferences(viewRoot);this.setStatus(root,'');}}catch(e:any){this.setStatus(root,`加入引用失败：${e.message}`);}}
 private async takeSnapshot(root:HTMLElement):Promise<Snapshot|null>{
  const version=++this.snapshotVersion,workId=this.workController.currentWorkId,chatId=this.activeThreadId,connection=this.connectionIdentity();
  const documentRootId=this.currentDocumentId();
  if(!isValidDocumentRootId(documentRootId)){this.setStatus(root,'请先打开一个思源文档');return null;}
  const current=()=>!this.disposed&&this.roomViews.has(root)&&version===this.snapshotVersion&&this.currentDocumentId()===documentRootId&&this.workController.currentWorkId===workId&&this.activeThreadId===chatId&&this.connectionIdentity()===connection;
  const editor=this.currentEditor();const input=extractEditorContext({document,activeProtyle:editor?.protyle?.element||null,rootID:documentRootId,recentBlockIds:this.recentBlockIds});
  try{const enriched=await enrichEditorContext(input,id=>this.api('/api/block/getBlockKramdown',{id}));if(!current())return null;this.snapshot=buildSnapshot(enriched,{maxChars:12000});this.setStatus(root,'上下文已刷新');return this.snapshot;}
  catch(e:any){if(current())this.setStatus(root,`读取上下文失败：${e.message}`);return null;}
 }
 private async prepareRequestSnapshot(root:HTMLElement,documentId:string,choice:ContextChoice,refs:ReturnType<ReferenceBasket['list']>):Promise<Snapshot>{
  const base=await this.takeSnapshot(root);
  if(!base||base.documentId!==documentId)throw new Error('发送前文档已切换，请重新核对本次资料');
  const items:{documentId:string;title:string;kind:'document'|'selection';text:string;blockId?:string}[]=[];
  if(choice.mode==='selection'){
   if(!base.focusBlockId||!base.selection)throw new Error('请先选择要发送的文字');
   const captured=base.nearby.find(x=>x.blockId===base.focusBlockId)?.sourceMarkdown;
   if(!captured)throw new Error('无法核对选区原始内容，请重新选择');
   const fresh=await this.readBlockMarkdown(base.focusBlockId);
   items.push({documentId,title:base.title,kind:'selection',blockId:base.focusBlockId,text:refreshSelection({selectedText:base.selection,originalBlock:captured},fresh)});
  }else if(choice.mode==='document'){
   items.push({documentId,title:base.title,kind:'document',text:await this.workHost.getDocumentMarkdown(documentId)});
  }
  for(const id of [...new Set(choice.documentIds)]){
   if(id===documentId&&choice.mode==='document')continue;
   items.push({documentId:id,title:await this.workHost.getDocumentTitle(id),kind:'document',text:await this.workHost.getDocumentMarkdown(id)});
  }
  for(const ref of refs){
   const fresh=await this.readBlockMarkdown(ref.blockId);
   refreshSelection({selectedText:ref.selectedText,originalBlock:ref.expectedOriginal},fresh);
  }
  const refLength=refs.reduce((total,ref)=>total+ref.selectedText.length+ref.blockId.length+ref.documentRootId.length+80,0);
  const contextText=buildContextPayload(items,120000-refLength);
  return {...base,contextText:contextText||'本次未附加文档正文'};
 }
 private setGenerating(root:HTMLElement,generating:boolean){applyGeneratingState(root,generating);}
 private async stopCurrentRun(root:HTMLElement){
  if(!this.isHermesSurface(root))return;
  if(this.activeRunPhase==='preparing'){this.preSubmitCancelled=true;this.setStatus(root,'发送前已取消；草稿已保留，未请求 Hermes 停止');return;}
  const chatId=this.activeRunChatId;
  const thread=this.threads.find(item=>item.id===chatId);
  if(!chatId||!thread){this.setStatus(root,'本轮没有可确认的停止目标，请到 Hermes 核对');return;}
  if(thread.adapter!=='serve'){this.abortController?.abort();this.setStatus(root,'已请求停止原连接轮次；请核对 Hermes 最终状态');return;}
  try{
   const bridge=this.activeRunBridge;
   if(!bridge||bridge.chatId!==chatId||bridge.documentRootId!==thread.documentRootId)throw new Error('本轮连接身份不可确认');
   const result=await createBridgeClient({bridgeUrl:bridge.bridgeUrl,capabilityToken:bridge.capabilityToken},bridge.documentRootId).stopChat(chatId);
   this.setStatus(root,result.state==='interrupted'?'Hermes 已确认本轮中断':result.state==='not_running'?'Bridge 未持有本轮活跃票据；请到 Hermes 核对':'无法确认仍是本轮，请到 Hermes 核对；未自动中断');
  }catch(error){this.setStatus(root,`停止结果未知，请到 Hermes 核对：${error instanceof Error?error.message:String(error)}`);}
 }
 private async send(root:HTMLElement){
  if(!this.isHermesSurface(root)||this.disposed||this.chatBusy())return;
  if(this.pendingProposal){this.setStatus(root,'请先接受或放弃待处理的修改建议');return;}
  const documentRootId=this.currentDocumentId();
  if(!isValidDocumentRootId(documentRootId)){this.setStatus(root,'请先打开一个思源文档');return;}
  const textarea=root.querySelector<HTMLTextAreaElement>('textarea')!;
  const text=textarea.value.trim();if(!text)return;
  const t=this.ensureThread();if(!t){this.setStatus(root,'请先打开一个思源文档');return;}
  if(t.adapter==='unresolved'||(t.state!=='ready'&&!(t.state==='pending'&&(t.adapter==='serve'||t.adapter==='studio')))){this.setStatus(root,'Chat 来源或结果待确认，不能发送');return;}
  const frozenThread={...t};
  const frozenBridgeUrl=this.bridgeUrl,frozenBridgeToken=this.bridgeToken;
  const legacyRoute=Boolean(frozenThread.legacyBridgeUrl||/^https?:\/\//.test(frozenThread.connectionId||''));
  this.sendInFlight=true;
  this.activeRunPhase='preparing';this.preSubmitCancelled=false;
  try{
  const workId=this.workController.currentWorkId;
  const choice=this.workController.contextChoice;
  const refs=this.references.list().map(x=>({...x}));
  const link=await this.workStore.chatLink(t.id);
  if(this.preSubmitCancelled)return;
  if(!workId&&frozenThread.documentRootId!==documentRootId){this.setStatus(root,'此文档仅供浏览；原对话属于其他文档，请返回原文档或在当前文档新建对话');return;}
  if(!link||link.workId!==workId||link.documentRootId!==frozenThread.documentRootId||link.connectionId!==frozenThread.connectionId||link.adapter!==frozenThread.adapter||link.profile!==frozenThread.profile||link.installId!==(frozenThread.installId??null)||link.storedSessionId!==(frozenThread.storedSessionId??null)||link.state!==frozenThread.state){this.setStatus(root,'Chat 正式关系已变化或缺失；草稿已保留，请核对后发送');return;}
  const pending=await this.workStore.listPending();
  if(this.preSubmitCancelled)return;
  if(pending.some(item=>item.id===`chat-run:${t.id}`)){this.setStatus(root,'上轮发送结果未核对；草稿已保留，不能重复提交');return;}
  const originalRefs=JSON.stringify(refs),originalChoice=JSON.stringify(choice);
  let snapshot:Snapshot;
  try{
   snapshot=await this.prepareRequestSnapshot(root,documentRootId,choice,refs);
   if(this.preSubmitCancelled)return;
   const current=this.threads.find(item=>item.id===t.id);
   if(this.workController.currentWorkId!==workId||this.activeThreadId!==frozenThread.id||this.currentDocumentId()!==documentRootId||this.bridgeUrl!==frozenBridgeUrl||this.bridgeToken!==frozenBridgeToken||current?.connectionId!==frozenThread.connectionId||current?.storedSessionId!==frozenThread.storedSessionId||current?.state!==frozenThread.state||JSON.stringify(this.references.list())!==originalRefs||JSON.stringify(this.workController.contextChoice)!==originalChoice)throw new Error('发送前 Work、Chat、Bridge 连接或资料已变化；草稿已保留');
   const latest=await this.workStore.chatLink(t.id);
   if(this.preSubmitCancelled)return;
   if(!latest||latest.workId!==link.workId||latest.documentRootId!==link.documentRootId||latest.connectionId!==link.connectionId||latest.adapter!==link.adapter||latest.profile!==link.profile||latest.installId!==link.installId||latest.storedSessionId!==link.storedSessionId||latest.state!==link.state)throw new Error('发送前 Chat 正式关系已变化；草稿已保留');
   if(textarea.value.trim()!==text)throw new Error('草稿在读取资料期间变化；请重新检查后发送');
  }catch(error){this.setStatus(root,error instanceof Error?error.message:String(error));return;}
  const request=freezeRequest({workId,chatId:frozenThread.id,connectionId:frozenThread.connectionId!,storedSessionId:frozenThread.storedSessionId??null,chatRootId:frozenThread.documentRootId,targetDocumentId:snapshot.documentId,documentId:snapshot.documentId,context:snapshot.contextText});
  const client=createBridgeClient({bridgeUrl:frozenBridgeUrl,capabilityToken:frozenBridgeToken},request.chatRootId);
  this.abortController=new AbortController();this.setGenerating(root,true);
  this.activeRunChatId=t.id;
  this.activeRunBridge={chatId:t.id,documentRootId:request.chatRootId,bridgeUrl:frozenBridgeUrl,capabilityToken:frozenBridgeToken};
  const assistantId=`stream-${Date.now()}`;
  let streamed='',accepted=false,blockerDurable=false;
  const accept=()=>{if(accepted)return;accepted=true;if(this.workController.currentWorkId===workId&&this.activeThreadId===t.id&&root.isConnected&&textarea.value.trim()===text)prepareOutgoingMessage(textarea);this.threads=this.threads.map(item=>item.id===t.id?appendUserTurn(item,text,refs,{documentId:snapshot.documentId,focusBlockId:snapshot.focusBlockId,nearby:snapshot.nearby}):item);if(this.activeThreadId===t.id&&root.isConnected)this.renderMessages(root);};
  const update=(content:string,status?:'complete'|'cancelled'|'error')=>{
   streamed=content;this.threads=this.threads.map(x=>x.id===t.id?upsertAssistantTurn(x,assistantId,content,status):x);
   if(this.activeThreadId===t.id)this.renderMessages(root);
  };
  try{
   if(!frozenBridgeUrl)throw new Error('未配置 Bridge 地址');
   if(!frozenBridgeToken)throw new Error('Bridge 未配对');
   if(this.bridgeUrl!==frozenBridgeUrl||this.bridgeToken!==frozenBridgeToken)throw new Error('发送前 Bridge 配置已变化；草稿已保留');
   if(!legacyRoute){
    const {chat}=await client.chatForChat(request.chatId);
    if(this.preSubmitCancelled||this.abortController.signal.aborted)return;
    if(chat.chatId!==request.chatId||chat.documentRootId!==request.chatRootId||chat.connectionId!==request.connectionId||chat.kind!==link.adapter||chat.profile!==link.profile||chat.installId!==link.installId||chat.storedSessionId!==request.storedSessionId||chat.state!==link.state)throw new Error('Bridge Chat 身份或状态与正式关系不符；已阻止发送');
   }
   if(this.preSubmitCancelled||this.abortController.signal.aborted)return;
   if(this.bridgeUrl!==frozenBridgeUrl||this.bridgeToken!==frozenBridgeToken)throw new Error('发送前 Bridge 配置已变化；草稿已保留');
   await this.workStore.setPending({id:`chat-run:${t.id}`,kind:'chat',workId,state:'unknown',details:`Chat ${t.id} 发送意图已记录，结果待确认`,updatedAt:new Date().toISOString()});
   blockerDurable=true;
   if(this.preSubmitCancelled||this.abortController.signal.aborted){
    try{await this.workStore.clearPending(`chat-run:${t.id}`);blockerDurable=false;this.setStatus(root,'发送前已取消；草稿已保留，未提交');}
    catch{this.setStatus(root,'发送前已取消且未提交；未决阻塞记录清除失败，请人工核对，勿重复发送');}
    return;
   }
   if(this.bridgeUrl!==frozenBridgeUrl||this.bridgeToken!==frozenBridgeToken)throw new Error('发送前 Bridge 配置已变化；原未决记录已保留');
   if(this.preSubmitCancelled||this.abortController.signal.aborted)return;
   this.activeRunPhase='submitting';
   const result=await streamThreadChat(frozenThread,text,snapshot,{bridgeUrl:frozenBridgeUrl,capabilityToken:frozenBridgeToken,documentRootId:request.chatRootId,references:refs},delta=>update(streamed+delta),this.abortController.signal,(event,raw)=>{
    if(event==='run.queued'||(event==='run.started'&&(frozenThread.adapter!=='serve'||typeof (raw as {userRowId?:unknown})?.userRowId==='number'))||(frozenThread.legacyBridgeUrl&&event==='message.delta'))accept();
   });
   if(!accepted&&result.state==='complete'&&frozenThread.legacyBridgeUrl)accept();
   let effectiveState=result.state==='complete'&&!accepted?'unknown':result.state;
   if(!legacyRoute){
    try{const {chat}=await client.chatForChat(t.id);
     if(chat.chatId!==request.chatId||chat.connectionId!==request.connectionId||chat.documentRootId!==request.chatRootId||chat.kind!==link.adapter||chat.profile!==link.profile||chat.installId!==link.installId||(request.storedSessionId!==null&&chat.storedSessionId!==request.storedSessionId))throw new Error('Bridge Chat 身份与冻结关系不符');
     if(result.state==='queued'&&chat.state==='ready')throw new Error('排队回执与 Bridge Chat 状态不符');
     if(chat.state==='ready'&&chat.storedSessionId){const confirmed=await this.workStore.confirmChatSession(link,chat.storedSessionId);this.threads=this.threads.map(item=>item.id===t.id?this.threadFromLink(confirmed,item):item);}
     else if(effectiveState==='complete')effectiveState='unknown';
    }catch{await this.workStore.setPending({id:`chat-run:${t.id}`,kind:'chat',workId,state:'unknown',details:`Chat ${t.id} 持久会话同步未确认，须人工核对`,updatedAt:new Date().toISOString()});this.setStatus(root,'发送后 Chat 身份同步未确认，已保留未决记录；请人工核对');return;}
   }
   if(effectiveState!=='complete')await this.workStore.setPending({id:`chat-run:${t.id}`,kind:'chat',workId,state:'unknown',details:`Chat ${t.id} 本轮状态 ${effectiveState}，须核对历史后继续`,updatedAt:new Date().toISOString()});
   else await this.workStore.clearPending(`chat-run:${t.id}`);
   if(effectiveState!=='complete'){
    const status=effectiveState==='queued'?'消息已排队；请核对 Hermes 会话后继续':effectiveState==='interrupted'?'Hermes 已确认本轮中断':'本轮结果未确认；请核对 Hermes 会话，勿重复发送';
    update(result.text||status,effectiveState==='interrupted'?'cancelled':'error');this.setStatus(root,status);return;
   }
   this.workController.noteChat();
   const proposal=parseProposal(result.text,snapshot.nearby);
   if(proposal){this.pendingProposal={threadId:t.id,chatRootId:request.chatRootId,targetDocumentId:request.targetDocumentId,items:proposal.plan};this.proposalNeedsReview=false;update(proposal.text,'complete');}
   else update(result.text,'complete');
   this.references.clear();this.workController.clearOnceContext();this.renderReferences(root);this.updateConnectionUI(true);
  }catch(e:any){
   if(blockerDurable){this.setStatus(root,e?.code==='studio_interaction_required'?`需在 Hermes Studio 处理；Chat ID：${t.id}。未决记录已保留。`:`本轮结果或后续状态未确认；Chat ID：${t.id}。原未决记录已保留，请人工核对，勿重复发送。`);return;}
   this.setStatus(root,`发送前检查或未决记录保存失败；草稿已保留，未提交：${e instanceof Error?e.message:String(e)}`);
  }finally{this.setGenerating(root,false);this.abortController=undefined;this.activeRunChatId='';this.activeRunBridge=undefined;}
  }catch(error){this.setStatus(root,`发送前无法核对 Chat：${error instanceof Error?error.message:String(error)}；草稿已保留`);}
  finally{this.sendInFlight=false;this.activeRunPhase=null;this.preSubmitCancelled=false;await this.restoreDurableNotice();this.rememberThreads();}
 }

 private async accept(root:HTMLElement){
  const proposal=this.pendingProposal;if(!proposal)return;
  const button=root.querySelector<HTMLButtonElement>('[data-accept-proposal]');if(button)button.disabled=true;
  try{
   const result=await applyApprovedProposal(proposal,{
    getRoot:id=>this.workHost.getDocumentRoot(id),
    getMarkdown:id=>this.readBlockMarkdown(id),
    updateMarkdown:async(id,markdown)=>{await this.api('/api/block/updateBlock',{id,data:markdown,dataType:'markdown'});},
   },true);
   this.pendingProposal=null;this.renderProposal(root);
   await this.workStore.clearPending(`write:${proposal.threadId}:${proposal.targetDocumentId}`);
   this.setStatus(root,`已逐块写回 ${result.written} 块，读回校验通过`);
  }catch(error){
   const failure=error instanceof WriteFailure?error:null;
   if(failure?.attempted){
    this.proposalNeedsReview=true;
    await this.workStore.setPending({id:`write:${proposal.threadId}:${proposal.targetDocumentId}`,kind:'write',workId:this.workController.currentWorkId,state:failure.attempted>failure.written?'unknown':'partial',details:`${failure.written}/${failure.total} 块已确认写入；${failure.message}`,updatedAt:new Date().toISOString()}).catch(()=>undefined);
   }
   this.setStatus(root,failure?.attempted?`已尝试 ${failure.attempted} 块，确认写入 ${failure.written}/${failure.total} 块；结果需人工核对：${failure.message}`:`未写入：${error instanceof Error?error.message:String(error)}`);
   if(button&&!(failure?.attempted))button.disabled=false;
  }
 }
 private async openWorkPage(route:WorkPageRoute):Promise<void>{
  const editor=this.currentEditor();
  const documentId=editor?.protyle?.block?.rootID||'';
  const input=editor&&isValidDocumentRootId(documentId)?extractEditorContext({document,activeProtyle:editor.protyle?.element,rootID:documentId}):null;
  const context:WorkPageContext|null=input?{documentId,title:input.title,focusBlockId:input.focusBlockId||null}:null;
  await this.workTab?.open(route,context);
 }
 private showChatDock():HTMLElement{
  const item=document.querySelector<HTMLElement>(`#dockRight [data-type="${this.name}siyuan-ai-collab"]`);
  if(item&&!item.classList.contains('dock__item--active'))item.click();
  let root=[...this.roomViews.keys()].find(element=>element.isConnected);
  if(!root){if(!this.floatingPanel?.isConnected)this.toggleFloatingPanel();root=this.floatingPanel;}
  if(!root)throw new Error('聊天侧栏暂不可打开，请重试');
  return root;
 }
 private async preparePageSession(workId:string,association=false):Promise<HTMLElement>{
  if(this.disposed||this.chatBusy()||this.pendingProposal)throw new Error('当前生成或待处理修改期间不能切换会话；请先完成当前操作');
  if(association&&this.workController.currentWorkId!==workId)throw new Error('请先进入此 Work，再关联会话。当前会话和草稿已保留。');
  if(this.workController.currentWorkId!==workId)await this.workController.enterWork(workId);
  if(this.disposed||this.chatBusy()||this.pendingProposal||this.workController.currentWorkId!==workId)throw new Error('当前 Work 或生成状态已变化，请重新打开会话');
  return this.showChatDock();
 }
 private mountWorkPage(element:HTMLElement,context:WorkPageContext|null):WorkPage{
  const page:WorkPage=new WorkPage(element,{catalog:this.workCatalog,context,taskReader:this.taskReader,taskDocumentTitle:id=>this.workHost.getDocumentTitle(id),actions:{
   startDocument:async(captured,pageCurrent)=>{
    const current=()=>!this.disposed&&pageCurrent();
    await this.workController.openDocumentFromPage(captured.documentId,captured.focusBlockId,current);
    if(current())this.showChatDock();
   },
   enter:async id=>{await this.workController.enterWork(id);this.showChatDock();},
   resume:async id=>{await this.workController.resumeWork(id);this.showChatDock();},
   openDocument:async(id,documentId)=>{await this.workController.openWorkDocument(id,documentId);this.showChatDock();},
   task:async id=>{await this.workController.enterTask(id);},
   create:async (captured,mode)=>{await this.workCreateForm.open(captured,mode);},
   settings:()=>this.openSettings(element,'hermes'),
   createTask:async(workId,context,current)=>this.openTaskDialog(workId,context,current,'create',()=>page.refresh()),
   linkTask:async(workId,current)=>{await this.openTaskDialog(workId,null,current,'link',()=>page.refresh());return false;},
    addGoal:async (id,currentGoal)=>{await this.workGoalForm.open(id,await this.workHost.getDocumentTitle(id),currentGoal);},
   setStatus:async(id,status,expectedStatus,current)=>{
    const canChange=()=>!this.disposed&&current()&&!this.chatBusy()&&!this.pendingProposal;
    if(!canChange())throw Error('请先处理正在回复或待接受的修改，再更改工作状态');
    const work=await this.workService.readWork(id);
    if(!work)throw Error('Work 不存在或标记损坏');
    if(!canChange()||work.status!==expectedStatus)throw Error('页面或工作状态已变化，请刷新后重新确认');
    if(!window.confirm(`将“${work.title}”从“${workStatusLabels[expectedStatus]}”改为“${workStatusLabels[status]}”？\n${workStatusDescriptions[status]}\n文档、资料、任务关联与会话记录继续保留，可再次更改状态。`))return false;
    await this.workService.setStatus(id,status,true,{expectedStatus,isCurrent:canChange});
    return true;
   },
   linkDocument:async(id,captured,pageCurrent=()=>true)=>{
    const currentPage=()=>!this.disposed&&pageCurrent();
    if(!currentPage())return false;
    if(this.chatBusy()||this.pendingProposal)throw new Error('生成或待处理修改期间不能关联资料');
    const current=this.currentDocumentId();
    if(current&&current!==captured.documentId)throw new Error('当前编辑器已切换文档；请重新从目标文档打开主页，再关联资料');
    const work=await this.workService.readWork(id);
    if(!currentPage())return false;
    if(!work)throw new Error('目标 Work 不存在或标记已移除，请刷新后重新选择');
    if(this.chatBusy()||this.pendingProposal||this.currentDocumentId()!==current)throw new Error('当前文档或会话状态已变化，请重新核对关联目标');
    if(!window.confirm(documentLinkConfirmation({id:captured.documentId,title:captured.title},work)))return false;
    if(!currentPage())return false;
    if(this.chatBusy()||this.pendingProposal)throw new Error('当前会话状态已变化；未关联资料，请处理后重新确认');
    const after=this.currentDocumentId();
    if(after&&after!==captured.documentId)throw new Error('当前编辑器已切换文档；未关联旧文档');
    await this.workService.linkExternalDocument(id,captured.documentId,true);
    return true;
   },
   newChat:async id=>{const root=await this.preparePageSession(id);this.roomViews.get(root)?.leave();await this.startNewChat(root);},
   associateChat:async(id,current)=>{const root=this.showChatDock();await this.associateStudio(root,id,current);},
   openChat:async(id,link)=>{const root=await this.preparePageSession(id);this.roomViews.get(root)?.leave();await this.selectChat(root,link.chatId,link.connectionId);},
   associateRoom:async(id,current)=>{await this.associateRoom(id,current);},
   openRoom:async(id,link)=>{
    const root=await this.preparePageSession(id),view=this.roomViews.get(root);if(!view)throw new Error('房间侧栏暂不可用');
    await view.enter();await view.openRoom(link.roomId,link);
   },
  }});
  return page;
 }
 private async openTaskDialog(workId?:string,context:WorkPageContext|null=null,pageCurrent:()=>boolean=()=>true,mode:'create'|'link'='create',onLinked?:()=>Promise<void>):Promise<void>{
  const navigation=this.workController.navigationVersion,originWorkId=this.workController.currentWorkId;
  const current=()=>!this.disposed&&pageCurrent()&&navigation===this.workController.navigationVersion&&originWorkId===this.workController.currentWorkId&&!this.chatBusy()&&!this.pendingProposal&&!this.workController.isTransitioning;
  if(!current())throw Error('当前生成、导航或待处理修改期间不能打开任务操作');
  const documentId=workId||context?.documentId||null;
  const title=documentId?await this.workHost.getDocumentTitle(documentId):'';
  const work=workId?await this.workService.readWork(workId):null;
  if(!current())throw Error('页面或 Work 已变化，请重新打开任务操作');
  if(workId&&!work)throw Error('Work 不存在或标记损坏');
  await this.taskDialog.open({documentId,title,workId,workTitle:work?.title,isCurrent:current,onLinked},mode);
 }
 private disposeRoomView(root:HTMLElement){this.settingsDialog?.dispose();this.quickPickers.get(root)?.dispose();this.quickPickers.delete(root);this.statusRetry.delete(root);this.operationNotices.delete(root);if(this.associationRoot===root)this.closeAssociation();if(this.roomViews.has(root))this.saveDraft(root);this.viewCleanup.get(root)?.();this.viewCleanup.delete(root);this.sessionVersions.set(root,(this.sessionVersions.get(root)||0)+1);this.workController.detachRoot(root);this.roomViews.get(root)?.dispose();this.roomViews.delete(root);}
 private chatBusy(){return this.settingsSaving||this.sendInFlight||this.preparing||Boolean(this.abortController)||this.accepting;}
 private bindChatActions(root:HTMLElement):void{
  root.querySelector<HTMLButtonElement>('[data-action="chat-actions-menu"]')!.onclick=()=>this.setChatMenuOpen(root,root.querySelector<HTMLElement>('[data-chat-menu]')!.hidden);
  root.querySelector<HTMLButtonElement>('[data-action="associate-ekko"]')!.onclick=()=>{this.setChatMenuOpen(root,false);void this.associateRoom(undefined,()=>true,root);};
  root.querySelector<HTMLButtonElement>('[data-action="chat-menu-new"]')!.onclick=()=>{this.setChatMenuOpen(root,false);void this.startNewChat(root);};
  root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!.onclick=async()=>{
   const button=root.querySelector<HTMLButtonElement>('[data-action="open-associated-chat"]')!;
   try{if(button.dataset.workId&&button.dataset.workId!==this.workController.currentWorkId)await this.workController.enterWork(button.dataset.workId);
   if(button.dataset.chatId)await this.selectChat(root,button.dataset.chatId,button.dataset.connectionId);}catch(error){this.setStatus(root,error instanceof Error?error.message:String(error));}
  };
 }
 private closeAssociation(){this.associationGeneration++;this.associationOverlay?.remove();this.associationOverlay=undefined;this.associationRoot=undefined;this.associationOpen=false;document.querySelectorAll<HTMLButtonElement>('.sac [data-action="associate-studio"],.sac [data-action="chat-actions-menu"]').forEach(button=>button.disabled=false);}
 private chatScopeKey(workId=this.workController.currentWorkId,documentId=this.workController.activeDocumentId||this.currentDocumentId()){return workId||JSON.stringify(['document',documentId]);}
 private captureRoomScopeRetention(documentId:string):()=>void {
  const bridge=this.connectionIdentity(),connectionVersion=this.roomConnectionVersion;
  const rooms=[...this.roomViews].map(([root,view])=>({root,view,link:view.activeLink,cleanup:this.viewCleanup.get(root)}));
  return ()=>{
   if(this.disposed||this.settingsSaving||this.ekkoSettings.isPairing||this.currentDocumentId()!==documentId||this.connectionIdentity()!==bridge||this.roomConnectionVersion!==connectionVersion)return;
   for(const room of rooms)if(room.root.isConnected&&this.roomViews.get(room.root)===room.view&&this.viewCleanup.get(room.root)===room.cleanup)room.view.retainActiveRoomAfterScopePreparation(room.link,documentId);
  };
 }
 private prepareChatOperation(root:HTMLElement,documentRootId:string,targetWorkId?:string,pageCurrent:()=>boolean=()=>true){
  const retainRooms=this.captureRoomScopeRetention(this.currentDocumentId());
  const originalRoomView=this.roomViews.get(root),originalRoom=originalRoomView?.activeLink,roomConnectionVersion=this.roomConnectionVersion;
  const operation=++this.chatScopePreparationVersion,documentId=this.currentDocumentId(),connection=this.connectionIdentity(),view=this.viewCleanup.get(root),selected=this.selectedConnectionId,confirmed=this.confirmedConnectionId;
  const targetIdentity=()=>{const target=this.selectedConnection();return target?JSON.stringify([target.id,target.kind,target.profile,target.installId]):'';},identity=targetIdentity();
  let workId=this.workController.currentWorkId,scene=this.chatScopeKey(),generation=this.workLoadSeq,navigation=this.workController.navigationVersion,expectedRoom=originalRoom,scopePreparing=true;
  const isCurrent=()=>!this.disposed&&pageCurrent()&&!this.settingsSaving&&!this.ekkoSettings.isPairing&&this.roomConnectionVersion===roomConnectionVersion&&operation===this.chatScopePreparationVersion&&this.roomViews.get(root)===originalRoomView&&(!scopePreparing||originalRoomView?.activeLink===expectedRoom)&&root.isConnected&&this.roomViews.has(root)&&this.viewCleanup.get(root)===view&&this.currentDocumentId()===documentId&&this.connectionIdentity()===connection&&this.selectedConnectionId===selected&&this.confirmedConnectionId===confirmed&&targetIdentity()===identity&&this.workController.navigationVersion===navigation&&this.workController.currentWorkId===workId&&this.chatScopeKey()===scene&&this.workLoadSeq===generation;
  const beforeSceneChange=(owner:string|null)=>{
   if(!isCurrent())throw new Error('文档、连接或视图已变化，请重新操作');
   // Only the controller's proven transition may own one scene load. An external
   // reload during that load increments the version again and invalidates this action.
   workId=owner;scene=this.chatScopeKey(owner,documentRootId);generation++;expectedRoom=null;
  };
  const preparing=targetWorkId?Promise.resolve(targetWorkId):this.workController.prepareChatScope(documentRootId,{isCurrent,beforeSceneChange});
  // prepareChatScope increments navigation synchronously before its first read.
  navigation=this.workController.navigationVersion;
  const retainRoom=()=>{if(isCurrent())retainRooms();};
  const scope=preparing.then(owner=>{if(isCurrent()){retainRoom();scopePreparing=false;}return owner;},error=>{if(isCurrent()){retainRoom();scopePreparing=false;}throw error;});
  return {scope,isCurrent};
 }
 private chatScopeCurrent(workId:string|null,documentId:string){return !this.disposed&&this.workController.currentWorkId===workId&&(workId!==null||this.workController.activeDocumentId===documentId)&&this.currentDocumentId()===documentId;}
 private connectionIdentity(){return this.sessionMemory.connection(this.bridgeUrl,this.bridgeToken);}
 private rememberThreads(){if(this.threadConnection){const scope=this.sessionMemory.scope(this.threadWorkId,this.threadConnection);scope.threads=this.threads;scope.selected=this.activeThreadId;}}
 private saveDraft(root:HTMLElement){if(!this.activeDraft)return;const textarea=root.querySelector<HTMLTextAreaElement>('[data-composer] textarea');if(textarea)this.activeDraft.text=textarea.value;}
 private activateBridgeScope():void{
  const scopeId=this.chatScopeKey(),connection=this.connectionIdentity(),scope=this.sessionMemory.scope(scopeId,connection);
  // A verified Bridge commit must not leave editable inputs attached to the old private draft.
  // Keep frozen Chat identities available while their authoritative reread is pending; history stays private.
  if(!scope.threads.length){scope.threads=this.threads.map(thread=>({...thread,messages:[]}));scope.selected=this.activeThreadId;}
  this.threads=scope.threads;this.activeThreadId=this.threads.some(thread=>thread.id===scope.selected)?scope.selected:this.threads[0]?.id||'';
  this.threadWorkId=scopeId;this.threadConnection=connection;this.activateDraft();this.rememberThreads();
  for(const root of this.roomViews.keys()){this.renderThreads(root);this.renderMessages(root);}
 }
 private activateDraft(){
  if(!this.threadConnection){this.threadWorkId=this.chatScopeKey();this.threadConnection=this.connectionIdentity();this.rememberThreads();}
  this.activeDraft=this.sessionMemory.draft(this.chatScopeKey(),this.draftIdentity(),this.activeThreadId);
  this.references=this.activeDraft.references;
  this.workController.restoreContext(this.activeDraft.context);
  for(const root of this.roomViews.keys()){const textarea=root.querySelector<HTMLTextAreaElement>('[data-composer] textarea');if(textarea)textarea.value=this.activeDraft.text;this.renderReferences(root);this.closeMentionPicker(root);this.operationNotices.delete(root);this.statusRetry.delete(root);this.renderStatus(root);}
 }
 private refreshSessionViews(){this.rememberThreads();for(const root of this.roomViews.keys())this.renderThreads(root);this.workTab?.refresh();}
 private setScopePreparationStatus(root:HTMLElement,message:string):void {
  if(this.isHermesSurface(root))this.setStatus(root,message);else this.roomViews.get(root)?.showScopePreparationError(message);
 }
 private async associateRoom(targetWorkId?:string|null,pageCurrent:()=>boolean=()=>true,originRoot?:HTMLElement){
  if(document.querySelector('[data-room-association]'))return;
  const root=originRoot||this.showChatDock(),documentId=this.currentDocumentId(),retainRooms=this.captureRoomScopeRetention(this.currentDocumentId());
  const viewIdentity=this.roomViews.get(root),cleanup=this.viewCleanup.get(root),bridgeUrl=this.bridgeUrl,bridgeToken=this.bridgeToken,connectionVersion=this.roomConnectionVersion,originalRoom=viewIdentity?.activeLink;
  let workId=this.workController.currentWorkId,navigation=this.workController.navigationVersion,scene=this.chatScopeKey(),generation=this.workLoadSeq,expectedRoom=originalRoom,scopePreparing=true;
  const current=()=>!this.disposed&&pageCurrent()&&!this.settingsSaving&&!this.ekkoSettings.isPairing&&this.roomConnectionVersion===connectionVersion&&root.isConnected&&this.roomViews.get(root)===viewIdentity&&(!scopePreparing||viewIdentity?.activeLink===expectedRoom)&&this.viewCleanup.get(root)===cleanup&&this.currentDocumentId()===documentId&&this.bridgeUrl===bridgeUrl&&this.bridgeToken===bridgeToken&&this.workController.currentWorkId===workId&&this.workController.navigationVersion===navigation&&this.chatScopeKey()===scene&&this.workLoadSeq===generation;
  try {
   if(!isValidDocumentRootId(documentId))throw Error('请先打开一个思源文档');
   if(this.chatBusy()||this.pendingProposal||this.workController.isTransitioning||this.ekkoSettings.isPairing||[...this.roomViews.values()].some(view=>view.isSending))throw Error('请先完成当前生成、发送、修改或文档归属核对');
   if(targetWorkId!==undefined&&targetWorkId!==workId)throw Error('请先进入此 Work，再关联房间');
   const prepared=this.workController.prepareChatScope(documentId,{isCurrent:current,beforeSceneChange:owner=>{
    if(!current())throw Error('文档、连接或视图已变化，请重新关联');
    workId=owner;scene=this.chatScopeKey(owner,documentId);generation++;expectedRoom=null;
   }});
   navigation=this.workController.navigationVersion;
   const owner=await prepared;if(!current())return;
   if(targetWorkId!==undefined&&owner!==targetWorkId)throw Error('当前文档不属于所选 Work，请核对后再关联');
   workId=owner;
   retainRooms();
   scopePreparing=false;
  }catch(error){if(current()){retainRooms();this.setScopePreparationStatus(root,error instanceof Error?error.message:String(error));}return;}
  if(!current())return;
  const overlay=document.createElement('div');overlay.className='sac-room-association';overlay.dataset.roomAssociation='';
  overlay.innerHTML='<div role="dialog" aria-modal="true" aria-label="关联 EKKO 房间"><button type="button" data-close-room>关闭</button><section data-ekko-panel></section></div>';
  document.body.append(overlay);
  const close=()=>{view.dispose();overlay.remove();if(this.closeRoomAssociation===close)this.closeRoomAssociation=undefined;};
  const dialogCurrent=()=>current()&&overlay.isConnected&&this.closeRoomAssociation===close;
  const view=new EkkoRoomUI(overlay,{getBridgeIdentity:()=>JSON.stringify([this.connectionIdentity(),this.roomConnectionVersion]),openConnectionSettings:()=>{close();this.openSettings(root,'ekko');},client:()=>new EkkoBridgeClient({bridgeUrl,capabilityToken:bridgeToken}),store:this.roomStore,pendingStore:this.pendingRoomSendStore,getWorkId:()=>workId,getDocumentRootId:()=>documentId,availableSources:id=>this.roomAvailableSources(id),loadSource:source=>this.roomLoadSource(source),isCurrent:dialogCurrent,onChanged:()=>this.refreshSessionViews(),onOpenLink:async link=>{
   if(!dialogCurrent()||this.chatBusy()||this.pendingProposal||this.workController.isTransitioning)return;
   const active=this.roomViews.get(root);if(!active)throw Error('房间侧栏暂不可用，请重新打开');
   this.saveDraft(root);await active.enter();
   if(!dialogCurrent()||this.roomViews.get(root)!==active)return;
   await active.openRoom(link.roomId,link);
   if(dialogCurrent()&&this.roomViews.get(root)===active&&active.activeLink){close();this.renderThreads(root);}
  }});
  this.closeRoomAssociation=close;
  overlay.querySelector('[data-close-room]')!.addEventListener('click',close);
  await view.enter();
 }
 private mountQuickPicker(root:HTMLElement,shell:HTMLElement):void {
  const picker=new WorkQuickPicker(shell,{
   load:async()=>Promise.all((await this.workStore.listWorks()).map(async id=>{
    try{const work=await this.workService.readWork(id);return work?{id,title:work.title,goal:work.goal,status:work.status}:{id,title:id,goal:'',status:'',error:'Work 文档缺失或标记已移除，请核对'};}
    catch(error){return {id,title:id,goal:'',status:'',error:error instanceof Error?error.message:String(error)};}
   })),
   currentDocument:()=>{const id=this.currentDocumentId();if(!id)return null;return {id,title:readEditorDocumentTitle(this.currentEditor()?.protyle?.element)};},
   currentWork:()=>this.workController.currentWorkId,
   enter:async id=>{await this.workController.enterWork(id);this.showChatDock();},
   link:async(id,doc)=>{if(this.chatBusy()||this.pendingProposal)throw new Error('生成或待处理修改期间不能关联资料');await this.workService.linkExternalDocument(id,doc.id,true);},
   create:async()=>{const id=this.currentDocumentId();await this.workCreateForm.open(id?{documentId:id,title:await this.workHost.getDocumentTitle(id)}:null);},
   browse:()=>{void this.openWorkPage({kind:'home'});},
   status:message=>this.setStatus(root,message),
   confirm:message=>window.confirm(message),
  });
  this.quickPickers.set(root,picker);
 }
 private async restoreConnectionSettings():Promise<void>{
  const url=this.bridgeUrl,token=this.bridgeToken,selected=this.selectedConnectionId,confirmed=this.confirmedConnectionId;
  // Startup successes and failures may both finish after an explicit settings action.
  const current=()=>!this.disposed&&!this.settingsSaving&&this.bridgeUrl===url&&this.bridgeToken===token&&this.selectedConnectionId===selected&&this.confirmedConnectionId===confirmed;
  let settings:Record<string,unknown>;
  try{settings=await this.readPluginSettings();}catch(error){if(!current())return;throw error;}
  if(!current())return;
  if(settings.hermesConnectionId!==undefined&&!validConnectionId(settings.hermesConnectionId))throw Error('Hermes 连接偏好格式错误，请核对设置');
  this.bridgeUrl=resolveBridgeUrl(settings);this.bridgeToken=typeof settings.bridgeToken==='string'?settings.bridgeToken:'';
  this.confirmedConnectionId=settings.hermesConnectionId as string|undefined;this.selectedConnectionId=this.confirmedConnectionId||'serve-local';
  if(!this.bridgeToken){this.updateConnectionUI(false);return;}
  await this.refreshConnection();
 }
 private async readPluginSettings():Promise<Record<string,unknown>> {
  const settings=await this.loadData('settings');
  if(settings===undefined||settings===null||settings==='')return {};
  if(typeof settings!=='object'||Array.isArray(settings))throw new Error('插件设置格式错误，请先核对设置备份');
  return settings;
 }
 private async readWorkNotebookSetting():Promise<string> {
  const settings=await this.readPluginSettings();
  this.defaultWorkNotebookId=typeof settings.defaultWorkNotebookId==='string'?settings.defaultWorkNotebookId:'';
  return this.defaultWorkNotebookId;
 }
 private settingsGuard(expectedChat?:()=>string){
  const url=this.bridgeUrl,token=this.bridgeToken,selected=this.selectedConnectionId,confirmed=this.confirmedConnectionId,documentId=this.currentDocumentId(),workId=this.workController.currentWorkId,navigation=this.workController.navigationVersion,chatId=this.activeThreadId;
  return ()=>!this.disposed&&this.bridgeUrl===url&&this.bridgeToken===token&&this.selectedConnectionId===selected&&this.confirmedConnectionId===confirmed&&this.currentDocumentId()===documentId&&this.workController.currentWorkId===workId&&this.workController.navigationVersion===navigation&&this.activeThreadId===(expectedChat?expectedChat():chatId)&&!this.sendInFlight&&!this.preparing&&!this.abortController&&!this.accepting&&!this.pendingProposal&&!this.workController.isTransitioning&&!this.ekkoSettings.isPairing&&![...this.roomViews.values()].some(view=>view.isSending);
 }
 private async inspectSettingsBridge(url:string,detect=false):Promise<BridgeInspection>{
  return this.inspectSettingsCandidate({url,token:'',detect},()=>true);
 }
 private async inspectSettingsCandidate(input:BridgeSettingsInput,isCurrent:()=>boolean):Promise<BridgeInspection>{
  const pluginCurrent=this.settingsGuard(),current=()=>pluginCurrent()&&isCurrent();
  if(this.settingsSaving||!current())throw Object.assign(Error('请先完成当前操作，再检测连接'),{saveOutcome:'stale'});
  if(input.connectionId&&!validConnectionId(input.connectionId))throw Object.assign(Error('请选择检测到的有效服务'),{saveOutcome:'failed'});
  const config={selectedConnectionId:input.connectionId||this.confirmedConnectionId,bridgeUrl:input.url||this.bridgeUrl,capabilityToken:input.token||this.bridgeToken};
  const result=await(input.detect?detectLocalBridge(config,fetch,current):inspectLocalBridge(config,fetch,current));
  if(!current())throw Object.assign(Error('文档、连接偏好或操作状态已变化，请重新检测'),{saveOutcome:'stale'});
  return {...result,saveOutcome:'not-requested'};
 }
 private async connectSettingsBridge(input:BridgeSettingsInput,isCurrent:()=>boolean=()=>true):Promise<BridgeInspection>{
  const pluginCurrent=this.settingsGuard(),current=()=>pluginCurrent()&&isCurrent();
  if(this.settingsSaving||!current())throw Object.assign(Error('请先完成当前生成、发送、导航或配对，再更改连接'),{saveOutcome:'stale'});
  if(input.connectionId&&!validConnectionId(input.connectionId))throw Object.assign(Error('请选择检测到的有效服务'),{saveOutcome:'failed'});
  const originalUrl=this.bridgeUrl,originalToken=this.bridgeToken,originalPreference=this.confirmedConnectionId;
  const candidateToken=input.token||originalToken;
  this.roomConnectionVersion++;this.settingsSaving=true;let writeStarted=false,changed=false,result:BridgeInspection|undefined;
  const check=()=>{if(!current())throw Object.assign(Error(writeStarted?'设置可能已写入，但当前状态已变化；请重新打开设置核对，未切换当前会话':'文档、连接偏好或操作状态已变化，候选连接未保存，请重新核对'),{saveOutcome:writeStarted?'unknown':'stale'});};
  try{
   check();
   const config={selectedConnectionId:input.connectionId||originalPreference,bridgeUrl:checkedBridgeUrl(input.url||originalUrl),capabilityToken:candidateToken};
   result=await(input.detect?detectLocalBridge(config,fetch,current):inspectLocalBridge(config,fetch,current));check();
   if(!result.bridgeAuthenticated)return {...result,saveOutcome:'failed'};
   const saved=await this.readPluginSettings();check();
   if((typeof saved.bridgeToken==='string'&&saved.bridgeToken!==originalToken)||(typeof saved.bridgeUrl==='string'&&resolveBridgeUrl(saved)!==originalUrl)||saved.hermesConnectionId!==originalPreference)throw Error('连接设置或已保存偏好已变化，候选连接未保存，请重新核对');
   const candidate=result.connections?.find(v=>v.id===input.connectionId);
   // Legacy remains an explicit association destination, never a new-chat capability.
   const explicitLegacy=candidate?.kind==='legacy-api'&&['ready','configured'].includes(candidate.state);
   const preference=result.hermesReady||explicitLegacy?result.selectedConnectionId:originalPreference;
   const next={...saved,bridgeUrl:result.url,bridgeToken:candidateToken,...(preference?{hermesConnectionId:preference}:{})};
   check();writeStarted=true;
   await this.saveData('settings',next);check();
   const readback=await this.readPluginSettings();check();
   if(readback.bridgeUrl!==result.url||readback.bridgeToken!==candidateToken||readback.hermesConnectionId!==preference)throw Error('设置写入结果未确认，请重新打开设置核对，未切换当前会话');
   changed=result.url!==originalUrl||candidateToken!==originalToken;
   this.rememberThreads();for(const root of this.roomViews.keys())this.saveDraft(root);
   this.bridgeUrl=result.url;this.bridgeToken=candidateToken;
   if(preference){this.confirmedConnectionId=preference;this.selectedConnectionId=preference;}
   result={...result,saveOutcome:result.hermesReady||explicitLegacy?'saved':'bridge-only',message:`${result.message}。Bridge 配对已保存；${result.hermesReady||explicitLegacy?'新建与关联目标已保留或确认':'尚未确认可用的新建目标，请核对服务后再确认'}`};
   this.connectionViews=result.connections||this.connectionViews;this.connectionOk=this.currentConnectionReady();this.connectionText=result.message;
   if(changed){++this.historyVersion;++this.workLoadVersion;this.closeAssociation();for(const view of this.roomViews.values())view.connectionChanged();this.activateBridgeScope();}
  }catch(error){
   const outcome=writeStarted?'unknown':(error as {saveOutcome?:string})?.saveOutcome||'failed';
   if(writeStarted)throw Object.assign(Error('设置保存结果未确认；请核对已保存设置，不要重复提交；未切换当前会话'),{saveOutcome:outcome});
   throw Object.assign(error instanceof Error?error:Error('连接确认未完成，请重新核对'),{saveOutcome:outcome});
  }finally{this.settingsSaving=false;}
  // A verified Bridge change restores that private scope; only its own Chat selection may change.
  let expectedChat=this.activeThreadId;
  const committedCurrent=this.settingsGuard(()=>expectedChat),currentCommitted=()=>committedCurrent()&&isCurrent();
  if(changed){
   if(!currentCommitted())throw Object.assign(Error('设置已保存，页面已变化；请重新核对连接'),{saveOutcome:'unknown'});
   try{await this.onWorkChanged(this.workController.currentWorkId,currentCommitted,chatId=>{expectedChat=chatId;});}catch{throw Object.assign(Error('设置已保存，会话范围读取未完成；请核对连接，未回写旧设置'),{saveOutcome:'unknown'});}
   if(!currentCommitted())throw Object.assign(Error('设置已保存，页面已变化；未更新原页面结果'),{saveOutcome:'unknown'});
  }
  for(const root of this.roomViews.keys()){this.renderConnectionChoices(root);this.renderConnection(root);this.renderStatus(root);}
  this.workTab?.refresh();return result!;
 }
 private async rememberSettingsInspection(run:()=>Promise<BridgeInspection>,current:()=>boolean,confirming=false):Promise<BridgeInspection>{
  const version=++this.settingsReportVersion;
  try{
   const result=await run();
   if(version===this.settingsReportVersion&&current()){
    const resolved=confirming&&(result.saveOutcome==='saved'||result.saveOutcome==='bridge-only');
    if(resolved)this.lastVerifiedSettingsWriteVersion=version;
    // A fresh read proves service state, never the outcome of an earlier unknown write.
    this.lastSettingsSaveOutcome=this.lastSettingsSaveOutcome==='unknown'&&!resolved?'unknown':result.saveOutcome;
    this.lastSettingsInspection=result;this.lastSettingsReportVersion=version;
   }
   return result;
  }catch(error){
   const outcome=(error as {saveOutcome?:BridgeInspection['saveOutcome']})?.saveOutcome;
   // Only a newer verified write resolves uncertainty; a newer blocked check cannot.
   const writeUnknown=outcome==='unknown'&&version>this.lastVerifiedSettingsWriteVersion;
   if(writeUnknown)this.lastSettingsSaveOutcome='unknown';
   // Keep newer read evidence, while remembering an older write's still-unknown outcome.
   if((version===this.settingsReportVersion&&current())||(writeUnknown&&version>this.lastSettingsReportVersion)){
    this.lastSettingsSaveOutcome=this.lastSettingsSaveOutcome==='unknown'?'unknown':outcome;
    this.lastSettingsInspection=error instanceof BridgeInspectionError?{url:'',message:'',bridgeAuthenticated:false,hermesReady:false,evidence:error.evidence,saveOutcome:this.lastSettingsSaveOutcome||'not-requested'}:null;
    this.lastSettingsReportVersion=version;
   }
   throw error;
  }
 }
 private openSettings(root:HTMLElement,pane:'work'|'hermes'|'ekko'='work'):void {
  if(this.settingsDialog?.isBusy)return;
  this.settingsDialog?.dispose();
  this.settingsDialog=new SettingsDialog(document,{
   bridgeUrl:()=>this.bridgeUrl,bridgeStatus:()=>this.connectionText,
   pluginVersion:()=>pluginManifest.version,confirmedKind:()=>this.connectionViews.find(view=>view.id===this.confirmedConnectionId)?.kind||null,lastInspection:()=>this.lastSettingsInspection,lastSaveOutcome:()=>this.lastSettingsSaveOutcome,
   connections:()=>this.connectionViews,currentConnection:()=>this.confirmedConnectionId||'',
   save:async()=>{throw Error('请使用确认连接保存设置');},
   inspectBridge:(input,current)=>this.rememberSettingsInspection(()=>this.inspectSettingsCandidate(input,current),current),
   connectBridge:(input,current)=>this.rememberSettingsInspection(()=>this.connectSettingsBridge(input,current),current,true),
   defaultNotebookId:()=>this.defaultWorkNotebookId,
   listNotebooks:async()=>{await this.readWorkNotebookSetting();return this.workHost.listNotebooks();},
   saveDefaultNotebook:async id=>{
    if(id&&!(await this.workHost.listNotebooks()).some(n=>n.id===id))throw new Error('请选择一个已打开的笔记本');
    const saved=await this.readPluginSettings();
    await this.saveData('settings',{...saved,defaultWorkNotebookId:id});
    this.defaultWorkNotebookId=id;
   },
   checkBridge:async url=>(await this.inspectSettingsBridge(url)).message,
   detectBridge:()=>this.inspectSettingsBridge(this.bridgeUrl,true),
   checkEkko:()=>this.ekkoSettings.check(),pairEkko:input=>this.ekkoSettings.pair(input),
   pairingUnknown:()=>this.ekkoSettings.unknown,clearPairingUnknown:()=>this.ekkoSettings.clearUnknown(),
  });
  this.settingsDialog.open(root,pane);
 }
 private isHermesSurface(root:HTMLElement){const shell=root.matches('.sac')?root:root.querySelector<HTMLElement>('.sac');return shell?.dataset.surface!=='ekko';}
 private renderStatus(root:HTMLElement){
  const inChat=this.isHermesSurface(root),pending=inChat?this.activeDraft?.pending:undefined,retry=inChat?this.statusRetry.get(root):undefined;
  const text=this.operationNotices.get(root)||(!this.connectionOk?this.connectionText:'');
  const detail=!inChat?'':pending?pending.message+(this.operationNotices.get(root)?`\n${this.operationNotices.get(root)}`:''):text;
  root.querySelector<HTMLElement>('[data-action="review-send"]')?.toggleAttribute('hidden',!pending);
  root.querySelector<HTMLElement>('[data-action="confirm-send-reviewed"]')?.toggleAttribute('hidden',!pending);
  const el=root.querySelector<HTMLElement>('[data-status]'),alert=root.querySelector<HTMLElement>('[data-status-alert]');
  if(el)el.textContent=detail;if(alert)alert.toggleAttribute('hidden',!detail&&!root.querySelector<HTMLElement>('[data-pending-chats]')?.textContent);
  const retryButton=root.querySelector<HTMLButtonElement>('[data-action="retry-connection"]');
  if(retryButton){retryButton.hidden=Boolean(pending)||!detail||(!retry&&!(text.startsWith('Hermes · 未连接')&&Boolean(this.bridgeToken)));retryButton.disabled=false;retryButton.textContent=retry?'重试读取对话':'重连';retryButton.setAttribute('aria-label',retry?'重新读取 Hermes 对话':'重新连接 Hermes');}
 }
 private async reviewSend(root:HTMLElement):Promise<void>{
  const draft=this.activeDraft,thread=this.ensureThread();if(!this.isHermesSurface(root)||!draft?.pending||!thread||this.chatBusy())return;
  const button=root.querySelector<HTMLButtonElement>('[data-action="review-send"]')!;if(button.disabled)return;button.disabled=true;
  let reviewVersion=this.historyVersion;
  const current=()=>this.historyVersion===reviewVersion&&this.isHermesSurface(root)&&this.activeDraft===draft&&this.roomViews.has(root);
  try{const reading=this.loadThreadMessages(thread);reviewVersion=this.historyVersion;if(await reading===false)return;if(current()){this.operationNotices.delete(root);this.renderMessages(root);this.renderStatus(root);}}
  catch(error){if(current())this.setStatus(root,`原会话读取失败：${connectionFailureMessage(error)}`);}
  finally{if(this.roomViews.has(root))button.disabled=false;}
 }
 private async retryStatus(root:HTMLElement):Promise<void>{
  const button=root.querySelector<HTMLButtonElement>('[data-action="retry-connection"]');
  if(!this.isHermesSurface(root)||!button||button.hidden||button.disabled)return;
  const retry=this.statusRetry.get(root);
  button.disabled=true;
  try{if(retry)await retry();else await this.refreshConnection();}
  catch(error){this.setStatus(root,`重连失败：${connectionFailureMessage(error)}`,retry);}
  finally{if(this.roomViews.has(root))button.disabled=false;}
 }
 private async selectSession(root:HTMLElement){
  const value=root.querySelector<HTMLSelectElement>('[data-thread-selector]')!.value;
  const choice=this.sessionRows.get(root)?.find(row=>sessionKey(row)===value);if(!choice)return;
  if(choice.kind==='hermes'){await this.selectChat(root,choice.link.chatId,choice.link.connectionId);return;}
  if(this.chatBusy()||this.pendingProposal||this.workController.isTransitioning){this.setStatus(root,'请先处理正在生成或待接受的建议');this.renderThreads(root);return;}
  const view=this.roomViews.get(root),documentId=this.currentDocumentId(),navigation=this.workController.navigationVersion,bridge=this.connectionIdentity();this.saveDraft(root);await view?.enter();if(this.disposed||this.roomViews.get(root)!==view||this.currentDocumentId()!==documentId||this.workController.navigationVersion!==navigation||this.connectionIdentity()!==bridge)return;await view?.openRoom(choice.link.roomId,choice.link);this.renderThreads(root);
 }
 private renderChatViews(origin?:HTMLElement){
  if(this.disposed)return;
  const roots=new Set(this.roomViews.keys());
  for(const root of roots){this.renderMessages(root);this.renderReferences(root);}
 }
 private messageRenderers=new WeakMap<HTMLElement,MessageRenderer<any>>();
 private async restoreDurableNotice(isCurrent:()=>boolean=()=>true){const draft=this.activeDraft,chatId=this.activeThreadId,identity=this.draftIdentity();if(!draft)return;try{const pending=(await this.workStore.listPending()).find(item=>item.id===`chat-run:${chatId}`);if(!isCurrent()||this.disposed||this.activeDraft!==draft||identity!==this.draftIdentity())return;if(pending)draft.pending={kind:'unknown',message:pending.details};for(const root of this.roomViews.keys())this.renderStatus(root);}catch{if(isCurrent()&&this.activeDraft===draft){draft.pending={kind:'unknown',message:'未决请求记录无法读取，请核对后继续'};for(const root of this.roomViews.keys())this.renderStatus(root);}}}
 private draftIdentity(t=this.threads.find(x=>x.id===this.activeThreadId),connection=this.connectionIdentity()){return JSON.stringify([connection,t?.connectionId,t?.adapter,t?.profile,t?.installId]);}
 private sessionChat(t:ChatThread,workId:string|null):SessionChat{return {workId,chatId:t.id,documentRootId:t.documentRootId,connectionId:t.connectionId||'unresolved',adapter:t.adapter,profile:t.profile,installId:t.installId||null,storedSessionId:t.storedSessionId||null,title:t.title,state:t.state,local:!t.connectionId};}
 private async listSessionChats(workId:string):Promise<SessionChat[]>{const links=await this.workStore.listChats(workId);const threads=this.threadWorkId===workId?this.threads:this.sessionMemory.scope(workId,this.connectionIdentity()).threads;return links.map(link=>({...link,title:threads.find(t=>t.id===link.chatId&&t.connectionId===link.connectionId)?.title||link.title}));}
 private async readBlockMarkdown(id:string){return parseKramdownResponse(await this.api('/api/block/getBlockKramdown',{id}));}
 private async api(path:string,body:Record<string,unknown>){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(`SiYuan API ${r.status}`);const d:any=await r.json();if(d.code!==0)throw new Error(d.msg||'SiYuan API error');return d.data;}
}
function escapeHtml(value:string){return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
