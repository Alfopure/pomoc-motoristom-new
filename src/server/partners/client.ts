import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { MutationError } from '@/server/mutation-error';
export function partnerAdmin(): SupabaseClient { return createSupabaseAdminClient() as unknown as SupabaseClient; }
export function partnerCheck(error: { message: string; code?: string } | null) { if (error) throw new MutationError(error.code === '42501' ? 'Nemáte oprávnenie k tomuto partnerskému záznamu.' : error.message, error.code === '42501' ? 403 : error.code === '40001' || error.code === '23505' ? 409 : 400); }
export function partnerResponse(error: unknown) { return Response.json({ error: error instanceof MutationError ? error.message : 'Partnerský modul nie je dostupný.' }, { status: error instanceof MutationError ? error.status : 503, headers: { 'Cache-Control': 'private, no-store' } }); }
export function uuid(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new MutationError('Neplatný identifikátor.', 400); return value; }
