type SupabasePublicEnv = {
  url: string;
  publicKey: string;
};

type SupabaseServiceEnv = SupabasePublicEnv & {
  serviceKey: string;
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

export function getSupabaseServiceEnv(): SupabaseServiceEnv | null {
  const publicEnv = getSupabasePublicEnv();
  const serviceKey = firstPresent(process.env.SUPABASE_SECRET_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (!publicEnv || !serviceKey) {
    return null;
  }

  return { ...publicEnv, serviceKey };
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
