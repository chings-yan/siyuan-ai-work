import {renderConnectionChoices} from '../ui.ts';
import type {ConnectionView} from '../bridge.ts';
import {trapDialogKey} from './dialog-focus.ts';
import {STUDIO_PARTIAL_READ_NOTICE,BridgeInspectionError,connectionAdvice,connectionLabel,type BridgeInspection,type BridgeSettingsInput} from './connection-settings.ts';
import {connectionHelp} from './connection-help.ts';
import {buildConnectionDiagnostic,authorizationRecordState,parseAuthorizationRecord,type ConnectionKind,type ReportContext,type SaveOutcome} from './connection-report.ts';
import type { EkkoConnection } from '../ekko/bridge.ts';
const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
type Pane='work'|'hermes'|'ekko';
type SettingsActions={
  pluginVersion?():string;confirmedKind?():ConnectionKind|null;lastInspection?():BridgeInspection|null;lastSaveOutcome?():SaveOutcome|undefined;
  connections?():ConnectionView[];currentConnection?():string;selectConnection?(id:string):void;
  bridgeUrl():string;bridgeStatus():string;save(url:string):Promise<void>;
  inspectBridge?(input:BridgeSettingsInput,isCurrent:()=>boolean):Promise<BridgeInspection>;
  connectBridge?(input:BridgeSettingsInput,isCurrent:()=>boolean):Promise<BridgeInspection>;
  checkBridge?(url:string):Promise<string>;detectBridge?():Promise<{url:string;message:string}>;
  checkEkko?():Promise<EkkoConnection|null>;pairEkko?(input:{baseUrl:string;username:string;password:string}):Promise<EkkoConnection>;
  pairingUnknown?():boolean;clearPairingUnknown?():void;
  defaultNotebookId?():string;listNotebooks?():Promise<{id:string;name:string}[]>;saveDefaultNotebook?(id:string):Promise<void>;
};

