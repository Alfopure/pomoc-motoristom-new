import 'server-only';

export class TowingError extends Error {
  constructor(public code: string, public status: number, message: string) { super(message); }
}
export const privateHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie' };
export function towingJson(body: unknown, status = 200) { return Response.json(body, { status, headers: privateHeaders }); }
export function towingErrorResponse(error: unknown) {
  if (error instanceof TowingError) return towingJson({ error: error.message, code: error.code }, error.status);
  return towingJson({ error: 'Zákazky momentálne nie sú dostupné.', code: 'unavailable' }, 503);
}
export function assertTowingOrigin(request: Request) {
  const origin = request.headers.get('origin');
  // Browsers always send Origin for our JSON/form mutations. Never inherit the legacy dev bypass.
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site')
    throw new TowingError('origin_rejected', 403, 'Požiadavka neprešla bezpečnostnou kontrolou.');
}
export function uuid(value: unknown, label = 'Identifikátor'): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new TowingError('invalid_input', 400, `${label} nie je platný.`);
  return value;
}
export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TowingError('invalid_input', 400, 'Neplatná verzia záznamu.');
  return Number(value);
}
export async function boundedBytes(request: Request, max: number) {
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > max)) throw new TowingError('too_large', 413, 'Súbor alebo požiadavka je príliš veľká.');
  const reader = request.body?.getReader();
  if (!reader) throw new TowingError('invalid_input', 400, 'Chýba obsah požiadavky.');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > max) { await reader.cancel(); throw new TowingError('too_large', 413, 'Súbor alebo požiadavka je príliš veľká.'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function boundedJson(request: Request, max = 256_000): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new TowingError('invalid_input', 415, 'Požiadavka musí obsahovať JSON.');
  try { const value: unknown = JSON.parse((await boundedBytes(request, max)).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) { if (error instanceof TowingError) throw error; throw new TowingError('invalid_input', 400, 'Neplatná požiadavka.'); }
}
export function mapRpcError(error: { code?: string } | null) {
  if (!error) return;
  const code = error.code;
  if (code === '42501') throw new TowingError('access_denied', 403, 'Na túto operáciu nemáte oprávnenie.');
  if (code === 'PT409' || code === '23505') throw new TowingError('revision_conflict', 409, 'Údaje sa zmenili. Obnovte zákazku a skontrolujte zmeny.');
  if (code === 'P0002') throw new TowingError('not_found', 404, 'Záznam nie je dostupný.');
  if (code === '22023' || code === '23514' || code === '22P02' || code === '22007' || code === '22008' || code === '22001') throw new TowingError('invalid_input', 400, 'Skontrolujte povinné údaje a stav zákazky.');
  throw new TowingError('unavailable', 503, 'Zákazky momentálne nie sú dostupné.');
}
