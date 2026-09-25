type SupabasePublicEnv = {
  url: string;
  publicKey: string;
};

type SupabaseServiceEnv = SupabasePublicEnv & {
  serviceKey: string;
  /**
   * HMAC secret for application-issued proofs (SMS drafts). It stays the key
   * the application always signed with, independent of which key the database
   * client prefers, so proofs issued before a key-order change keep verifying.
   */
  signingSecret?: string;
};

function firstPresent(...values: Array<string | undefined>) {
  return values.find((value) => value && value.trim().length > 0);
}

export function getSupabasePublicEnv(): SupabasePublicEnv | null {
  const url = firstPresent(process.env.SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_URL);
  const publicKey = firstPresent(
    process.env.SUPABASE_PUBLISHABLE_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  if (!url || !publicKey) {
    return null;
  }

  return { url, publicKey };
}

export function requireSupabasePublicEnv(): SupabasePublicEnv {
  const env = getSupabasePublicEnv();

  if (!env) {
    throw new Error(
      "Missing Supabase public environment. Set SUPABASE_URL plus SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY; NEXT_PUBLIC_* aliases are also supported.",
    );
  }

  return env;
}

/** A legacy JWT API key (`eyJ…`), as opposed to an opaque `sb_secret_…` key. */
function isJwtKey(value: string | undefined): value is string {
  return Boolean(value && value.trim().startsWith("eyJ"));
}

/**
 * The server-side key.
 *
 * The legacy `service_role` JWT is preferred when it is configured. Measured
 * on production 25 Sep, same read mix at 20 requests/s: the `sb_secret_` key
 * cost ~36 ms of database-instance CPU per request (the gateway mints a fresh
 * JWT for every call, so PostgREST also never hits its JWT cache), the legacy
 * JWT under 1 ms; gateway latency p50/p95 66/294 ms against 28/37 ms. With
 * `sb_secret_` the Medium instance saturated at ~30-40 requests/s, which is
 * what the dispatch console reached with three or four operators.
 *
 * `SUPABASE_PREFER_SECRET_KEY=true` restores the previous order without a code
 * change, e.g. once legacy keys are disabled for the project.
 */
export function selectServiceKey(env: Record<string, string | undefined> = process.env): string | undefined {
  const secret = firstPresent(env.SUPABASE_SECRET_KEY);
  const legacy = firstPresent(env.SUPABASE_SERVICE_ROLE_KEY);
  if (env.SUPABASE_PREFER_SECRET_KEY === "true") return firstPresent(secret, legacy);
  return isJwtKey(legacy) ? legacy : firstPresent(secret, legacy);
}

export function getSupabaseServiceEnv(): SupabaseServiceEnv | null {
  const publicEnv = getSupabasePublicEnv();
  const serviceKey = selectServiceKey();

  if (!publicEnv || !serviceKey) {
    return null;
  }

  return { ...publicEnv, serviceKey, signingSecret: firstPresent(process.env.SUPABASE_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY) };
}

export function requireSupabaseServiceEnv(): SupabaseServiceEnv {
  const env = getSupabaseServiceEnv();

  if (!env) {
    throw new Error(
      "Missing Supabase service environment. Set public Supabase env plus SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return env;
}

export function getSupabaseProjectRef() {
  return firstPresent(process.env.SUPABASE_PROJECT_REF);
}
