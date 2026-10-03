import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const EMAIL_OTP_TYPES: EmailOtpType[] = ["signup", "invite", "magiclink", "recovery", "email_change", "email"];

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const tokenHash = requestUrl.searchParams.get("token_hash");
  const type = toEmailOtpType(requestUrl.searchParams.get("type"));
  const next = safeInternalUrl(requestUrl.searchParams.get("next"), requestUrl.origin);

  if (tokenHash && type) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  } else if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  return NextResponse.redirect(next);
}

function toEmailOtpType(value: string | null): EmailOtpType | null {
  return EMAIL_OTP_TYPES.find((candidate) => candidate === value) ?? null;
}

function safeInternalUrl(value: string | null, origin: string): URL {
  const fallback = new URL("/", origin);
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }

  try {
    const parsed = new URL(value, origin);
    // Normalization can create // paths or interpret backslashes as a host.
    // Keep the validated URL intact instead of parsing its pathname again.
    return parsed.origin === origin && !parsed.pathname.startsWith("//") ? parsed : fallback;
  } catch {
    return fallback;
  }
}
