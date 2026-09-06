import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { getSupabaseServiceEnv } from "@/lib/supabase/env";
import type { Json } from "@/lib/supabase/database.types";
import { record, RecordingProcessingError, type RecordingJobContext, type RecordingJobOutcome } from "./recording-jobs";
import { newRecordingHash, updateRecordingHash, finishRecordingHash, type RecordingSha256State } from "./recording-storage-sha256";

export const RECORDING_CHUNK_BYTES=6*1024*1024;
export const RECORDINGS_BUCKET="motorist-call-recordings";
export function publicRecordingAddress(address:string) {
 if(isIP(address)===4) {
  const [a,b,c]=address.split('.').map(Number);
  return a!==0&&a!==10&&a!==127&&a!==169&&!(a===172&&b>=16&&b<=31)&&!(a===192&&(b===168||b===0||b===88&&c===99||b===2))&&!(a===100&&b>=64&&b<=127)&&a<224&&!(a===198&&(b===18||b===19||b===51))&&!(a===203&&b===0&&c===113);
 }
 if(isIP(address)===6) return /^2[0-9a-f]{3}:/i.test(address)&&!/^2001:(db8|0|10|20):/i.test(address)&&!/^2002:/i.test(address);
 return false;
}
export function validateRecordingSourceUrl(value:string,hosts:string[]) {
 let url:URL; try {url=new URL(value);} catch {throw new RecordingProcessingError("source_url_invalid");}
 if(url.protocol!=="https:"||url.username||url.password||url.port&&url.port!=="443"||url.hash||isIP(url.hostname)||!hosts.includes(url.hostname.toLowerCase())) throw new RecordingProcessingError("source_host_not_allowed");
 return url;
}
async function lookupPublicRecordingAddresses(host:string,signal:AbortSignal){
 if(signal.aborted)throw new RecordingProcessingError('source_deadline',true);
 return new Promise<Array<{address:string;family:number}>>((resolve,reject)=>{
  const abort=()=>reject(new RecordingProcessingError('source_deadline',true));signal.addEventListener('abort',abort,{once:true});
  lookup(host,{all:true}).then(resolve,()=>reject(new RecordingProcessingError('source_dns_failed',true))).finally(()=>signal.removeEventListener('abort',abort));
 });
}
// Pin the validated DNS address into the TLS request; redirects are never followed.
export async function downloadRecordingChunk(value:string,offset:number,signal:AbortSignal,hosts:string[]) {
 const url=validateRecordingSourceUrl(value,hosts);
 const addresses=await lookupPublicRecordingAddresses(url.hostname,signal);
 if(!addresses.length||addresses.some(a=>!publicRecordingAddress(a.address))) throw new RecordingProcessingError("source_private_address");
 const address=addresses[0];
 return new Promise<{bytes:Buffer;total:number;etag:string|null;mime:string}>((resolve,reject)=>{
  const req=httpsRequest(url,{method:"GET",family:address.family,signal,headers:{Range:`bytes=${offset}-${offset+RECORDING_CHUNK_BYTES-1}`},
   lookup:(_hostname,_opts,callback)=>callback(null,address.address,address.family)},res=>{
   if(res.statusCode!==200&&res.statusCode!==206) {res.destroy();reject(new RecordingProcessingError("source_unavailable",true));return;}
   const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers["content-range"]??""));
   if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new RecordingProcessingError('source_encoding_invalid'));return;}
   const total=range?Number(range[3]):Number(res.headers["content-length"]);
   if(!Number.isSafeInteger(total)||total<1||(res.statusCode===206&&(!range||Number(range[1])!==offset||Number(range[2])!==Math.min(offset+RECORDING_CHUNK_BYTES,total)-1))||(res.statusCode===200&&(offset!==0||total>RECORDING_CHUNK_BYTES))) {res.destroy();reject(new RecordingProcessingError("source_range_unsupported"));return;}
   const chunks:Buffer[]=[];let size=0;
   res.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>RECORDING_CHUNK_BYTES){res.destroy(new Error("limit"));return;}chunks.push(chunk);});
   res.on("error",()=>reject(new RecordingProcessingError("source_download_failed",true)));
   res.on("end",()=>{const expected=Math.min(RECORDING_CHUNK_BYTES,total-offset);if(size!==expected){reject(new RecordingProcessingError("source_length_mismatch"));return;}
    resolve({bytes:Buffer.concat(chunks),total,etag:res.headers.etag??null,mime:String(res.headers["content-type"]??"").split(';')[0]});});
  });
  req.on("error",()=>reject(new RecordingProcessingError("source_download_failed",true)));req.end();
 });
}
function storageConfig(){const env=getSupabaseServiceEnv();if(!env)throw new RecordingProcessingError("storage_not_configured");const url=new URL(env.url);if(url.protocol!=="https:"&&!['127.0.0.1','localhost'].includes(url.hostname))throw new RecordingProcessingError("storage_not_configured");return {base:url.origin,key:env.serviceKey};}
export function recordingStoragePath(ctx:RecordingJobContext,mime:string){const r=ctx.recording;if(!r)throw new RecordingProcessingError("recording_missing");return `${ctx.organizationId}/${ctx.job.call_id}/${r.id}/r${r.source_revision}${mime==='audio/wav'?'.wav':'.mp3'}`;}
function validTusUrl(value:string,base:string){const url=new URL(value,base);if(url.origin!==base||!url.pathname.startsWith('/storage/v1/upload/resumable/')||url.username||url.password)throw new RecordingProcessingError("storage_upload_url_invalid");return url.href;}
async function storageRequest(path:string,init:RequestInit,signal:AbortSignal){const cfg=storageConfig();const url=new URL(path,cfg.base);if(url.origin!==cfg.base)throw new RecordingProcessingError("storage_host_invalid");try{return await fetch(url,{...init,cache:'no-store',redirect:'error',signal,headers:{Authorization:`Bearer ${cfg.key}`,apikey:cfg.key,...init.headers}});}catch{throw new RecordingProcessingError('storage_request_failed',true);}}
export async function signedRecordingSource(path:string,signal:AbortSignal){const res=await storageRequest(`/storage/v1/object/sign/${RECORDINGS_BUCKET}/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:3600})},signal);if(!res.ok)throw new RecordingProcessingError('storage_sign_failed',true);const data=record(await res.json());const signed=data.signedURL??data.signedUrl;if(typeof signed!=='string')throw new RecordingProcessingError('storage_sign_failed');const cfg=storageConfig();const url=new URL(signed.startsWith('/object/')?`/storage/v1${signed}`:signed,cfg.base);if(url.origin!==cfg.base)throw new RecordingProcessingError('storage_sign_host_invalid');return url.href;}
export async function refreshRecordingSource(ctx:RecordingJobContext){
 const id=ctx.recording?.provider_recording_id,key=process.env.TELNYX_API_KEY?.trim();if(!id||!key)throw new RecordingProcessingError('recording_provider_not_configured');
 const res=await fetch(`https://api.telnyx.com/v2/recordings/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${key}`},signal:ctx.signal,cache:'no-store',redirect:'error'});
 if(!res.ok)throw new RecordingProcessingError('recording_refresh_failed',res.status>=500||res.status===429);
 const data=record(record(await res.json()).data);if(data.id!==id||data.status!=='completed')throw new RecordingProcessingError('recording_not_ready',true);
 if(ctx.recording?.provider_session_id&&data.call_session_id!==ctx.recording.provider_session_id)throw new RecordingProcessingError('recording_provider_binding_mismatch');
 const urls=record(data.download_urls);const url=urls.wav??urls.mp3;if(typeof url!=='string')throw new RecordingProcessingError('recording_url_missing');return url;
}
export async function processRecordingImport(ctx:RecordingJobContext,io: {refreshSource?: typeof refreshRecordingSource; downloadChunk?: typeof downloadRecordingChunk} = {}):Promise<RecordingJobOutcome>{
 const r=ctx.recording;if(!r||!ctx.job.lease_token)throw new RecordingProcessingError('recording_missing');
 const cfg=storageConfig();const checkpoint=record(ctx.job.checkpoint);let offset=Number(checkpoint.offset??0);let hash=(checkpoint.hash_state??newRecordingHash()) as RecordingSha256State;
 if(!Number.isSafeInteger(offset)||offset<0||offset>134217728||hash.bytes!==offset||!Array.isArray(hash.words)||hash.words.length!==8||hash.words.some(w=>!Number.isInteger(w)||w<0||w>0xffffffff)||typeof hash.tail!=='string'||Buffer.from(hash.tail,'base64').length>=64)throw new RecordingProcessingError('import_checkpoint_invalid');
 let upload=typeof checkpoint.upload_url==='string'?validTusUrl(checkpoint.upload_url,cfg.base):null;const pending=record(checkpoint.pending_chunk);
 if(upload){const head=await storageRequest(upload,{method:'HEAD',headers:{'Tus-Resumable':'1.0.0'}},ctx.signal);if(!head.ok)throw new RecordingProcessingError('upload_reconcile_failed',true);const actual=Number(head.headers.get('upload-offset'));
  if(pending.end!==undefined&&actual===Number(pending.end)){offset=actual;hash=pending.hash_state as RecordingSha256State;if(!await ctx.checkpoint({offset,hash_state:hash,pending_chunk:null} as Json))throw new RecordingProcessingError('lease_lost');}
  else if(actual!==offset)throw new RecordingProcessingError('upload_offset_conflict');
 }
 if(!upload&&checkpoint.upload_create_started_at)return {state:'submission_unknown',errorCode:'upload_create_unconfirmed',checkpoint:{residual_retention:true}};
 const total=Number(checkpoint.total??0);const mime=String(checkpoint.mime??'');
 if(total>0&&offset===total){const ok=await ctx.admin.rpc('motorist_recording_complete_import',{p_job_id:ctx.job.id,p_lease_token:ctx.job.lease_token,p_lease_epoch:ctx.job.lease_epoch,p_storage_path:recordingStoragePath(ctx,mime),p_bytes:total,p_sha256:finishRecordingHash(hash),p_mime_type:mime}).abortSignal(ctx.signal);if(ok.error||!ok.data)throw new RecordingProcessingError('import_publish_conflict');return {state:'complete'};}
 const hosts=(process.env.TELNYX_RECORDING_DOWNLOAD_HOSTS??'recordings.telnyx.com').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean);
 const source=await (io.refreshSource??refreshRecordingSource)(ctx);const chunk=await (io.downloadChunk??downloadRecordingChunk)(source,offset,ctx.signal,hosts);
 if(chunk.total>ctx.policy.max_recording_bytes||chunk.total>134217728)throw new RecordingProcessingError('recording_too_large');
 if(total&&chunk.total!==total||checkpoint.etag&&chunk.etag!==checkpoint.etag)throw new RecordingProcessingError('recording_source_changed');
 if(chunk.total>RECORDING_CHUNK_BYTES&&(!chunk.etag||chunk.etag.startsWith('W/')))throw new RecordingProcessingError('source_identity_unverified');
 const inferred=offset===0?(chunk.bytes.toString('ascii',0,4)==='RIFF'&&chunk.bytes.toString('ascii',8,12)==='WAVE'?'audio/wav':chunk.bytes.toString('ascii',0,3)==='ID3'||chunk.bytes[0]===255&&(chunk.bytes[1]&224)===224?'audio/mpeg':null):mime;
 if(!inferred)throw new RecordingProcessingError('recording_format_invalid');
 if(!upload){if(!await ctx.checkpoint({upload_create_started_at:new Date().toISOString(),mime:inferred,total:chunk.total}))throw new RecordingProcessingError('lease_lost');const path=recordingStoragePath(ctx,inferred);const metadata=Object.entries({bucketName:RECORDINGS_BUCKET,objectName:path,contentType:inferred,cacheControl:'0'}).map(([k,v])=>`${k} ${Buffer.from(v).toString('base64')}`).join(',');const created=await storageRequest('/storage/v1/upload/resumable',{method:'POST',headers:{'Tus-Resumable':'1.0.0','Upload-Length':String(chunk.total),'Upload-Metadata':metadata}},ctx.signal);if(!created.ok||!created.headers.get('location')){if(created.status>=400&&created.status<500&&created.status!==408)await ctx.checkpoint({upload_create_started_at:null});throw new RecordingProcessingError('upload_create_unconfirmed',true);}upload=validTusUrl(created.headers.get('location')!,cfg.base);
  if(!await ctx.checkpoint({upload_url:upload,upload_create_started_at:null,offset:0,total:chunk.total,etag:chunk.etag,mime:inferred,hash_state:hash} as Json))throw new RecordingProcessingError('lease_lost');}
 const after=updateRecordingHash(hash,chunk.bytes);const end=offset+chunk.bytes.length;
 if(!await ctx.checkpoint({pending_chunk:{end,hash_state:after}} as Json))throw new RecordingProcessingError('lease_lost');
 const patched=await storageRequest(upload,{method:'PATCH',headers:{'Tus-Resumable':'1.0.0','Upload-Offset':String(offset),'Content-Type':'application/offset+octet-stream'},body:new Uint8Array(chunk.bytes)},ctx.signal);
 if(!patched.ok||Number(patched.headers.get('upload-offset'))!==end)throw new RecordingProcessingError('upload_patch_unconfirmed',true);
 if(!await ctx.checkpoint({offset:end,hash_state:after,pending_chunk:null} as Json))throw new RecordingProcessingError('lease_lost');
 return {state:'queued',nextAttemptAt:new Date().toISOString()};
}
export async function deleteRecordingStorage(ctx:RecordingJobContext){
 const r=ctx.recording;if(!r)return;
 const upload=record(ctx.job.checkpoint).upload_url;if(typeof upload==='string'){const cfg=storageConfig();const res=await storageRequest(validTusUrl(upload,cfg.base),{method:'DELETE',headers:{'Tus-Resumable':'1.0.0'}},ctx.signal);if(!res.ok&&res.status!==404&&res.status!==410)throw new RecordingProcessingError('upload_cleanup_failed',true);}
 const paths=[...new Set([r.storage_path,recordingStoragePath(ctx,'audio/wav'),recordingStoragePath(ctx,'audio/mpeg')].filter((p):p is string=>Boolean(p)))];
 if(paths.length){const res=await storageRequest(`/storage/v1/object/${RECORDINGS_BUCKET}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:paths})},ctx.signal);if(!res.ok&&res.status!==404)throw new RecordingProcessingError('storage_delete_failed',true);}
}
