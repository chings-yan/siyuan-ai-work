import {BridgeError,checkedBridgeUrl as localUrl,DEFAULT_BRIDGE_URL,isValidByteStringHeaderValue,isValidDocumentRootId,validatedStudioReadWarning,type ConnectionView,type BridgeConfig} from '../bridge.ts';
import {EkkoBridgeClient,type EkkoConnection} from '../ekko/bridge.ts';
import {parseCompanionMetadata,type InspectionEvidence,type InspectionCode,type ReadEvidence,type SaveOutcome} from './connection-report.ts';

async function readJson(url:string,headers:Record<string,string>,fetcher:typeof fetch,read:ReadEvidence,timeout=10000,isCurrent:()=>boolean=()=>true):Promise<{response:Response;data:any}>{
 checkInspectionCurrent(isCurrent);
 const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 // Bound both headers and body, including fetch implementations that ignore abort.
 const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('读取超时'));},timeout);});
 try{const result=await Promise.race([deadline,(async()=>{
  const response=await fetcher(url,{method:'GET',headers,signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});
  checkInspectionCurrent(isCurrent);
  read.httpStatus=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:null;
  // A malformed body must not hide an actual 401/403 or fabricate a service status.
  const data=await response.json().catch(()=>undefined);checkInspectionCurrent(isCurrent);return {response,data};
 })()]);checkInspectionCurrent(isCurrent);return result;}finally{clearTimeout(timer);}
}
export type BridgeSettingsInput={url:string;token:string;detect:boolean;connectionId?:string};
function checkInspectionCurrent(isCurrent:()=>boolean):void{if(!isCurrent())throw Object.assign(Error('文档、连接偏好或操作状态已变化，请重新检测'),{saveOutcome:'stale'});}
export type BridgeInspection={url:string;message:string;hermesReady:boolean;bridgeAuthenticated:boolean;connections?:ConnectionView[];selectedConnectionId?:string;requiresSelection?:boolean;evidence?:InspectionEvidence;saveOutcome?:SaveOutcome};
const INSPECTION_ERRORS={invalid_address:'Bridge 地址无效，请填写本机 Bridge 地址',health_unreachable:'本机 Bridge 未响应，请启动 Bridge 后再检测',health_invalid:'这个地址未通过思源 AI Work Bridge 健康核对'};
export class BridgeInspectionError extends Error{
 constructor(readonly evidence:InspectionEvidence){super(INSPECTION_ERRORS[evidence.code as keyof typeof INSPECTION_ERRORS]??'本机 Bridge 检测未完成，请核对后重试');this.name='BridgeInspectionError';}
}
export const validConnectionId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value);
export function connectionLabel(view:Pick<ConnectionView,'kind'>):string{return view.kind==='serve'?'Hermes 服务':view.kind==='studio'?'Hermes Studio 服务':'旧会话服务';}
export const STUDIO_PARTIAL_READ_NOTICE='部分会话归属尚未核验，无法关联；已核验归属的会话可继续使用。';
export function connectionAdvice(view:Pick<ConnectionView,'state'|'kind'|'readWarning'>):string{
 switch(view.state){
  case 'ready':return view.kind==='studio'&&validatedStudioReadWarning(view.readWarning)?`已通过认证与会话读取核验；${STUDIO_PARTIAL_READ_NOTICE}`:view.kind==='legacy-api'?'只可关联旧会话':'已通过认证与会话读取核验';
  case 'auth_missing':return '缺少服务授权凭证，请配置后重试';
  case 'auth_failed':return '原服务拒绝了授权，请核对原服务的授权设置';
  case 'incompatible':return '缺少必要读取协议能力，请核对服务配置';
  case 'install_mismatch':case 'install_changed':return '安装身份不符，请核对原服务';
  case 'configured':case 'connected':return view.kind==='legacy-api'?'旧配套服务已配置，尚未核验读取能力；仅可关联旧会话':'旧配套服务已配置，尚未核验读取能力';
  default:return '服务未连接，可能未运行或不可达，请启动后重试';
 }
}
/** The same validation protects explicit inspection and passive refresh. Upstream names never enter UI. */
export function validatedConnections(value:unknown):ConnectionView[]{
 if(!Array.isArray(value)||!value.every((v:any)=>v&&validConnectionId(v.id)&&['serve','studio','legacy-api'].includes(v.kind)&&typeof v.displayName==='string'&&typeof v.profile==='string'&&v.profile.trim()&&v.profile.length<=160&&['ready','offline','auth_missing','auth_failed','incompatible','install_mismatch','install_changed','connected','configured'].includes(v.state)&&(v.installId===null||typeof v.installId==='string'&&v.installId.trim()&&v.installId.length<=256)&&!(v.kind==='serve'&&v.state==='ready'&&!v.installId))||new Set(value.map(v=>v.id)).size!==value.length)throw Error('Bridge 连接响应无效，请核对服务配置');
 return value.map(v=>({id:v.id,kind:v.kind,profile:v.profile,installId:v.installId,state:v.state,displayName:connectionLabel(v),...(v.kind==='studio'&&v.state==='ready'&&validatedStudioReadWarning(v.readWarning)?{readWarning:validatedStudioReadWarning(v.readWarning)}:{})}));
}
/** Authenticated session reading is evidence of reading, not generation or stop support. */
export async function inspectLocalBridge(config:BridgeConfig & {selectedConnectionId?:string},fetcher:typeof fetch=fetch,isCurrent:()=>boolean=()=>true):Promise<BridgeInspection>{
 return inspectBridgeAttempt(config,fetcher,1,isCurrent);
}
async function inspectBridgeAttempt(config:BridgeConfig & {selectedConnectionId?:string},fetcher:typeof fetch,attempt:1|2,isCurrent:()=>boolean):Promise<BridgeInspection>{
 checkInspectionCurrent(isCurrent);
 const reads:ReadEvidence[]=[];let companion:InspectionEvidence['companion']=null;
 const evidence=(code:InspectionCode):InspectionEvidence=>({checkedAt:new Date().toISOString(),code,reads:reads.map(read=>({...read})),companion});
 let url:string;try{url=localUrl(config.bridgeUrl);}catch{throw new BridgeInspectionError(evidence('invalid_address'));}
 const healthRead:ReadEvidence={attempt,step:'health',httpStatus:null};reads.push(healthRead);let health;
 try{health=await readJson(url+'/health',{},fetcher,healthRead,5000,isCurrent);checkInspectionCurrent(isCurrent);}catch{checkInspectionCurrent(isCurrent);throw new BridgeInspectionError(evidence('health_unreachable'));}
 if(!health.response.ok||health.data?.ok!==true||health.data?.service!=='siyuan-ai-collab-bridge')throw new BridgeInspectionError(evidence('health_invalid'));
 const result=(code:InspectionCode,message:string,hermesReady=false,bridgeAuthenticated=false):BridgeInspection=>({url,message,hermesReady,bridgeAuthenticated,requiresSelection:false,evidence:evidence(code),saveOutcome:'not-requested'});
 if(!config.capabilityToken||!isValidByteStringHeaderValue(config.capabilityToken))return result('pairing_required','已找到本机 Bridge；请运行配套 setup / pair 脚本，从本机凭证文件复制配对凭证后核对。AI 可稍后连接');
 const headers:Record<string,string>={'X-Siyuan-Collab-Token':config.capabilityToken};
 const authRead:ReadEvidence={attempt,step:'connections',httpStatus:null};reads.push(authRead);
 try{
  const auth=await readJson(url+'/connections',headers,fetcher,authRead,10000,isCurrent);checkInspectionCurrent(isCurrent);
  if(auth.response.status===401||auth.response.status===403)return result('pairing_rejected','本机 Bridge 已启动；配对凭证未通过，请核对后重新输入');
  if(!auth.response.ok)return result('connections_http_error','Bridge 认证核对失败，尚未保存；请检查本机服务后重试');
  let connections:ConnectionView[];try{connections=validatedConnections(auth.data?.data);}catch{return result('connections_invalid','Bridge 连接响应无效，尚未保存；请核对服务配置');}
  companion=parseCompanionMetadata(auth.data?.meta);
  const usable=connections.filter(v=>v.state==='ready'&&v.kind!=='legacy-api');
  const selectedConnectionId=config.selectedConnectionId||(usable.length===1?usable[0].id:undefined);
  const selected=connections.find(v=>v.id===selectedConnectionId),requiresSelection=!selectedConnectionId&&usable.length>1;
  const ready=selected?.state==='ready'&&selected.kind!=='legacy-api';
  const advice=requiresSelection?'检测到多个可用服务，请选择新建与关联的目标':selected?connectionAdvice(selected):selectedConnectionId?'原选择的服务未找到，请核对或明确选择其他服务':connections.length?'尚无可用的新建目标，请按下方检测结果核对；Work 可继续使用':'未找到已配置的 Hermes 服务，请先启动或配置服务';
  return {...result('ok',`Bridge 已配对；${advice}${ready?'。已核验会话读取，生成与停止仍需实际操作确认':''}`,ready,true),connections,selectedConnectionId,requiresSelection};
 }catch{checkInspectionCurrent(isCurrent);return result('read_incomplete','Bridge 认证核对未完成，尚未保存；请检查服务后重试');}
}

