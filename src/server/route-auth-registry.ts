/**
 * Route-auth register — JEDINÝ konfiguračný zdroj pravdy o auth-triede každej API route
 * (bezpečnostný audit, Milestone 0, task 0.4).
 *
 * Kľúč = cesta route relatívna k `src/app/api/`, bez koncového `/route.ts`
 * (napr. `telephony/calls/history`, `public/location-links/[token]`).
 *
 * Triedy:
 *  - `public`  — bez akejkoľvek autentifikácie (anonymný prístup je zámer).
 *  - `bearer`  — chránené zdieľaným tajomstvom v `Authorization: Bearer …` (cron/stroj); anon bez tokenu → 401.
 *  - `dual`    — bearer (cron/stroj) ALEBO session; anon bez oboch → 401.
 *  - `session` — Supabase session guard (`requireDefaultMotorist*` / `motoristAccessGuard`); anon → 401/403.
 *
 * `role` je vyplnené LEN tam, kde route reálne používa role-gate (inak member-level prístup).
 *
 * DÔLEŽITÉ: modul je čisté dáta + typy. ŽIADEN `import "server-only"`, žiadne side-effecty —
 * musí byť importovateľný z testov (route-auth-registry.test.ts, route-auth.test.ts).
 */

export type RouteAuthClass = "public" | "bearer" | "dual" | "session";

export type MotoristRole = "dispatcher" | "senior_dispatcher" | "manager" | "admin";

export type RouteAuthEntry = {
  class: RouteAuthClass;
  /** Vyplnené len ak route reálne role-gatuje (napr. manager/admin). */
  role?: MotoristRole[];
  /** Voliteľná poznámka k netriviálnej klasifikácii. */
  note?: string;
};

export const ROUTE_AUTH_REGISTRY: Record<string, RouteAuthEntry> = {
  // ── public (4) ──────────────────────────────────────────────────────────
  "auth/forgot-password": { class: "public" },
  "health/live": { class: "public", note: "Sanitized infrastructure liveness probe." },
  "health/ready": { class: "public", note: "Sanitized dependency readiness probe." },
  "public/location-links/[token]": { class: "public" },

  // ── bearer (4) — zdieľané tajomstvo (cron/stroj) ────────────────────────
  // commander/* majú INLINE authorize() + safeEquals (COMMANDER_SYNC_SECRET + timingSafeEqual)
  "integrations/commander/sync": { class: "bearer" },
  "integrations/commander/import-all": { class: "bearer" },
  // transcripts/process cez authorizeRecordingsSync (RECORDINGS_SYNC_SECRET + timingSafeEqual)
  "telephony/transcripts/process": { class: "bearer" },
  // occupancy-sync: INLINE authorize() + safeEquals (SWHOUSE_SYNC_SECRET + timingSafeEqual)
  "integrations/swhouse/occupancy-sync": { class: "bearer" },

  // ── dual (2) — bearer (cron/stroj) ALEBO session ────────────────────────
  // webdispecink/sync: GET = cron bearer token, POST = session (manager/admin) + CSRF
  "integrations/fleet/webdispecink/sync": { class: "dual", role: ["manager", "admin"] },
  // notifications/materialize: Bearer ${secret} ALEBO session requireDefaultMotoristOrgMember
  "notifications/materialize": { class: "dual" },
  "notifications": { class: "session" },

  // ── session — Supabase session guard ────────────────────────────────────
  // attendance
  "attendance/copy": { class: "session", role: ["manager", "admin"] },
  "attendance/planning/bulk-shifts": { class: "session", role: ["manager", "admin"] },
  "attendance/requests": { class: "session" },
  "attendance/requests/[id]": { class: "session", role: ["manager", "admin"] },
  "attendance/requests/[id]/approve": { class: "session", role: ["manager", "admin"] },
  "attendance/requests/[id]/cancel": { class: "session" },
  "attendance/requests/[id]/decline": { class: "session", role: ["manager", "admin"] },
  "attendance/schedule-batches/[id]/publish": { class: "session", role: ["manager", "admin"] },
  "attendance/sessions/start": { class: "session" },
  "attendance/sessions/[id]/end": { class: "session" },
  "attendance/shifts": { class: "session", role: ["manager", "admin"] },
  "attendance/shifts/[id]": { class: "session", role: ["manager", "admin"] },
  "attendance/shifts/[id]/confirm": { class: "session" },
  "attendance/shifts/[id]/decline": { class: "session" },
  "attendance/shifts/[id]/publish": { class: "session", role: ["manager", "admin"] },

  // auth
  "auth/password-completed": { class: "session" },

  // branches
  branches: { class: "session", role: ["manager", "admin"] },

  // cases
  cases: { class: "session" },
  "cases/location-updates": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "cases/[id]": { class: "session" },
  "cases/[id]/actions": { class: "session" },
  "cases/[id]/assign": { class: "session" },
  "cases/[id]/attachments": { class: "session" },
  "cases/[id]/sms": { class: "session" },

  // fleet-assets
  "fleet-assets": { class: "session", role: ["manager", "admin"] },
  "fleet-assets/[id]": { class: "session", role: ["manager", "admin"] },

  // integrations (non-bearer/dual)
  "integrations/commander/vehicles/[id]": { class: "session" },
  "integrations/fleet/pairing": { class: "session", role: ["manager", "admin"] },
  "integrations/fleet/refresh": { class: "session", role: ["manager", "admin"] },
  "integrations/fleet/webdispecink/vehicles/[id]": { class: "session", role: ["manager", "admin"] },
  "integrations/swhouse/replacement-vehicles": { class: "session" },
  "integrations/swhouse/sync": { class: "session", role: ["manager", "admin"] },

  // maps
  "maps/route": { class: "session" },

  // notifications
  "notifications/[id]": { class: "session" },
  "notifications/[id]/read": { class: "session" },

  // partner-directory (správa adresára manager/admin; rýchle pridanie asistenčky pre členov organizácie)
  "partner-directory": { class: "session", role: ["manager", "admin"] },
  "partner-directory/assistance": { class: "session" },
  "partner-directory/backfill-assistance": { class: "session", role: ["manager", "admin"] },
  "partner-directory/[id]": { class: "session", role: ["manager", "admin"] },

  // reports
  "reports/dashboard": { class: "session" },

  // SMS
  "sms/send": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },

  // telephony (provider-neutral routes; call control returns with the Telnyx provider)
  "telephony/calls/[id]/link-case": { class: "session" },
  "telephony/calls/[id]/outcome": { class: "session" },
  "telephony/calls/[id]/transcript": { class: "session", role: ["senior_dispatcher", "manager", "admin"] },
  "telephony/calls/history": { class: "session" },
  "telephony/calls/match": { class: "session" },
  "telephony/directory": { class: "session" },
  "telephony/directory/favorites": { class: "session" },
  "telephony/directory/favorites/[contactId]": { class: "session" },
  "telephony/qa/dashboard": { class: "session", role: ["senior_dispatcher", "manager", "admin"] },

  // users
  users: { class: "session", role: ["manager", "admin"] },
  "users/[id]": { class: "session", role: ["manager", "admin"] },
  "users/[id]/access/reset-password": { class: "session", role: ["manager", "admin"] },
  "users/[id]/access/send": { class: "session", role: ["manager", "admin"] },
};

/** Množina `public` routes — jediný pohľad, ktorý 0.2 enumeračný test číta (len na parity assert). */
export const PUBLIC_ROUTES: readonly string[] = Object.entries(ROUTE_AUTH_REGISTRY)
  .filter(([, entry]) => entry.class === "public")
  .map(([route]) => route);
