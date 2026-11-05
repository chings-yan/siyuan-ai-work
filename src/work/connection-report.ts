import {validatedConnections,type BridgeInspection} from './connection-settings.ts';
import type {StudioReadWarning} from '../bridge.ts';

export type ConnectionKind = 'serve' | 'studio' | 'legacy-api';
export type ConnectionState = 'ready' | 'offline' | 'auth_missing' | 'auth_failed' | 'incompatible' | 'install_mismatch' | 'install_changed' | 'connected' | 'configured';
export type CompanionCapability = 'hermes-connection-inspection-v1' | 'ekko-authorization-record-v1';
export type CompanionMetadata = {schemaVersion:1;bridgeVersion:string|null;capabilities:CompanionCapability[]};
export type AuthorizationRecord = {source:'app-login-record';expiresAt:number};
export type SaveOutcome = 'not-requested' | 'saved' | 'bridge-only' | 'failed' | 'unknown' | 'stale';
export type InspectionCode = 'ok' | 'invalid_address' | 'health_unreachable' | 'health_invalid' | 'pairing_required' | 'pairing_rejected' | 'connections_http_error' | 'connections_invalid' | 'read_incomplete';
export type ReadEvidence = {attempt:1|2;step:'health'|'connections';httpStatus:number|null};
export type InspectionEvidence = {checkedAt:string;code:InspectionCode;reads:ReadEvidence[];companion:CompanionMetadata|null};
export type ReportContext = {pluginVersion:string;freshness:'current'|'previous'|'unconfirmed';candidateKind:ConnectionKind|null;confirmedKind:ConnectionKind|null;saveOutcome:SaveOutcome};
export type ConnectionDiagnostic = {schemaVersion:1;pluginVersion:string|null;companion:CompanionMetadata|null;checkedAt:string|null;freshness:ReportContext['freshness'];completed:boolean;bridgeAuthenticated:boolean|null;code:InspectionCode|null;reads:ReadEvidence[];services:Array<{kind:ConnectionKind;state:ConnectionState;readWarning?:StudioReadWarning}>;candidateKind:ConnectionKind|null;confirmedKind:ConnectionKind|null;saveOutcome:SaveOutcome};

const CAPABILITIES:readonly CompanionCapability[]=['hermes-connection-inspection-v1','ekko-authorization-record-v1'];
const CODES:readonly InspectionCode[]=['ok','invalid_address','health_unreachable','health_invalid','pairing_required','pairing_rejected','connections_http_error','connections_invalid','read_incomplete'];
const KINDS:readonly ConnectionKind[]=['serve','studio','legacy-api'];
const SAVE_OUTCOMES:readonly SaveOutcome[]=['not-requested','saved','bridge-only','failed','unknown','stale'];
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
// Standard SemVer identifiers: numeric prerelease components cannot have leading zeros.
const SEMVER=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const version=(value:unknown):value is string=>typeof value==='string'&&value.length<=64&&SEMVER.test(value);
export function parseCompanionMetadata(value:unknown):CompanionMetadata|null{
 if(!object(value)||value.schemaVersion!==1||!(value.bridgeVersion===null||version(value.bridgeVersion))||!Array.isArray(value.capabilities)||value.capabilities.length>16||!value.capabilities.every(v=>typeof v==='string'&&v.length<=64))return null;
 return {schemaVersion:1,bridgeVersion:value.bridgeVersion,capabilities:[...new Set(value.capabilities.filter((v):v is CompanionCapability=>CAPABILITIES.includes(v as CompanionCapability)))]};
}
export function parseAuthorizationRecord(value:unknown):AuthorizationRecord|null{
 if(!object(value)||value.source!=='app-login-record'||typeof value.expiresAt!=='number'||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0||!Number.isFinite(new Date(value.expiresAt*1000).getTime()))return null;
 return {source:'app-login-record',expiresAt:value.expiresAt};
}
export function authorizationRecordState(record:AuthorizationRecord|null,nowMs:number):'unknown'|'valid'|'expiring'|'expired'{
 const parsed=parseAuthorizationRecord(record);
 if(!parsed||!Number.isFinite(nowMs)||!Number.isFinite(new Date(nowMs).getTime()))return 'unknown';
 const remaining=parsed.expiresAt*1000-nowMs;
 return remaining<=0?'expired':remaining<=604800000?'expiring':'valid';
}
function isoDate(value:unknown):string|null{
 if(typeof value!=='string'||value.length>35)return null;
 const parts=/^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(value);
 if(!parts||!Number.isFinite(Date.parse(value)))return null;
 const [,year,month,day,hour,minute,second]=parts;const y=Number(year),m=Number(month),d=Number(day);
 const leap=y%4===0&&(y%100!==0||y%400===0),days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 return m>=1&&m<=12&&d>=1&&d<=days[m-1]&&Number(hour)<24&&Number(minute)<60&&Number(second)<60?value:null;
}
/** Construct each allowed field afresh: never stringify or spread untrusted inspection data. */
export function buildConnectionDiagnostic(inspection:BridgeInspection|null,context:ReportContext):ConnectionDiagnostic{
 const evidence=inspection?.evidence;
 const code=CODES.includes(evidence?.code as InspectionCode)?evidence!.code:null;
 const bridgeAuthenticated=typeof inspection?.bridgeAuthenticated==='boolean'?inspection.bridgeAuthenticated:null;
 let connections:ReturnType<typeof validatedConnections>=[],validList=false;
 try{connections=validatedConnections(inspection?.connections);validList=true;}catch{/* Missing or invalid lists provide no reading evidence. */}
 const reads:ReadEvidence[]=[];
 if(Array.isArray(evidence?.reads))for(const row of evidence.reads){
  if(!object(row)||(row.attempt!==1&&row.attempt!==2)||(row.step!=='health'&&row.step!=='connections'))continue;
  reads.push({attempt:row.attempt,step:row.step,httpStatus:typeof row.httpStatus==='number'&&Number.isInteger(row.httpStatus)&&row.httpStatus>=100&&row.httpStatus<=599?row.httpStatus:null});
 }
 return {
  schemaVersion:1,
  pluginVersion:version(context.pluginVersion)?context.pluginVersion:null,
  companion:parseCompanionMetadata(evidence?.companion),
  checkedAt:isoDate(evidence?.checkedAt),
  freshness:['current','previous','unconfirmed'].includes(context.freshness)?context.freshness:'unconfirmed',
  completed:code==='ok'&&bridgeAuthenticated===true&&validList,
  bridgeAuthenticated,code,reads,
  // validatedConnections has already checked the fixed state whitelist.
  services:connections.map(v=>({kind:v.kind,state:v.state as ConnectionState,...(v.readWarning?{readWarning:v.readWarning}:{})})),
  candidateKind:KINDS.includes(context.candidateKind as ConnectionKind)?context.candidateKind:null,
  confirmedKind:KINDS.includes(context.confirmedKind as ConnectionKind)?context.confirmedKind:null,
  saveOutcome:SAVE_OUTCOMES.includes(context.saveOutcome)?context.saveOutcome:'unknown'
 };
}
