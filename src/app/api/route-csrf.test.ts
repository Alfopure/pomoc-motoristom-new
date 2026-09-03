import { describe, expect, it, vi } from "vitest";
import { ROUTE_AUTH_REGISTRY } from "@/server/route-auth-registry";

// TS nepozná Vite `import.meta.glob` (vite/client typy nie sú v tsconfig) → lokálna ambientná deklarácia.
declare global {
  interface ImportMeta {
    glob: (pattern: string) => Record<string, () => Promise<Record<string, unknown>>>;
  }
}

/**
 * 1.4 (US-103) — CSRF same-origin coverage pre session-mutačné routes (bezpečnostný audit, Milestone 1).
 *
 * Pravidlo (acceptance): KAŽDÁ route klasifikovaná `session` v registri, ktorá exportuje POST/PUT/PATCH/DELETE,
 * musí anonymnému requestu s MISMATCHED Origin vrátiť STRIKTNE 403 — a to PRED auth vrstvou (403, nie 401,
 * dokazuje, že CSRF beží prvé). Množina sa derivuje PROGRAMATICKY z registra (žiaden hardcoded zoznam).
 *
 * Používa ten istý verný Supabase mock-harness ako route-auth.test.ts (getUser=null, seedovaná org, secrets),
 * aby o výsledku rozhodovala CSRF/auth vrstva, nie chýbajúce env (500).
 *
 * Časti:
 *  (a) session ∩ {POST,PUT,PATCH,DELETE} + MISMATCHED Origin → 403 (CSRF beží pred auth).
 *  (b) vzorová session-mutačná route + MATCHING same-origin → 401 (prejde CSRF, padne na auth).
 *  (c) bearer / dual-cron handler s platným tokenom a BEZ Origin → NIE 403 (CSRF ich neovplyvňuje).
 */

const { SEED_ORG_ID, makeQueryStub } = vi.hoisted(() => {
  const SEED_ORG_ID = "00000000-0000-0000-0000-000000000001";

  function makeQueryStub(result: unknown): unknown {
    const resolved = { data: result ?? null, error: null };
    const stub: unknown = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") {
          return (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
            Promise.resolve(resolved).then(onFulfilled, onRejected);
        }
        if (prop === "catch") {
          return (onRejected: (reason: unknown) => unknown) => Promise.resolve(resolved).catch(onRejected);
        }
        if (prop === "finally") {
          return (onFinally: () => void) => Promise.resolve(resolved).finally(onFinally);
        }
        return () => stub;
      },
      apply() {
        return stub;
      },
    });
    return stub;
  }

  return { SEED_ORG_ID, makeQueryStub };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    from: () => makeQueryStub(null),
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: () => ({
    from: (table: string) =>
      table === "motorist_organizations"
        ? makeQueryStub({ id: SEED_ORG_ID, slug: "pomoc-motoristom", active: true })
        : makeQueryStub(null),
  }),
}));

// Part (c) verifies only the bearer/CSRF boundary. These handlers normally continue
// into live integration jobs after authorization, and Vercel production builds have
// production environment variables. Keep the contract test deterministic and
// guarantee that a build can never contact an integration or start a real sync.
vi.mock("@/server/task-notifications", () => ({
  materializeDueTaskReminders: vi.fn(async () => ({ created: 0, skipped: 0 })),
}));

vi.mock("@/server/webdispecink-sync", () => ({
  syncWebdispecinkFleet: vi.fn(async () => ({ mode: "positions", processed: 0 })),
}));

vi.mock("@/server/integrations/commander/sync", () => ({
  isCommanderConfigError: () => false,
  syncCommander: vi.fn(async () => ({ status: "success" })),
}));

vi.mock("@/server/telephony/transcripts-process", () => ({
  TranscriptsProcessError: class TranscriptsProcessError extends Error {
    status = 500;
  },
  processTranscripts: vi.fn(async () => ({ status: "disabled", processed: 0, failed: 0, errors: [] })),
}));

