import "server-only";

import { MutationError } from "./motorist-mutations";

type RateBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateBucket>();

export function assertRateLimit(key: string, options: { limit: number; windowMs: number; message?: string }) {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    return;
  }

  if (bucket.count >= options.limit) {
    throw new MutationError(options.message ?? "Príliš veľa pokusov. Skús to neskôr.", 429);
  }

  bucket.count += 1;
}

export function rateLimitKey(...parts: Array<string | null | undefined>) {
  return parts.map((part) => String(part || "unknown").toLowerCase()).join(":");
}

export function requestIp(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");

  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || "unknown";
  }

  return request.headers.get("x-real-ip") || "unknown";
}
