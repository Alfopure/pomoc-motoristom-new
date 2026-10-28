import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Supabase session refresh for server-rendered pages; never redirects or blocks.
 * Not an auth gate: the security audit ADR (docs/bezpecnostny-audit-a-plan.md)
 * keeps authorization in every route, page and RPC.
 */
export function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Pages (including their RSC and Server Function requests) only. Skipped:
     * - every /api route: provider webhooks, cron, bearer and mobile clients stay
     *   untouched; session routes refresh and write cookies themselves
     * - _next/ (static files, image optimization, HMR)
     * - /auth/callback, which writes the new session cookies itself
     * - generated icons and static files (favicon, sw.js, manifests, public
     *   images and sounds). Listed explicitly: a page's own `.rsc` and
     *   `.segments/….segment.rsc` transport forms must still match.
     */
    "/((?!api(?:/|$)|_next/|auth/callback(?:/|$)|(?:apple-)?icon(?:-\\d+)?(?:/|$)|.*\\.(?:ico|png|jpe?g|gif|svg|webp|avif|js|css|map|txt|xml|json|md|webmanifest|woff2?|mp3|wav|ogg)$).*)",
  ],
};