// Neutrálne test tajomstvá pre bearer / dual-cron vetvy (part c) — inak by padli na 500 "secret not configured".
process.env.COMMANDER_SYNC_SECRET = "test-commander-sync-secret";
process.env.RECORDINGS_SYNC_SECRET = "test-recordings-sync-secret";
process.env.WEBDISPECINK_SYNC_TOKEN = "test-webdispecink-sync-token";
process.env.MOTORIST_NOTIFICATIONS_CRON_SECRET = "test-notifications-cron-secret";
// CSRF flip (:227) je DEFERRED — no-Origin ostáva permisívne; tento test to nespochybňuje.

// PUT patrí do množiny od Fázy 3 (`telephony/config/*` používa PUT na výmenu celej sekcie dokumentu).
const MUTATING_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;
type MutatingMethod = (typeof MUTATING_METHODS)[number];
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response> | Response;

function routeKeyFromGlob(globPath: string): string {
  return globPath.replace(/^\.\//, "").replace(/\/route\.ts$/, "");
}

function stubParams(): Promise<Record<string, string>> {
  return Promise.resolve({ id: "00000000-0000-0000-0000-000000000002", token: "stub-token" });
}

/** MISMATCHED Origin: expectedOrigin (z x-forwarded-host/proto) = https://app.local, ale Origin = evil → 403. */
function mismatchedOriginRequest(route: string, method: MutatingMethod): Request {
  const headers: Record<string, string> = {
    origin: "https://evil.example",
    "x-forwarded-host": "app.local",
    "x-forwarded-proto": "https",
    "content-type": "application/json",
  };
  return new Request(`https://app.local/api/${route}`, { method, headers, body: "{}" });
}

/** MATCHING same-origin: Origin === expectedOrigin → CSRF prejde, o výsledku rozhodne AUTH. */
function sameOriginRequest(route: string, method: MutatingMethod): Request {
  const headers: Record<string, string> = {
    origin: "https://app.local",
    "x-forwarded-host": "app.local",
    "x-forwarded-proto": "https",
    "content-type": "application/json",
  };
  return new Request(`https://app.local/api/${route}`, { method, headers, body: "{}" });
}

async function statusFor(handler: Handler, request: Request): Promise<number> {
  const response = await handler(request, { params: stubParams() });
  return response.status;
}

// Dynamicky importuj VŠETKY route.ts pod src/app/api (mocky sú hoisted → aplikujú sa).
const routeModules = import.meta.glob("./**/route.ts");

type MutatingCase = { route: string; method: MutatingMethod; handler: Handler; class: string };
const mutatingCases: MutatingCase[] = [];

for (const [globPath, importer] of Object.entries(routeModules)) {
  const route = routeKeyFromGlob(globPath);
  const entry = ROUTE_AUTH_REGISTRY[route];

  if (!entry) {
    continue;
  }

  const mod = await importer();

  for (const method of MUTATING_METHODS) {
    if (typeof mod[method] === "function") {
      mutatingCases.push({ route, method, handler: mod[method] as Handler, class: entry.class });
    }
  }
}

/** Session-mutačná množina odvodená PROGRAMATICKY z registra (class === "session"). */
const sessionMutatingCases = mutatingCases.filter((entry) => entry.class === "session");

describe("route-csrf coverage (US-103)", () => {
  it("derives a non-empty session-mutating set from the registry", () => {
    // Sanity: broken glob/registry by inak vyrobil prázdnu množinu → falošné zelené (a).
    expect(sessionMutatingCases.length).toBeGreaterThan(20);
  });

  it("CANARY: the mismatched-origin request would fail a handler with no CSRF check", async () => {
    // Fixture bez CSRF vráti 200 aj na mismatched Origin → dôkaz, že 403 nižšie pochádza z reálnej CSRF kontroly.
    const fixture: Handler = async () => Response.json({ ok: true });
    const status = await statusFor(fixture, mismatchedOriginRequest("canary/fixture", "POST"));
    expect(status).toBe(200);
  });

  it.each(sessionMutatingCases.map((entry) => ({ ...entry, name: `${entry.method} ${entry.route}` })))(
    "(a) $name returns 403 to an anon request with a MISMATCHED Origin (CSRF runs before auth)",
    async ({ route, method, handler, name }) => {
      const status = await statusFor(handler, mismatchedOriginRequest(route, method));
      expect(status, `${name} mala vrátiť 403 (CSRF mismatch), ale vrátila ${status} — CSRF chýba alebo nie je prvé`).toBe(403);
    },
  );

  it("(b) POST cases (session-mutating) passes CSRF on same-origin and falls to auth -> 401", async () => {
    const found = sessionMutatingCases.find((entry) => entry.route === "cases" && entry.method === "POST");
    expect(found, "POST cases handler not found").toBeDefined();

    const status = await statusFor(found!.handler, sameOriginRequest("cases", "POST"));
    expect(status).toBe(401);
  });

  it("(b) POST telephony/calls/[id]/link-case (motoristAccessGuard) passes CSRF on same-origin and falls to auth -> 401", async () => {
    const found = sessionMutatingCases.find((entry) => entry.route === "telephony/calls/[id]/link-case" && entry.method === "POST");
    expect(found, "POST telephony/calls/[id]/link-case handler not found").toBeDefined();

    const status = await statusFor(found!.handler, sameOriginRequest("telephony/calls/[id]/link-case", "POST"));
    expect(status).toBe(401);
  });

  it("(c) bearer / dual-cron handlers with a valid token and NO Origin are NOT 403 (CSRF unaffected)", async () => {
    const bearerCases: Array<{ route: string; method: MutatingMethod | "GET"; token: string }> = [
      // dual — bearer (cron) sub-vetva: CSRF sa smie pridať len do session sub-vetvy.
      { route: "notifications/materialize", method: "POST", token: "test-notifications-cron-secret" },
      // dual — cron GET vetva (žiaden CSRF).
      { route: "integrations/fleet/webdispecink/sync", method: "GET", token: "test-webdispecink-sync-token" },
      // pure bearer (nikdy nemá CSRF).
      { route: "integrations/commander/sync", method: "POST", token: "test-commander-sync-secret" },
      { route: "telephony/transcripts/process", method: "POST", token: "test-recordings-sync-secret" },
    ];

    for (const { route, method, token } of bearerCases) {
      const importer = routeModules[`./${route}/route.ts`];
      expect(importer, `route module ${route} not found`).toBeTruthy();

      const mod = await importer();
      const handler = mod[method] as Handler | undefined;
      expect(handler, `${method} ${route} handler not found`).toBeTypeOf("function");

      // Bez Origin hlavičky, s platným bearer tokenom.
      const request = new Request(`https://app.local/api/${route}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      });

      const response = await handler!(request, { params: stubParams() });
      expect(response.status, `${method} ${route} (bearer, no Origin) nesmie byť 403`).not.toBe(403);
    }
  });

  it("(d) dual-route session sub-branch (no bearer token) enforces CSRF on mismatched Origin -> 403", async () => {
    // Dual routes sú v registri `class: "dual"`, takže ich part (a) nepokrýva. Session sub-vetva (bez bearer
    // tokenu) ale MUSÍ vynucovať CSRF — inak by mismatch prešiel. Over obe dual routes strojovo.
    const dualSessionCases: Array<{ route: string; method: MutatingMethod }> = [
      { route: "notifications/materialize", method: "POST" },
      { route: "integrations/fleet/webdispecink/sync", method: "POST" },
    ];

    for (const { route, method } of dualSessionCases) {
      const importer = routeModules[`./${route}/route.ts`];
      expect(importer, `route module ${route} not found`).toBeTruthy();

      const mod = await importer();
      const handler = mod[method] as Handler | undefined;
      expect(handler, `${method} ${route} handler not found`).toBeTypeOf("function");

      // Žiaden Authorization header → session sub-vetva; mismatched Origin → CSRF → 403.
      const status = await statusFor(handler!, mismatchedOriginRequest(route, method));
      expect(status, `${method} ${route} (dual session sub-vetva, mismatch Origin) mala vrátiť 403`).toBe(403);
    }
  });
});
