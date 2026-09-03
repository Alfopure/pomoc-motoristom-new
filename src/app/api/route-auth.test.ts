/**
 * Fail-closed enumeračný test (bezpečnostný audit, Milestone 0.2 — regresný zámok).
 *
 * Prejde VŠETKY `src/app/api/**​/route.ts`, každý exportovaný GET/POST/PUT/PATCH/DELETE zavolá
 * ako NEautentifikovaný request a tvrdí, že vráti 401/403 — POKIAĽ nie je route MENOVITE na
 * verejnom allowliste. Žiadna heuristika podľa názvu. Cieľ: nová route nesmie omylom vzniknúť
 * bez auth (test padne, kým ju buď nezaguarduješ, alebo vedome nepridáš na allowlist).
 *
 * Supabase je zamockovaný: admin vráti platnú org (aby prešlo resolveDefaultOrganizationId),
 * server vráti `user: null` (→ guard = 401). Bearer secrety sú nastavené, aby bearer routes
 * bez hlavičky vrátili 401 (nie 500 z „secret nie je nakonfigurovaný").
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { PUBLIC_ROUTES as REGISTRY_PUBLIC_ROUTES } from "@/server/route-auth-registry";

// ── Supabase mocky (hoisted pred importom routes) ─────────────────────────────
function makeChainableQuery() {
  const single = { data: { id: "org-test-id", role: "admin", active: true }, error: null };
  const list = { data: [], error: null };
  const query: Record<string, unknown> = {
    maybeSingle: async () => single,
    single: async () => single,
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(list).then(resolve),
  };
  for (const method of ["select", "eq", "neq", "in", "is", "not", "gte", "lte", "gt", "lt", "order", "limit", "range", "or", "filter", "match", "contains", "overlaps", "insert", "update", "upsert", "delete"]) {
    query[method] = () => query;
  }
  return query;
}

function makeSupabaseStub() {
  return { from: () => makeChainableQuery(), rpc: async () => ({ data: null, error: null }) };
}

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => makeSupabaseStub(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    ...makeSupabaseStub(),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }),
}));

// ── Allowlist: iba tieto routes smú byť dostupné bez prihlásenia ──────────────
// Jediný zdroj pravdy je `ROUTE_AUTH_REGISTRY` (class: "public"); tento test
// z neho odvodzuje kľúče, takže sa obe strany nemôžu rozísť. Kľúč = cesta pod
// src/app/api (bez /route.ts), so zachovanými [param] segmentmi.
//
// Dnes sú to: /auth/forgot-password, /health/live, /health/ready,
// /public/location-links/[token], /telephony/telnyx/webhook (Ed25519 podpis),
// /sms/telnyx/webhook (Ed25519 podpis).
const PUBLIC_ROUTES = new Set<string>(REGISTRY_PUBLIC_ROUTES.map((route) => `/${route}`));

// Bearer secrety nastavíme, nech bearer/cron routes bez hlavičky vrátia 401 (nie 500).
const BEARER_SECRET_ENV = [
  "COMMANDER_SYNC_SECRET",
  "SWHOUSE_SYNC_SECRET",
  "RECORDINGS_SYNC_SECRET",
  "CRON_SECRET",
  "MOTORIST_NOTIFICATIONS_CRON_SECRET",
];

const API_ROOT = path.resolve(__dirname);
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findRouteFiles(full));
    } else if (entry.name === "route.ts") {
      out.push(full);
    }
  }
  return out;
}

function routeKey(file: string): string {
  const rel = path.relative(API_ROOT, path.dirname(file));
  return "/" + rel.split(path.sep).join("/");
}

function fakeRequest(routeKey: string, method: string): Request {
  const url = `https://app.test/api${routeKey.replace(/\[[^\]]+\]/g, "x")}${routeKey.includes("match") ? "?number=421900000000" : ""}`;
  const init: RequestInit = { method };
  if (method !== "GET") {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify({});
  }
  return new Request(url, init);
}

const routeFiles = findRouteFiles(API_ROOT);

describe("API route auth enumeration (fail-closed)", () => {
  beforeAll(() => {
    for (const name of BEARER_SECRET_ENV) {
      process.env[name] = `test-${name.toLowerCase()}`;
    }
  });

  it("finds a realistic number of API routes (parity canary)", () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(50);
  });

  it("every allowlisted route actually exists (no stale allowlist)", () => {
    const keys = new Set(routeFiles.map(routeKey));
    for (const pub of PUBLIC_ROUTES) {
      expect(keys, `allowlist má neexistujúcu route ${pub}`).toContain(pub);
    }
  });

  for (const file of routeFiles) {
    const key = routeKey(file);
    const isPublic = PUBLIC_ROUTES.has(key);

    it(`${key} ${isPublic ? "(verejná — preskočené)" : "vyžaduje auth (anon → 401/403)"}`, async () => {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      const handlers = HTTP_METHODS.filter((m) => typeof mod[m] === "function");
      expect(handlers.length, `route ${key} nemá žiadny HTTP handler`).toBeGreaterThan(0);

      if (isPublic) {
        return; // verejné neoverujeme na auth (majú vlastnú ochranu / sú zámerne anon)
      }

      for (const method of handlers) {
        const handler = mod[method] as (req: Request, ctx?: unknown) => Promise<Response> | Response;
        const context = { params: Promise.resolve({ id: "x", token: "x", caseId: "x" }) };
        let status: number | string;
        try {
          const res = await handler(fakeRequest(key, method), context);
          status = res?.status ?? "no-response";
        } catch (error) {
          // Guard hodil (route nechytá MutationError) — akceptuj len ak je to 401/403.
          status = (error as { status?: number })?.status ?? "threw";
        }
        expect([401, 403], `${method} ${key} — anon dostal ${status}, očakávané 401/403`).toContain(status);
      }
    });
  }
});