export async function detectLocalBridge(config:BridgeConfig & {selectedConnectionId?:string},fetcher:typeof fetch=fetch,isCurrent:()=>boolean=()=>true):Promise<BridgeInspection>{
 const candidates=[...new Set([config.bridgeUrl,DEFAULT_BRIDGE_URL].map(value=>{try{return localUrl(value);}catch{return '';}}).filter(Boolean))];
 const reads:ReadEvidence[]=[];let first:BridgeInspection|undefined,lastError:BridgeInspectionError|undefined;
 const completed=(found:BridgeInspection):BridgeInspection=>({...found,evidence:{...found.evidence!,checkedAt:new Date().toISOString(),reads:[...reads]}});
 for(const [index,bridgeUrl] of candidates.entries()){
  try{const found=await inspectBridgeAttempt({...config,bridgeUrl},fetcher,(index+1) as 1|2,isCurrent);checkInspectionCurrent(isCurrent);reads.push(...found.evidence!.reads);if(found.bridgeAuthenticated)return completed(found);first??=found;}
  catch(error){checkInspectionCurrent(isCurrent);if(error instanceof BridgeInspectionError){reads.push(...error.evidence.reads);lastError=error;}}
 }
 if(first)return completed(first);
 throw new BridgeInspectionError({checkedAt:new Date().toISOString(),code:lastError?.evidence.code??'invalid_address',reads,companion:null});
}
const sameAccount=(a:EkkoConnection,b:EkkoConnection)=>a.id===b.id&&a.deviceId===b.deviceId&&a.accountUserId===b.accountUserId;
function verified(connection:EkkoConnection|null):connection is EkkoConnection{
 return Boolean(connection&&/^[A-Za-z0-9_-]{1,160}$/.test(connection.id)&&/^[A-Za-z0-9_-]{1,160}$/.test(connection.deviceId)&&Number.isSafeInteger(connection.accountUserId)&&connection.accountUserId>0&&connection.state==='connected');
}
/** Settings never enters rooms. Uncertain application creation cannot be retried implicitly. */
export class EkkoSettingsConnection{
 private busy=false;private unresolved=false;private expected?:EkkoConnection;
 constructor(private readonly config:()=>BridgeConfig,private readonly operationBusy:()=>boolean,private readonly invalidateRoomViews:()=>void){}
 get unknown():boolean{return this.unresolved;}
 get isPairing():boolean{return this.busy;}
 clearUnknown():void{if(!this.busy){this.unresolved=false;this.expected=undefined;}}
 private unchanged(config:BridgeConfig):boolean{const now=this.config();return now.bridgeUrl===config.bridgeUrl&&now.capabilityToken===config.capabilityToken;}
 private async bounded<T>(config:BridgeConfig,action:(client:EkkoBridgeClient)=>Promise<T>):Promise<T>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
  try{return await action(new EkkoBridgeClient({...config,signal:controller.signal}));}finally{clearTimeout(timer);}
 }
 async check():Promise<EkkoConnection|null>{
  if(this.busy)throw Error('正在配对，请等待结果');
  const config={...this.config()},expected=this.expected;
  const {connection}=await this.bounded(config,client=>client.connection());
  if(!this.unchanged(config))throw Error('Bridge 连接已变化，请重新核对账号');
  // An older existing account is not evidence that an unknown POST succeeded.
  if(!this.busy&&expected&&this.expected===expected&&verified(connection)&&sameAccount(expected,connection)){this.unresolved=false;this.expected=undefined;}
  return connection;
 }
 async pair(input:{baseUrl:string;username:string;password:string}):Promise<EkkoConnection>{
  const preflight=(message:string)=>Object.assign(Error(message),{pairingUnknown:false});
  if(this.busy||this.operationBusy())throw preflight('请先完成当前操作，再更改 EKKO 账号连接');
  if(this.unresolved)throw Error('上次配对结果未确认，请先在 EKKO 核对应用连接');
  let base:URL;try{base=new URL(input.baseUrl);}catch{throw preflight('EKKO 地址应为 http://127.0.0.1:8748');}
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw preflight('EKKO 地址应为 http://127.0.0.1:8748（使用实际端口）');
  if(!input.username.trim()||!input.password||input.username.length>256||input.password.length>4096||input.baseUrl.length>128)throw preflight('请填写有效的 EKKO 地址、账号和本次密码');
  const config={...this.config()};try{localUrl(config.bridgeUrl);}catch{throw preflight('请先配置本机 Bridge 地址');}
  if(!config.capabilityToken||!isValidByteStringHeaderValue(config.capabilityToken))throw preflight('请先配对本机 Bridge');
  this.busy=true;this.expected=undefined;let accountMayChange=true;
  try{
   const paired=await this.bounded(config,client=>client.pair({...input,baseUrl:base.origin}));
   if(!verified(paired.connection))throw Error('配对身份尚未确认');
   this.expected=paired.connection;
   const checked=await this.bounded(config,client=>client.connection());
   if(!this.unchanged(config)||!verified(checked.connection)||!sameAccount(paired.connection,checked.connection))throw Error('配对身份发生变化');
   this.unresolved=false;this.expected=undefined;return checked.connection;
  }catch(error){
   if(!this.expected&&error instanceof BridgeError&&['ekko_auth_failed','unauthorized','origin_denied','bridge_capability_required','ekko_invalid_address','ekko_pairing_input_invalid'].includes(error.code||'')){
    accountMayChange=false;throw preflight(error.code==='ekko_auth_failed'?'EKKO 账号或密码未通过，请核对后重新输入':'配对请求被拒绝，请核对本机 Bridge 配对配置和 EKKO 地址');
   }
   this.unresolved=true;throw Error('配对结果未确认；请先核对当前连接及 EKKO 的应用连接，不要重复提交');
  }
  finally{this.busy=false;if(accountMayChange)this.invalidateRoomViews();}
 }
}
