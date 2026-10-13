import 'server-only';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import type { TowingMember } from '@/domain/towing/types';
import { actorRpcParams } from './auth';
import { towingAdmin } from './client';
import { boundedBytes, mapRpcError, privateHeaders, revision, TowingError, uuid } from './http';
import { executeTowingCommand } from './service';

export const TOWING_BUCKET = 'towing-documents';
export const MAX_TOWING_FILE = 10 * 1024 * 1024;
export function followupCommandId(commandId: string, stage: string) {
  const bytes = createHash('sha256').update(`${commandId}:${stage}`).digest(); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex').slice(0,32); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function sha256(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
export function verifyTowingFile(bytes: Buffer, declared: string) {
  const actual = bytes.length >= 8 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length-2] === 255 && bytes[bytes.length-1] === 217 ? 'image/jpeg'
    : bytes.length >= 8 && bytes.subarray(0,5).toString('ascii') === '%PDF-' && bytes.subarray(Math.max(0,bytes.length-1024)).includes(Buffer.from('%%EOF')) ? 'application/pdf' : null;
  if (!actual || actual !== declared) throw new TowingError('unsupported_file',415,'Použite platný JPEG, PNG alebo PDF súbor.');
  if (!bytes.length || bytes.length > MAX_TOWING_FILE) throw new TowingError('too_large',413,'Maximálna veľkosť prílohy je 10 MB.');
  return actual;
}
export async function verifyTowingImage(bytes: Buffer, mimeType: string) {
  if (mimeType === 'application/pdf') return;
  try {
    const image = sharp(bytes,{failOn:'error',limitInputPixels:20_000_000});
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width > 10000 || metadata.height > 10000 || (mimeType === 'image/png' ? metadata.format !== 'png' : metadata.format !== 'jpeg')) throw new Error('Image format');
    // Metadata alone accepts some truncated images; decoding verifies their pixel stream.
    await image.raw().toBuffer();
  } catch { throw new TowingError('unsupported_file',415,'Fotografia je poškodená alebo má príliš veľké rozlíšenie.'); }
}
export interface TowingFileMetadata { id: string; orderId: string; path: string; mimeType: string; name: string; size: number; status: string; sha256?: string; snapshot?: Record<string, unknown>; snapshotHash?: string; version?: number; kind?: 'work' | 'priced'; createdAt?: string }
export async function loadTowingFile(actor: TowingMember, id: string, kind: 'attachment' | 'document'): Promise<TowingFileMetadata> {
  const result = await towingAdmin().rpc('motorist_towing_file', { ...actorRpcParams(actor), p_id: uuid(id), p_kind: kind }); mapRpcError(result.error);
  const file = result.data as TowingFileMetadata | null;
  if (!file || !file.path?.startsWith(`${actor.organizationId}/`) || file.path.includes('..')) throw new TowingError('not_found',404,'Súbor nie je dostupný.');
  return file;
}
export async function readTowingFile(actor: TowingMember, id: string, kind: 'attachment' | 'document', orderId: string) {
  const file = await loadTowingFile(actor,id,kind);
  if (file.orderId !== orderId || file.status !== 'ready') throw new TowingError('not_found',404,'Súbor ešte nie je dostupný.');
  const result = await towingAdmin().storage.from(TOWING_BUCKET).download(file.path);
  if (result.error || !result.data) throw new TowingError('unavailable',503,'Súbor momentálne nie je dostupný.');
  if (result.data.size > MAX_TOWING_FILE) throw new TowingError('too_large',413,'Súbor je príliš veľký.');
  const bytes = Buffer.from(await result.data.arrayBuffer());
  if (file.sha256 && sha256(bytes) !== file.sha256) throw new TowingError('file_integrity',503,'Súbor sa nepodarilo overiť.');
  // Recheck after storage IO: reassignment/deactivation cannot authorize a stale signed URL.
  await loadTowingFile(actor,id,kind);
  return { file, bytes };
}
export function towingFileResponse(file: TowingFileMetadata, bytes: Buffer) {
  const name = file.name.replace(/[\r\n"\\/]/g,'_').slice(0,120) || 'priloha';
  return new Response(new Uint8Array(bytes), { headers: { ...privateHeaders, 'Content-Type': file.mimeType,
    'Content-Disposition': `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(name)}` } });
}
export async function storeImmutableFile(path: string, bytes: Buffer, mimeType: string) {
  const storage = towingAdmin().storage.from(TOWING_BUCKET);
  const upload = await storage.upload(path,bytes,{contentType:mimeType,upsert:false});
  if (!upload.error) return;
  // A retry may find its own existing object; compare bytes instead of overwriting it.
  if (String(upload.error.statusCode) !== '409' && !/already exists|duplicate/i.test(upload.error.message)) throw new TowingError('upload_failed',503,'Súbor sa nepodarilo uložiť.');
  const previous = await storage.download(path);
  if (previous.error || !previous.data || previous.data.size !== bytes.length || sha256(Buffer.from(await previous.data.arrayBuffer())) !== sha256(bytes))
    throw new TowingError('file_conflict',409,'Pod týmto identifikátorom už je iný súbor.');
}
export async function uploadTowingAttachment(actor: TowingMember, orderId: string, request: Request) {
  const contentType = request.headers.get('content-type');
  if (!contentType?.startsWith('multipart/form-data')) throw new TowingError('invalid_input',415,'Pošlite prílohu ako formulár.');
  const bytes = await boundedBytes(request,MAX_TOWING_FILE + 64_000);
  let form: FormData;
  try { form = await new Request(request.url,{method:'POST',headers:{'content-type':contentType},body:new Uint8Array(bytes)}).formData(); }
  catch { throw new TowingError('invalid_input',400,'Neplatný formulár.'); }
  const file = form.get('file');
  if (!(file instanceof File) || form.getAll('file').length !== 1) throw new TowingError('invalid_input',400,'Vyberte jeden súbor.');
  const fileBytes = Buffer.from(await file.arrayBuffer()); const mimeType = verifyTowingFile(fileBytes,file.type);
  await verifyTowingImage(fileBytes,mimeType);
  const id = uuid(form.get('attachmentId')); const commandId = uuid(form.get('commandId'));
  const kind = form.get('kind') ?? form.get('category');
  if (kind !== 'work' && kind !== 'handover' && kind !== 'scan') throw new TowingError('invalid_input',400,'Vyberte typ prílohy.');
  const rawRevision = form.get('expectedRevision') ?? form.get('baseRevision');
  const expectedRevision = revision(rawRevision === null ? undefined : Number(rawRevision));
  const generation = form.get('assignmentGeneration');
  const assignmentGeneration = generation === null ? undefined : revision(Number(generation));
  const name = file.name.replace(/[\r\n\\/]/g,'_').slice(0,120) || 'priloha';
  const intent = await executeTowingCommand(actor,{commandId,type:'attachment_intent',targetId:orderId,expectedRevision,assignmentGeneration,payload:{id,kind,name,mimeType,size:fileBytes.length}});
  const path = `${actor.organizationId}/${orderId}/${id}`;
  await storeImmutableFile(path,fileBytes,mimeType);
  const finalized = await executeTowingCommand(actor,{commandId:followupCommandId(commandId,'finalize'),type:'attachment_finalize',targetId:orderId,expectedRevision:intent.revision,assignmentGeneration,payload:{id,sha256:sha256(fileBytes)}});
  return {...finalized,commandId};
}
