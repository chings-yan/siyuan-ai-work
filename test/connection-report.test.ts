import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCompanionMetadata,parseAuthorizationRecord,authorizationRecordState,buildConnectionDiagnostic,type ReportContext} from '../src/work/connection-report.ts';
const nowSec=1_800_000_000;
const context:ReportContext={pluginVersion:'0.3.9',freshness:'current',candidateKind:'studio',confirmedKind:null,saveOutcome:'not-requested'};
const studio={id:'fictional-id',kind:'studio',state:'offline',displayName:'private-title',profile:'private-profile',installId:null};
const evidence={checkedAt:'2026-10-22T12:00:00.000Z',code:'ok',reads:[{attempt:1,step:'health',httpStatus:200},{attempt:1,step:'connections',httpStatus:200}],companion:{schemaVersion:1,bridgeVersion:'0.3.9',capabilities:['hermes-connection-inspection-v1']}};
test('companion metadata accepts SemVer and drops unknown capabilities and extra fields',()=>{
 for(const version of ['0.3.9','1.0.0-alpha.1+build.2026',null,'1.0.0+'+'a'.repeat(58)])assert.deepEqual(parseCompanionMetadata({schemaVersion:1,bridgeVersion:version,capabilities:['unknown','hermes-connection-inspection-v1','hermes-connection-inspection-v1'],token:'fictional-token'}),{schemaVersion:1,bridgeVersion:version,capabilities:['hermes-connection-inspection-v1']});
 assert.deepEqual(parseCompanionMetadata({schemaVersion:1,bridgeVersion:null,capabilities:['a'.repeat(64),...Array(15).fill('unknown')]}),{schemaVersion:1,bridgeVersion:null,capabilities:[]});
});
test('metadata rejects missing malformed oversized and unknown schema without guessing',()=>{
 for(const value of [null,[],{}, {schemaVersion:2}, ...['fictional-token','01.2.3','1.2.3-01','1.2.3-','1.2.3+a_b','1.2.3+'+'a'.repeat(59),1].map(bridgeVersion=>({schemaVersion:1,bridgeVersion,capabilities:[]})), ...[{},['x'.repeat(65)],Array(17).fill('x'),[3]].map(capabilities=>({schemaVersion:1,bridgeVersion:'1.2.3',capabilities}))])assert.equal(parseCompanionMetadata(value),null);
});
test('authorization records require positive safe Unix seconds within the Date range',()=>{
 for(const expiresAt of [1,nowSec,8_640_000_000_000])assert.deepEqual(parseAuthorizationRecord({source:'app-login-record',expiresAt,token:'fictional-token'}),{source:'app-login-record',expiresAt});
 for(const expiresAt of [0,-1,1.5,NaN,Infinity,'1800000000',1e20,Number.MAX_SAFE_INTEGER,8_640_000_000_001])assert.equal(parseAuthorizationRecord({source:'app-login-record',expiresAt}),null);
 for(const value of [null,{}, {source:'jwt',expiresAt:nowSec}])assert.equal(parseAuthorizationRecord(value),null);
});
test('authorization state uses exact seven day boundary and never guesses invalid time',()=>{
 const state=(expiresAt:number,now=nowSec*1000)=>authorizationRecordState({source:'app-login-record',expiresAt},now);
 assert.equal(state(nowSec-1),'expired');assert.equal(state(nowSec),'expired');assert.equal(state(nowSec+1),'expiring');
 assert.equal(state(nowSec+604800),'expiring');assert.equal(state(nowSec+604801),'valid');
 assert.equal(authorizationRecordState(null,nowSec*1000),'unknown');assert.equal(state(1e20),'unknown');assert.equal(state(nowSec,NaN),'unknown');assert.equal(state(nowSec,8_640_000_000_000_001),'unknown');
});
test('diagnostic explicitly projects safe fields and complete does not mean service ready',()=>{
 const malicious={url:'http://private-path',message:'fictional-token',bridgeAuthenticated:true,hermesReady:false,connections:[{...studio,toJSON:()=>({token:'fictional-token'})}],evidence:{...evidence,companion:{...evidence.companion,private:{path:'private-path'},toJSON:()=>({token:'fictional-token'})},token:'fictional-token',toJSON:()=>({token:'fictional-token'})},toJSON:()=>({token:'fictional-token'})};
 const summary=buildConnectionDiagnostic(malicious as any,{...context,private:'private-title',toJSON:()=>({token:'fictional-token'})} as any);
 assert.deepEqual(summary,{schemaVersion:1,pluginVersion:'0.3.9',companion:evidence.companion,checkedAt:evidence.checkedAt,freshness:'current',completed:true,bridgeAuthenticated:true,code:'ok',reads:evidence.reads,services:[{kind:'studio',state:'offline'}],candidateKind:'studio',confirmedKind:null,saveOutcome:'not-requested'});
 assert.doesNotMatch(JSON.stringify(summary),/fictional-token|private-profile|private-title|private-path/);
});
test('diagnostic handles legacy and malformed runtime evidence without asserting completion',()=>{
 const old=buildConnectionDiagnostic({bridgeAuthenticated:true,connections:[studio]} as any,context);
 assert.equal(old.completed,false);assert.equal(old.code,null);assert.equal(old.checkedAt,null);assert.equal(old.companion,null);
 assert.equal(buildConnectionDiagnostic({bridgeAuthenticated:true,evidence,connections:[]} as any,context).completed,true);
 for(const connections of [undefined,[{...studio,profile:''}],[{...studio,state:'fictional-token'}],[studio,studio]])assert.equal(buildConnectionDiagnostic({bridgeAuthenticated:true,evidence,connections} as any,context).completed,false);
 assert.equal(buildConnectionDiagnostic({bridgeAuthenticated:false,evidence,connections:[studio]} as any,context).completed,false);
 const summary=buildConnectionDiagnostic({bridgeAuthenticated:'fictional-token',evidence:{...evidence,code:'fictional-token',checkedAt:'2026-02-30T12:00:00.000Z',reads:[{attempt:1,step:'health',httpStatus:99},{attempt:2,step:'connections',httpStatus:599,token:'fictional-token'},{attempt:2,step:'connections',httpStatus:600},{attempt:1,step:'connections',httpStatus:200.5},{attempt:3,step:'health',httpStatus:200},{attempt:1,step:'fictional-token',httpStatus:200}]}} as any,{pluginVersion:'fictional-token',freshness:'fictional-token',candidateKind:'fictional-token',confirmedKind:'fictional-token',saveOutcome:'fictional-token'} as any);
 assert.equal(summary.pluginVersion,null);assert.equal(summary.bridgeAuthenticated,null);assert.equal(summary.code,null);assert.equal(summary.checkedAt,null);assert.equal(summary.freshness,'unconfirmed');assert.equal(summary.candidateKind,null);assert.equal(summary.confirmedKind,null);assert.equal(summary.saveOutcome,'unknown');
 assert.deepEqual(summary.reads,[{attempt:1,step:'health',httpStatus:null},{attempt:2,step:'connections',httpStatus:599},{attempt:2,step:'connections',httpStatus:null},{attempt:1,step:'connections',httpStatus:null}]);
 assert.doesNotMatch(JSON.stringify(summary),/fictional-token/);
});
test('diagnostic date and HTTP boundaries are validated independently',()=>{
 for(const checkedAt of ['2026-10-22T12:00:00.000Z','2026-10-22T12:00:00Z','2026-10-22T20:00:00+08:00','+275760-09-13T00:00:00.000Z'])assert.equal(buildConnectionDiagnostic({evidence:{...evidence,checkedAt}} as any,context).checkedAt,checkedAt);
 for(const checkedAt of ['private-path','2026-13-01T00:00:00Z','2026-02-29T00:00:00Z','+275760-09-13T00:00:00.001Z',1e20])assert.equal(buildConnectionDiagnostic({evidence:{...evidence,checkedAt}} as any,context).checkedAt,null);
 const summary=buildConnectionDiagnostic({evidence:{...evidence,reads:[{attempt:1,step:'health',httpStatus:100},{attempt:1,step:'connections',httpStatus:null}]}} as any,context);
 assert.deepEqual(summary.reads,[{attempt:1,step:'health',httpStatus:100},{attempt:1,step:'connections',httpStatus:null}]);
});

test('SemVer rejects trailing line terminators in metadata and diagnostic versions',()=>{
 for(const bridgeVersion of ['0.3.9\n','0.3.9\r','0.3.9\u2028','0.3.9\u2029']){
  assert.equal(parseCompanionMetadata({schemaVersion:1,bridgeVersion,capabilities:[]}),null);
  assert.equal(buildConnectionDiagnostic(null,{...context,pluginVersion:bridgeVersion}).pluginVersion,null);
 }
});