export class SettingsDialog {
  private overlay?:HTMLElement;
  private busy=false;
  private busyOwner?:symbol;
  private notebooksReady=false;
  private returnFocus?:HTMLElement;
  private pane:Pane='work';
  private requestVersion=0;
  private pairingUnknown=false;
  private inspection:BridgeInspection|null=null;
  private freshness:ReportContext['freshness']='unconfirmed';
  private saveOutcome:SaveOutcome='unknown';
  private saveUncertain=false;
  get isBusy():boolean{return this.busy;}
  constructor(private readonly doc:Document,private readonly actions:SettingsActions){}
  open(_source:HTMLElement,pane:Pane='work'):void {
    if(this.overlay){this.overlay.querySelector<HTMLElement>('[data-settings-action="close"]')?.focus();return;}
    this.returnFocus=_source.ownerDocument.activeElement instanceof (_source.ownerDocument.defaultView as any).HTMLElement?_source.ownerDocument.activeElement as HTMLElement:_source;
    this.notebooksReady=false;this.pane='work';this.pairingUnknown=this.actions.pairingUnknown?.()||false;
    this.inspection=this.actions.lastInspection?.()||null;this.freshness=this.inspection?'previous':'unconfirmed';this.saveOutcome=this.actions.lastSaveOutcome?.()||this.inspection?.saveOutcome||'unknown';this.saveUncertain=this.actions.lastSaveOutcome?.()==='unknown';
    const connections=this.inspection?.connections||(this.saveUncertain?[]:this.actions.connections?.());
    const overlay=this.doc.createElement('div');overlay.className='sac-settings-overlay';overlay.tabIndex=-1;
    overlay.innerHTML=`<section class="sac-settings-dialog" role="dialog" aria-modal="true" aria-label="AI Work 设置"><header><h2>AI Work 设置</h2><button type="button" data-settings-action="close" aria-label="关闭设置">×</button></header><div class="sac-settings-layout"><nav aria-label="设置分类"><button type="button" data-settings-action="work" aria-current="page">工作文档</button><button type="button" data-settings-action="hermes">Hermes 连接</button><button type="button" data-settings-action="ekko">EKKO 连接</button></nav><main><p role="alert" data-settings-error hidden></p>
      <section data-settings-pane="work"><h3>Work 默认保存位置</h3><label>新建工作文档的笔记本<select data-setting="defaultNotebook" disabled><option value="">跟随打开主页前的文档</option></select></label><p>新文档保存在所选笔记本根目录；创建表单仍可临时改选。使用现有文档时保留其原位置。</p><button type="button" data-settings-action="save-location" disabled>保存默认位置</button><p data-location-info>正在读取笔记本…</p></section>
      <section data-settings-pane="hermes" hidden><h3>连接 Hermes</h3><details data-connection-step="companion" open><summary>1. 准备本机配套</summary><p>配套需要 Node.js 24；已有 Bridge 可直接核对。</p><button type="button" data-settings-action="help-companion">查看准备与启动说明</button></details><details data-connection-step="pairing" open><summary>2. 配对本机 Bridge</summary>
        <label>Bridge 配对凭证<input data-setting="bridgeToken" aria-label="Bridge 配对凭证" type="password" autocomplete="new-password" maxlength="4096" placeholder="已配对可留空；只在更换时输入"></label><p>首次使用：运行 Bridge 配套包的 setup / pair 脚本，在本机打开生成的凭证文件并复制到这里。已有凭证不会显示。</p>
        <button type="button" data-settings-action="help-pairing">查看 Bridge 配对说明</button></details><details data-connection-step="service" open><summary>3. 选择 Hermes 服务</summary>
        <button type="button" data-settings-action="detect-bridge">重新检测</button>
        <p class="sac-settings-secondary" data-hermes-results-label></p><ul data-hermes-results hidden aria-label="Hermes 检测结果"></ul>
        ${this.actions.connections?`<label>新建与关联的 Hermes 连接<select data-setting="hermesConnection">${renderConnectionChoices(connections||[],this.actions.currentConnection?.())}</select></label><p class="sac-settings-secondary">选好后点击“确认连接”保存。仅用于新建和关联；已有 Chat 保留原连接身份。</p>`:''}
        <p class="sac-settings-secondary" data-hermes-authorization>有效期由原服务管理；当前未提供。</p></details><details data-connection-step="result" open><summary>4. 确认连接结果</summary><p class="sac-settings-status" data-bridge-status role="status"></p><button class="sac-settings-primary" type="button" data-settings-action="confirm-bridge">确认连接</button></details>
        <details class="sac-settings-help" data-settings-help="maintenance"><summary>授权维护与服务说明</summary><button type="button" data-settings-action="help-serve">Hermes 服务维护说明</button><button type="button" data-settings-action="help-studio">Studio 维护说明</button><button type="button" data-settings-action="help-legacy-api">旧会话服务说明</button></details>
        <details class="sac-settings-help" data-settings-help="diagnostics"><summary>配套信息与诊断</summary><p data-companion-info></p><button type="button" data-settings-action="view-diagnostic">查看诊断摘要</button><div data-diagnostic-panel hidden><pre data-diagnostic-preview tabindex="0" aria-label="诊断摘要白名单预览"></pre><button type="button" data-settings-action="copy-diagnostic">复制诊断摘要</button><p data-diagnostic-status role="status"></p></div></details>
        <details class="sac-settings-advanced"><summary>高级配置 · 本机 Bridge 地址</summary><label>本机 Hermes Bridge 地址<input data-setting="baseUrl" aria-label="Bridge 地址" type="url" value="${esc(this.actions.bridgeUrl())}" placeholder="http://127.0.0.1:8782"></label><p>127.0.0.1 表示这台电脑；8782 是 Bridge 默认端口。只核对当前地址和默认地址。</p><button type="button" data-settings-action="check-bridge">测试此地址</button><button type="button" data-settings-action="save">核对并保存此地址</button></details>
        <details class="sac-settings-help" data-settings-help="usage"><summary>使用与连接说明</summary><p>普通文档可直接使用；持续工作可建立 Work。Hermes 与 EKKO 均可稍后连接。</p><p>先确认本机 Bridge 身份，再验证凭证。只有认证通过才保存。检测核验会话读取；生成与停止仍需实际操作确认。</p></details></section>
      <section data-settings-pane="ekko" hidden><h3>EKKO 账号连接</h3><p>EKKO 为独立可选连接，不影响 Hermes。</p><p data-ekko-status role="status">尚未核对账号连接</p><p data-ekko-authorization>未提供有效期；尚未核对。</p><button type="button" data-settings-action="help-ekko">查看授权维护说明</button><form data-settings-ekko-form hidden><label>EKKO Studio 本机服务地址<input data-ekko-setting="baseUrl" type="url" value="http://127.0.0.1:8748" required maxlength="128"></label><label>EKKO 账号<input data-ekko-setting="username" type="text" autocomplete="off" required maxlength="256"></label><label>本次密码<input data-ekko-setting="password" type="password" autocomplete="off" required maxlength="4096"></label><button type="submit" data-settings-action="pair-ekko" ${this.pairingUnknown?'disabled':''}>连接 EKKO</button></form><button type="button" data-settings-action="change-ekko" hidden>更换连接</button><button type="button" data-settings-action="check-ekko">核对当前连接</button><button type="button" data-settings-action="ack-pairing" ${this.pairingUnknown?'':'hidden'}>我已在 EKKO 核对，允许重新配对</button><p>8748 是当前本机 EKKO Studio 服务端口，与 Hermes Bridge 的 8782 不同。密码仅用于本次配对请求，不保存。配对成功后会显示已核对的账号；关联和进入房间仍在会话入口操作。</p></section>
      <section data-connection-help hidden aria-label="内置连接说明"></section></main></div><footer><button type="button" data-settings-action="later">稍后连接，继续整理文档/Work</button></footer></section>`;
    overlay.addEventListener('input',this.candidateChanged);overlay.addEventListener('change',this.candidateChanged);overlay.addEventListener('click',this.click);overlay.addEventListener('keydown',this.keydown);overlay.addEventListener('submit',this.submit);
    this.doc.body.appendChild(overlay);this.overlay=overlay;overlay.querySelector<HTMLElement>('[data-settings-action="work"]')?.focus();
    this.showHermesResults(overlay,connections);this.showInspection(overlay,true);
    if(pane!=='work')overlay.querySelector<HTMLButtonElement>(`[data-settings-action="${pane}"]`)?.click();
    void this.loadNotebooks(overlay);
  }
  private async loadNotebooks(overlay:HTMLElement):Promise<void>{
    const info=overlay.querySelector<HTMLElement>('[data-location-info]')!;
    try{
      if(!this.actions.listNotebooks||!this.actions.saveDefaultNotebook){info.textContent='默认保存位置暂不可配置';return;}
      const notebooks=await this.actions.listNotebooks();if(this.overlay!==overlay)return;
      const selected=this.actions.defaultNotebookId?.()||'',select=overlay.querySelector<HTMLSelectElement>('[data-setting="defaultNotebook"]')!;
      select.innerHTML=`<option value="">跟随打开主页前的文档；无文档时手动选择</option>${notebooks.map(n=>`<option value="${esc(n.id)}">${esc(n.name)} · 根目录</option>`).join('')}${selected&&!notebooks.some(n=>n.id===selected)?`<option value="${esc(selected)}">原默认笔记本暂不可用 · ${esc(selected)}</option>`:''}`;
      select.value=selected;this.notebooksReady=true;this.syncControls(overlay);
      info.textContent=selected&&!notebooks.some(n=>n.id===selected)?'请重新选择一个已打开的笔记本。':'';
    }catch(error){if(this.overlay===overlay){info.textContent=`笔记本读取失败：${error instanceof Error?error.message:String(error)}`;info.setAttribute('role','alert');}}
  }
  close():void {
    if(this.busy)return;
    this.requestVersion++;this.overlay?.removeEventListener('input',this.candidateChanged);this.overlay?.removeEventListener('change',this.candidateChanged);this.overlay?.removeEventListener('click',this.click);this.overlay?.removeEventListener('keydown',this.keydown);this.overlay?.removeEventListener('submit',this.submit);this.overlay?.remove();this.overlay=undefined;this.returnFocus?.isConnected&&this.returnFocus.focus();this.returnFocus=undefined;
  }
  dispose():void{this.busyOwner=undefined;this.busy=false;this.close();}
  private candidateChanged=(event:Event)=>{if((event.target as Element).matches('[data-setting="baseUrl"],[data-setting="bridgeToken"],[data-setting="hermesConnection"]')){this.requestVersion++;if(this.overlay){this.freshness=this.inspection?'previous':'unconfirmed';this.showInspection(this.overlay);}}};
  private candidate(overlay:HTMLElement,detect:boolean):BridgeSettingsInput{return {url:overlay.querySelector<HTMLInputElement>('[data-setting="baseUrl"]')!.value,token:overlay.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!.value,detect,connectionId:overlay.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')?.value||undefined};}
  private keydown=(event:KeyboardEvent)=>{if(this.overlay)trapDialogKey(event,this.overlay,this.busy,()=>this.close());};
  private submit=(event:Event)=>{if((event.target as Element).matches('[data-settings-ekko-form]')){event.preventDefault();const button=this.overlay?.querySelector<HTMLButtonElement>('[data-settings-action="pair-ekko"]');if(button&&!button.disabled)void this.perform(button);}};
  private switchPane(pane:Pane):void {
    this.pane=pane;this.requestVersion++;this.freshness=this.inspection?'previous':'unconfirmed';this.showInspection(this.overlay!);
    for(const section of this.overlay!.querySelectorAll<HTMLElement>('[data-settings-pane]'))section.hidden=section.dataset.settingsPane!==pane;
    for(const button of this.overlay!.querySelectorAll<HTMLElement>('nav button'))if(button.dataset.settingsAction===pane)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    this.overlay!.querySelector<HTMLElement>('[data-settings-error]')!.hidden=true;
  }
  private click=(event:Event)=>{
    if(event.target===this.overlay){if(!this.busy)this.close();return;}
    const button=(event.target as Element).closest<HTMLButtonElement>('[data-settings-action]');if(!button||button.disabled||this.busy)return;
    const action=button.dataset.settingsAction;
    if(action==='later'){this.close();return;}
    if(action?.startsWith('help-')){
      const key=action.slice(5) as keyof typeof connectionHelp;if(!Object.hasOwn(connectionHelp,key))return;
      const help=connectionHelp[key],panel=this.overlay!.querySelector<HTMLElement>('[data-connection-help]')!;
      const title=this.doc.createElement('h3');title.textContent=help.title;panel.replaceChildren(title,...help.paragraphs.map(text=>{const p=this.doc.createElement('p');p.textContent=text;return p;}));panel.hidden=false;return;
    }
    if(action==='view-diagnostic'){this.previewDiagnostic(this.overlay!);return;}
    if(action==='copy-diagnostic'){void this.copyDiagnostic(this.overlay!);return;}
    if(action==='close'){this.close();return;}
    if(action==='work'||action==='hermes'||action==='ekko'){
      this.switchPane(action);
      if(action==='ekko'){const check=this.overlay!.querySelector<HTMLButtonElement>('[data-settings-action="check-ekko"]')!;if(!check.disabled)void this.perform(check);}
      return;
    }
    if(action==='change-ekko'){this.overlay!.querySelector<HTMLFormElement>('[data-settings-ekko-form]')!.hidden=false;this.overlay!.querySelector<HTMLInputElement>('[data-ekko-setting="username"]')?.focus();button.hidden=true;return;}
    if(action==='pair-ekko'){event.preventDefault();}
    void this.perform(button);
  };
  private syncControls(overlay:HTMLElement):void{
    for(const control of overlay.querySelectorAll<HTMLInputElement|HTMLButtonElement|HTMLSelectElement>('input,button,select'))control.disabled=this.busy;
    overlay.querySelector<HTMLSelectElement>('[data-setting="defaultNotebook"]')!.disabled=this.busy||!this.notebooksReady;
    overlay.querySelector<HTMLButtonElement>('[data-settings-action="save-location"]')!.disabled=this.busy||!this.notebooksReady;
    this.showPairingState(overlay);
  }
  private showPairingState(overlay:HTMLElement):void{
    overlay.querySelector<HTMLButtonElement>('[data-settings-action="pair-ekko"]')!.disabled=this.busy||this.pairingUnknown;
    overlay.querySelector<HTMLElement>('[data-settings-action="ack-pairing"]')!.hidden=!this.pairingUnknown;
  }
  private diagnostic(){
    const selected=this.overlay?.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]')?.value;
    const candidate=this.inspection?.connections?.find(view=>view.id===selected);
    return buildConnectionDiagnostic(this.inspection,{pluginVersion:this.actions.pluginVersion?.()||'',freshness:this.freshness,candidateKind:candidate?.kind||null,confirmedKind:this.actions.confirmedKind?.()||null,saveOutcome:this.saveOutcome});
  }
  private previewDiagnostic(overlay:HTMLElement):void{
    overlay.querySelector<HTMLElement>('[data-diagnostic-preview]')!.textContent=JSON.stringify(this.diagnostic(),null,2);
    overlay.querySelector<HTMLElement>('[data-diagnostic-panel]')!.hidden=false;
    overlay.querySelector<HTMLElement>('[data-diagnostic-status]')!.textContent='仅含白名单字段；复制不上传，也不额外读取服务。';
  }
  private async copyDiagnostic(overlay:HTMLElement):Promise<void>{
    if(overlay.querySelector<HTMLElement>('[data-diagnostic-panel]')!.hidden)return;
    const preview=overlay.querySelector<HTMLElement>('[data-diagnostic-preview]')!,text=preview.textContent||'',status=overlay.querySelector<HTMLElement>('[data-diagnostic-status]')!;
    try{if(!this.doc.defaultView?.navigator.clipboard)throw Error();await this.doc.defaultView.navigator.clipboard.writeText(text);if(this.overlay===overlay&&preview.textContent===text)status.textContent='诊断摘要已复制';}
    catch{if(this.overlay===overlay&&preview.textContent===text){status.textContent='复制失败，请手动选择上方摘要并复制。';preview.focus();}}
  }
  private showHermesResults(overlay:HTMLElement,connections?:Array<Pick<ConnectionView,'kind'|'state'|'readWarning'>>):void{
    const list=overlay.querySelector<HTMLElement>('[data-hermes-results]')!;
    if(connections)list.replaceChildren(...connections.map(view=>{const item=this.doc.createElement('li');item.textContent=`${connectionLabel(view)}：${connectionAdvice(view)}`;return item;}));
    list.hidden=list.children.length===0;
    const report=this.diagnostic(),label=report.checkedAt?`${this.freshness==='current'?'本次检测':'上次检测'} · ${report.checkedAt}`:list.hidden?'尚未检测或未提供可核验的检测时间':'上次读取状态，检测时间未知（尚未提供可核验时间）';
    overlay.querySelector<HTMLElement>('[data-hermes-results-label]')!.textContent=`${label}；${list.hidden?'服务列表未知或未找到已配置服务':'认证与会话读取状态'}；非实时状态，点击“重新检测”更新。生成与停止仍需实际操作确认。`;
  }
  private showInspection(overlay:HTMLElement,collapse=false):void{
    let report=this.diagnostic();if(!report.checkedAt){this.freshness='unconfirmed';report=this.diagnostic();}
    this.showHermesResults(overlay,this.inspection?(report.bridgeAuthenticated===true?report.services:[]):this.saveUncertain?[]:undefined);
    overlay.querySelector<HTMLElement>('[data-diagnostic-panel]')!.hidden=true;
    const companion=report.companion;
    overlay.querySelector<HTMLElement>('[data-companion-info]')!.textContent=companion?`配套报告的版本：${companion.bridgeVersion||'未知'}；可识别能力：${companion.capabilities.join('、')||'未提供'}。仅为配套自报信息，不保证外部服务可用。`:'配套未提供可识别的能力信息；原有认证与读取核验独立判断。';
    const messages:Record<string,string>={invalid_address:'Bridge 地址无效，请核对本机地址',health_unreachable:'本机 Bridge 未响应，Hermes 状态未知；请查看启动说明',health_invalid:'该地址未通过 Bridge 健康核对',pairing_required:'已找到本机 Bridge；请填写配对凭据',pairing_rejected:'Bridge 配对凭据被拒绝；请核对原凭据',connections_http_error:'Bridge 认证核对失败，请核对后重试',connections_invalid:'Bridge 连接响应无效，服务列表未知',read_incomplete:'Bridge 认证核对未完成，服务列表未知'};
    const status=report.code==='ok'?`Bridge 已配对；已完成服务读取核对。${report.services.some(view=>view.readWarning==='studio_sessions_unresolved')?STUDIO_PARTIAL_READ_NOTICE:''}`:report.code?messages[report.code]:'尚未检测或结果未知，请重新检测。';
    const outcome:Record<SaveOutcome,string>={'not-requested':'只读检测，候选尚未保存。',saved:'新建与关联目标已保存；已有会话保留原身份。','bridge-only':'仅保存 Bridge 配对，尚未确认可用新建目标。',failed:'尚未保存，请核对后重试。',unknown:'保存结果未知，请先核对已保存设置，不要重复提交。',stale:'页面或候选已变化，请重新检测。'};
    overlay.querySelector<HTMLElement>('[data-bridge-status]')!.textContent=(this.freshness==='previous'?'上次检测结果（非实时）：':'')+status+' '+(this.inspection||this.saveUncertain?outcome[report.saveOutcome]:'');
    if(collapse)for(const name of ['companion','pairing'] as const)overlay.querySelector<HTMLDetailsElement>(`[data-connection-step="${name}"]`)!.open=report.bridgeAuthenticated!==true;
  }
  private showEkko(overlay:HTMLElement,connection:EkkoConnection|null):void{
    const now=Date.now(),record=parseAuthorizationRecord(connection?.authorization),expiry=authorizationRecordState(record,now);
    const status=expiry==='expired'?'签发记录已过期，本次未验证服务认证':connection?.state==='connected'?'已核对连接':'连接暂不可用，请核对应用访问权限';
    overlay.querySelector<HTMLElement>('[data-ekko-status]')!.textContent=(connection?`账号：${connection.accountName} · ${status}`:'尚未配对 EKKO，请输入自己的账号连接')+(this.pairingUnknown?'；上次配对结果仍未确认，请在 EKKO 核对应用连接':'');
    overlay.querySelector<HTMLElement>('[data-ekko-authorization]')!.textContent=(record?`签发记录有效至 ${new Date(record.expiresAt*1000).toISOString()}；${expiry==='expiring'?'七天内到期，请查看授权维护说明。':''}签发记录不代表实时认证，也不保证到期前始终可用。`:'未提供有效期。')+`核对时间：${new Date(now).toISOString()}`;
  }
  private async perform(button:HTMLButtonElement):Promise<void>{
    if(this.busy||!this.overlay)return;
    const overlay=this.overlay,action=button.dataset.settingsAction,version=++this.requestVersion;
    const snapshot=this.candidate(overlay,action==='detect-bridge'),owner=Symbol();
    const current=()=>this.overlay===overlay&&version===this.requestVersion&&JSON.stringify(this.candidate(overlay,snapshot.detect))===JSON.stringify(snapshot);
    const errorLine=overlay.querySelector<HTMLElement>('[data-settings-error]')!;errorLine.hidden=true;errorLine.textContent='';
    if(action==='save'||action==='confirm-bridge'||action==='detect-bridge'||action==='check-bridge'){this.freshness=this.inspection?'previous':'unconfirmed';this.showInspection(overlay);}
    this.busyOwner=owner;this.busy=true;this.syncControls(overlay);overlay.setAttribute('aria-busy','true');
    try{
      if((action==='save'||action==='confirm-bridge'||action==='detect-bridge'||action==='check-bridge')&&(this.actions.inspectBridge||this.actions.connectBridge)){
        const confirming=action==='save'||action==='confirm-bridge';
        const run=confirming?this.actions.connectBridge:this.actions.inspectBridge;
        if(!run)throw Error(confirming?'连接确认暂不可用':'只读连接检测暂不可用');
        const result=await run(snapshot,current);
        if(current()){
          overlay.querySelector<HTMLInputElement>('[data-setting="baseUrl"]')!.value=result.url;
          this.inspection=result;
          const resolved=confirming&&(result.saveOutcome==='saved'||result.saveOutcome==='bridge-only');
          this.saveOutcome=(this.saveUncertain||this.actions.lastSaveOutcome?.()==='unknown')&&!resolved?'unknown':result.saveOutcome||'not-requested';this.saveUncertain=this.saveOutcome==='unknown';this.freshness='current';
          if(confirming&&(result.saveOutcome==='saved'||result.saveOutcome==='bridge-only'))overlay.querySelector<HTMLInputElement>('[data-setting="bridgeToken"]')!.value='';
          const select=overlay.querySelector<HTMLSelectElement>('[data-setting="hermesConnection"]');
          if(result.bridgeAuthenticated&&result.connections){
            if(select)select.innerHTML=renderConnectionChoices(result.connections,result.selectedConnectionId||select.value);
          }
          this.showInspection(overlay,true);
        }
      }else if(action==='save'||action==='confirm-bridge'){
        throw Error('连接确认暂不可用，请先完成只读检测');
      }else if(action==='save-location'){
        if(!this.actions.saveDefaultNotebook)throw Error('默认保存位置暂不可配置');
        await this.actions.saveDefaultNotebook(overlay.querySelector<HTMLSelectElement>('[data-setting="defaultNotebook"]')!.value);
        if(current()){const info=overlay.querySelector<HTMLElement>('[data-location-info]')!;info.textContent='默认保存位置已保存';info.setAttribute('role','status');}
      }else if(action==='detect-bridge'){
        if(!this.actions.detectBridge)throw Error('本机连接检测暂不可用');const result=await this.actions.detectBridge();
        if(current()){overlay.querySelector<HTMLInputElement>('[data-setting="baseUrl"]')!.value=result.url;overlay.querySelector<HTMLElement>('[data-bridge-status]')!.textContent=result.message;}
      }else if(action==='check-bridge'){
        if(!this.actions.checkBridge)throw Error('连接检测暂不可用');const message=await this.actions.checkBridge(overlay.querySelector<HTMLInputElement>('[data-setting="baseUrl"]')!.value);
        if(current())overlay.querySelector<HTMLElement>('[data-bridge-status]')!.textContent=message;
      }else if(action==='check-ekko'){
        if(!this.actions.checkEkko)throw Error('EKKO 连接核对暂不可用');const connection=await this.actions.checkEkko();
        if(current()){this.pairingUnknown=this.actions.pairingUnknown?.()??this.pairingUnknown;this.showEkko(overlay,connection);this.showPairingState(overlay);overlay.querySelector<HTMLFormElement>('[data-settings-ekko-form]')!.hidden=Boolean(connection&&connection.state==='connected');overlay.querySelector<HTMLElement>('[data-settings-action="change-ekko"]')!.hidden=!connection;}
      }else if(action==='pair-ekko'){
        if(this.pairingUnknown)throw Error('请先在 EKKO 核对应用连接');
        if(!this.actions.pairEkko)throw Object.assign(Error('EKKO 配对暂不可用'),{pairingUnknown:false});
        const field=(name:string)=>overlay.querySelector<HTMLInputElement>(`[data-ekko-setting="${name}"]`)!;
        const input={baseUrl:field('baseUrl').value.trim(),username:field('username').value.trim(),password:field('password').value};field('password').value='';
        if(!input.baseUrl||!input.username||!input.password)throw Object.assign(Error('请填写 EKKO 地址、账号和本次密码'),{pairingUnknown:false});
        let connection:EkkoConnection;
        try{connection=await this.actions.pairEkko(input);}catch(error){if((error as {pairingUnknown?:boolean})?.pairingUnknown!==false)this.pairingUnknown=true;throw error;}
        if(current()){this.pairingUnknown=false;this.showEkko(overlay,connection);this.showPairingState(overlay);overlay.querySelector<HTMLFormElement>('[data-settings-ekko-form]')!.hidden=true;overlay.querySelector<HTMLElement>('[data-settings-action="change-ekko"]')!.hidden=false;}
      }else if(action==='ack-pairing'){
        if(this.doc.defaultView?.confirm('请先在 EKKO 的应用连接中核对上次配对结果。确认允许重新输入账号和密码配对？')){this.actions.clearPairingUnknown?.();this.pairingUnknown=false;this.showPairingState(overlay);}
      }
    }catch(error){if(current()){
      if(['save','confirm-bridge','detect-bridge','check-bridge'].includes(action||'')){
        const outcome=this.saveUncertain||this.actions.lastSaveOutcome?.()==='unknown'?'unknown':(error as {saveOutcome?:SaveOutcome})?.saveOutcome;
        this.inspection=error instanceof BridgeInspectionError?{url:'',message:'',hermesReady:false,bridgeAuthenticated:false,evidence:error.evidence,saveOutcome:outcome||'not-requested'}:null;
        this.saveOutcome=outcome||(error instanceof BridgeInspectionError?'not-requested':'unknown');this.saveUncertain=this.saveOutcome==='unknown'&&(this.saveUncertain||this.actions.lastSaveOutcome?.()==='unknown'||action==='save'||action==='confirm-bridge');
        this.freshness=error instanceof BridgeInspectionError?'current':'unconfirmed';
        overlay.querySelector('[data-hermes-results]')!.replaceChildren();this.showInspection(overlay);
      }
      errorLine.textContent=this.saveOutcome==='unknown'&&(action==='save'||action==='confirm-bridge')?'设置保存结果未确认；请先核对已保存设置，不要重复提交。':action==='check-ekko'?'EKKO 暂不可用，请核对原应用连接后重试。':action==='pair-ekko'?'EKKO 配对未完成，请核对账号、应用连接与上次配对结果后继续。':action==='save-location'?'默认位置未能保存，请核对后重试。':'连接操作未完成，请核对连接或已保存设置后重试。';errorLine.hidden=false;
    }}
    finally{if(this.overlay===overlay&&this.busyOwner===owner){this.busyOwner=undefined;this.busy=false;overlay.removeAttribute('aria-busy');this.syncControls(overlay);}}
  }
}
