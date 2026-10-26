import 'server-only';
import { randomUUID } from 'node:crypto';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { getOperationsWorkspace } from './index';
import { TowingError, boundedBytes } from '@/server/towing/http';

const BUCKET = 'motorist-operation-evidence';
const MAX_BYTES = 4 * 1024 * 1024;
const extensions: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

async function access(operationId: string, writing = false) {
  const workspace = await getOperationsWorkspace({ id: operationId });
  const operation = workspace.operations.find(item => item.id === operationId);
  if (!operation || (operation.owner !== 'logistics' && !(workspace.actor.canDispatch && operation.cycleId))) throw new TowingError('not_found', 404, 'Jazda nie je dostupná.');
  if (writing && !workspace.actor.canDispatch && ['completed', 'cancelled'].includes(operation.status)) {
    throw new TowingError('access_denied', 403, 'Doklady k ukončenej jazde doplní dispečer.');
  }
  return { actor: workspace.actor, operation };
}

function matchesType(bytes: Buffer, type: string) {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return bytes.toString('ascii', 0, 5) === '%PDF-';
}

export async function uploadOperationFile(operationId: string, request: Request) {
  const { actor } = await access(operationId, true);
  const type = request.headers.get('content-type')?.split(';')[0] ?? '';
  if (!extensions[type]) throw new TowingError('invalid_file', 415, 'Nahrajte fotografiu JPG, PNG, WebP alebo PDF.');
  const bytes = await boundedBytes(request, MAX_BYTES);
  if (!bytes.length || !matchesType(bytes, type)) throw new TowingError('invalid_file', 400, 'Obsah súboru nezodpovedá jeho typu.');
  const reference = `${actor.organizationId}/${operationId}/${randomUUID()}.${extensions[type]}`;
  const result = await createSupabaseAdminClient().storage.from(BUCKET).upload(reference, bytes, { contentType: type, upsert: false });
  if (result.error) throw new TowingError('storage_unavailable', 503, 'Nahratie dokladu sa nepodarilo potvrdiť.');
  // Recheck current assignment after the storage operation as well.
  await access(operationId, true);
  return { reference };
}

export async function downloadOperationFile(operationId: string, reference: string) {
  const { actor, operation } = await access(operationId);
  const prefix = `${actor.organizationId}/${operationId}/`;
  if (!reference.startsWith(prefix) || !/^[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$/.test(reference.slice(prefix.length)) || !operation.evidence.some(item => item.photoReference === reference)) {
    throw new TowingError('not_found', 404, 'Doklad nie je dostupný.');
  }
  const result = await createSupabaseAdminClient().storage.from(BUCKET).download(reference);
  if (result.error || !result.data) throw new TowingError('not_found', 404, 'Doklad nie je dostupný.');
  await access(operationId);
  return new Response(await result.data.arrayBuffer(), { headers: {
    'Content-Type': result.data.type || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="doklad-jazdy.${reference.split('.').at(-1)}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
