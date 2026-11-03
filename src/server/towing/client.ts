import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createSupabaseAdminClient } from '@/lib/supabase/admin';
// Additive module schema is deployed independently; never expose this client to the browser.
export function towingAdmin(): SupabaseClient { return createSupabaseAdminClient() as unknown as SupabaseClient; }
