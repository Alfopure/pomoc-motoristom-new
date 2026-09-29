import 'server-only';
import { randomUUID } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import type { Json } from '@/lib/supabase/database.types';
import { DIAGNOSTIC_LIMITS, isDiagnosticSafeId, isDiagnosticUuid, parseDiagnosticEvent, type DiagnosticAck, type DiagnosticEvent, type DiagnosticEventInput, type DiagnosticOverview } from '@/lib/diagnostics/types';
import { assertSameOriginRequest, requireDefaultMotoristActor, type MotoristActor } from '@/server/api-auth';
import { MutationError } from '@/server/mutation-error';
import type { TelephonyCronJobResult } from '@/server/telephony/cron-jobs';
export const DIAGNOSTIC_MEMBER_ROLES = ['dispatcher','senior_dispatcher','manager','admin'] as const;
export const diagnosticsEnabled = () => process.env.DIAGNOSTICS_ENABLED === 'true';
export const diagnosticsEnvironment = (): 'production'|'test'|'development' => process.env.VERCEL_ENV === 'production' ? 'production' : process.env.VERCEL_ENV === 'preview' || process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('nzpnqdstvkfncflgqlny') ? 'test' : 'development';
const serverBuild = () => { const id=process.env.DEPLOYMENT_VERSION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_DIAGNOSTICS_BUILD_ID ?? 'local';return isDiagnosticSafeId(id)?id:'unknown'; };
const noStore = {'Cache-Control':'private, no-store'};
function response(value:unknown,status=200,headers:Record<string,string>={}) {return Response.json(value,{status,headers:{...noStore,...headers}});}
export function diagnosticErrorResponse(error:unknown) { return response({error:error instanceof MutationError?error.message:'Diagnostika je dočasne nedostupná.'},error instanceof MutationError?error.status:503); }
/** Bounds actual streamed bytes, including chunked requests with a forged Content-Length. */
export async function readDiagnosticBody(request:Request,limit=DIAGNOSTIC_LIMITS.batchBytes):Promise<unknown> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new MutationError('Vyžaduje sa JSON.',415);
  if (Number(request.headers.get('content-length')??0)>limit) throw new MutationError('Príliš veľká dávka.',413);
  const reader=request.body?.getReader();if(!reader) throw new MutationError('Chýba dávka.',400);
  const chunks:Uint8Array[]=[];let size=0;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
    reject(new MutationError('Čítanie dávky prekročilo časový limit.',408));
    void reader.cancel().catch(()=>undefined);
  },1000);});
  try {while(true){const {done,value}=await Promise.race([reader.read(),timeout]);if(done)break;size+=value.byteLength;if(size>limit){void reader.cancel().catch(()=>undefined);throw new MutationError('Príliš veľká dávka.',413);}chunks.push(value);}}
  finally {if(timer)clearTimeout(timer);reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new MutationError('Neplatná dávka.',400);}
}
function requireOrigin(request:Request){if(!request.headers.get('origin'))throw new MutationError('Chýba pôvod požiadavky.',403);assertSameOriginRequest(request);}
export async function ingestDiagnostics(request:Request):Promise<Response> {
  try {
    requireOrigin(request);
    const body=await readDiagnosticBody(request);
    if(!body||typeof body!=='object'||Array.isArray(body))throw new MutationError('Neplatná dávka.',400);
    const raw=body as Record<string,unknown>;
    if(Object.keys(raw).some(k=>k!=='events'&&k!=='actor')||!Array.isArray(raw.events)||raw.events.length<1||raw.events.length>DIAGNOSTIC_LIMITS.batchEvents)throw new MutationError('Neplatná dávka.',400);
    const events=raw.events.map(parseDiagnosticEvent);if(events.some(e=>!e))throw new MutationError('Nepovolené diagnostické údaje.',400);
    const binding=raw.actor as Record<string,unknown>|null;
    if(!binding||typeof binding!=='object'||Object.keys(binding).some(k=>k!=='profileId'&&k!=='organizationId')||!isDiagnosticUuid(binding.profileId)||!isDiagnosticUuid(binding.organizationId))throw new MutationError('Chýba identita dávky.',400);
    const actor=await requireDefaultMotoristActor([...DIAGNOSTIC_MEMBER_ROLES]);
    if(binding.profileId!==actor.profileId||binding.organizationId!==actor.organizationId)throw new MutationError('Relácia používateľa sa zmenila.',401);
    if(!diagnosticsEnabled())return response({acceptedIds:[],degraded:true},503,{'Retry-After':'300'});
    const result=await persistDiagnostics(actor,events as DiagnosticEvent[],'browser');
    if(result.unavailable)return response({acceptedIds:[],degraded:true},503,{'Retry-After':'300'});
    if(result.rateLimited)return response({acceptedIds:[],degraded:true},429,{'Retry-After':'60'});
    return response({acceptedIds:result.acceptedIds,rejectedIds:result.rejectedIds??[],degraded:result.degraded??false});
  }catch(error){return diagnosticErrorResponse(error);}
}
type IngestResult=DiagnosticAck&{unavailable?:boolean;rateLimited?:boolean};
async function persistDiagnostics(actor:Pick<MotoristActor,'organizationId'|'profileId'>,events:DiagnosticEvent[],source:'browser'|'server'):Promise<IngestResult> {
  const {data,error}=await createSupabaseAdminClient().rpc('motorist_diagnostics_ingest',{p_org:actor.organizationId,p_profile:actor.profileId,p_environment:diagnosticsEnvironment(),p_source:source,p_build:serverBuild(),p_events:events as unknown as Json}).abortSignal(AbortSignal.timeout(1500));
  if(error||!data||typeof data!=='object'||Array.isArray(data))throw new Error('diagnostic_store_unavailable');
  return data as IngestResult;
}
export function parseDiagnosticQuery(request:Request) {
  const u=new URL(request.url);const until=u.searchParams.get('until')??new Date().toISOString();if(!Number.isFinite(Date.parse(until)))throw new MutationError('Neplatný čas.',400);const range=u.searchParams.get('range')??'24h';if(!['24h','7d'].includes(range))throw new MutationError('Neplatný rozsah.',400);const since=u.searchParams.get('since')??new Date(Date.parse(until)-(range==='7d'?7:1)*86_400_000).toISOString();
  if(!Number.isFinite(Date.parse(since))||!Number.isFinite(Date.parse(until))||Date.parse(until)<Date.parse(since)||Date.parse(until)-Date.parse(since)>7*86_400_000)throw new MutationError('Rozsah môže byť najviac 7 dní.',400);
  const cursor=u.searchParams.get('cursor');let cursorAt:string|null=null;let cursorId:string|null=null;
  if(cursor){const parts=cursor.split('|');if(parts.length!==2||!Number.isFinite(Date.parse(parts[0]))||!isDiagnosticUuid(parts[1]))throw new MutationError('Neplatná stránka.',400);[cursorAt,cursorId]=parts;}
  const pageSize=Number(u.searchParams.get('pageSize')??100);if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new MutationError('Neplatný limit.',400);
  const callSessionId=u.searchParams.get('callSessionId');if(callSessionId&&!isDiagnosticUuid(callSessionId))throw new MutationError('Neplatný hovor.',400);
  return {since,until,cursorAt,cursorId,pageSize,callSessionId};
}
export async function readDiagnostics(request:Request,id?:string,status?:unknown):Promise<Response> {
  try{
    const actor=await requireDefaultMotoristActor(['manager','admin']);
    if(process.env.DIAGNOSTICS_PANEL_ENABLED==='false')return response({error:'Monitor prevádzky je vypnutý.'},503);
    const query=parseDiagnosticQuery(request);
    if(id&&!isDiagnosticUuid(id))throw new MutationError('Neplatný incident.',400);
    if(status!==undefined&&!['new','acknowledged','resolved'].includes(String(status)))throw new MutationError('Neplatný stav.',400);
    if(!diagnosticsEnabled()){
      if(id||query.callSessionId)return response({error:'Diagnostika nie je aktivovaná.'},503);
      const empty:DiagnosticOverview={checkedAt:new Date().toISOString(),enabled:false,environment:diagnosticsEnvironment(),coverage:'unknown',since:query.since,until:query.until,incidents:[],nextCursor:null,operations:[],builds:[],calls:[],storage:null};return response(empty);
    }
    const {data,error}=await createSupabaseAdminClient().rpc('motorist_diagnostics_read',{p_org:actor.organizationId,p_profile:actor.profileId,p_environment:diagnosticsEnvironment(),p_mode:id?(status===undefined?'detail':'status'):query.callSessionId?'timeline':'overview',p_id:id??query.callSessionId,p_since:query.since,p_until:query.until,p_cursor_at:query.cursorAt,p_cursor_id:query.cursorId,p_limit:query.pageSize,p_status:status===undefined?null:String(status)}).abortSignal(AbortSignal.timeout(1500));
    if(error)throw new Error('diagnostic_read_unavailable');if(data===null)return response({error:'Záznam sa nenašiel.'},404);return response(data);
  }catch(error){return diagnosticErrorResponse(error);}
}
export async function updateDiagnosticStatus(request:Request,id:string){try{requireOrigin(request);const body=await readDiagnosticBody(request,128) as Record<string,unknown>;if(!body||typeof body!=='object'||Object.keys(body).some(k=>k!=='status')||typeof body.status!=='string')throw new MutationError('Neplatný stav.',400);return readDiagnostics(request,id,body.status);}catch(error){return diagnosticErrorResponse(error);}}
/** Invoked only inside the deferred observer; never on a business request's path. */
export async function persistServerDiagnostic(actor:Pick<MotoristActor,'organizationId'|'profileId'>,input:DiagnosticEventInput,occurredAt:string):Promise<void> {
  if(!diagnosticsEnabled())return;
  const event=parseDiagnosticEvent({...input,id:randomUUID(),pageId:randomUUID(),sequence:0,occurredAt,monotonicMs:0,buildId:serverBuild(),sampled:input.sampled??false,sampleRate:input.sampleRate??DIAGNOSTIC_LIMITS.sampleRate});
  if(event)await persistDiagnostics(actor,[event],'server');
}
export async function runDiagnosticsMaintenance(organizationId:string):Promise<TelephonyCronJobResult> {
 const job='diagnostics.maintenance';if(!diagnosticsEnabled())return {job,status:'disabled',detail:{}};
 try{const parsed=Number(process.env.DIAGNOSTICS_PHYSICAL_BUDGET_BYTES??0);const budget=Number.isSafeInteger(parsed)&&parsed>=0?Math.min(parsed,128*1024*1024):0;
  const {data,error}=await createSupabaseAdminClient().rpc('motorist_diagnostics_maintain',{p_org:organizationId,p_environment:diagnosticsEnvironment(),p_budget:budget,p_classify:process.env.DIAGNOSTICS_CLASSIFIER_ENABLED==='true'}).abortSignal(AbortSignal.timeout(1950));
  if(error)throw new Error('maintenance_unavailable');return {job,status:'ok',detail:(data??{}) as Record<string,unknown>};
 }catch{return {job,status:'failed',detail:{reason:'diagnostics_unavailable'}};}
}

/** The HTTP budget includes auth and parsing, not just the database statement. */
export async function runDiagnosticEndpoint(work:()=>Promise<Response>):Promise<Response>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([work(),new Promise<Response>(resolve=>{timer=setTimeout(()=>resolve(response({error:'Diagnostika je dočasne nedostupná.'},503,{'Retry-After':'15'})),2000);})]);}
  finally{if(timer)clearTimeout(timer);}
}
