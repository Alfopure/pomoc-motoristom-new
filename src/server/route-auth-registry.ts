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
  // ── public (6) ──────────────────────────────────────────────────────────
  "auth/forgot-password": { class: "public" },
  "health/live": { class: "public", note: "Sanitized infrastructure liveness probe." },
  "health/ready": { class: "public", note: "Sanitized dependency readiness probe." },
  "public/location-links/[token]": { class: "public" },
  // Telnyx webhooky: autentifikáciou je Ed25519 podpis (`telnyx-signature-ed25519` + `telnyx-timestamp`,
  // tolerancia 300 s) overený PRED akoukoľvek prácou; neplatný podpis → 400, cudzí `connection_id` → 200 ignored.
  "telephony/telnyx/webhook": { class: "public", note: "Telnyx Call Control webhook; Ed25519 signature verification namiesto session." },
  "sms/telnyx/webhook": { class: "public", note: "Telnyx messaging delivery-status webhook; Ed25519 signature verification." },

  // ── bearer (4) — zdieľané tajomstvo (cron/stroj) ────────────────────────
  // commander/* majú INLINE authorize() + safeEquals (COMMANDER_SYNC_SECRET + timingSafeEqual)
  "integrations/commander/sync": { class: "bearer" },
  "integrations/commander/import-all": { class: "bearer" },
  // telephony/cron: Vercel cron (*/5) s `Authorization: Bearer ${CRON_SECRET}` + timingSafeEqual
  "telephony/cron": { class: "bearer", note: "Vercel cron každých 5 minút; ring sweep, detekcia zaseknutých hovorov a prune webhook ledgera." },
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

  // telephony (provider-neutral routes + Telnyx call control)
  "telephony/calls": { class: "session", note: "Click-to-call; kill switch, rate limit 10/min a allowlist sú v call-actions." },
  "telephony/calls/active": { class: "session" },
  "telephony/calls/internal": { class: "session" },
  "telephony/calls/[id]/cancel-consult": { class: "session" },
  "telephony/calls/[id]/complete-transfer": { class: "session" },
  "telephony/calls/[id]/consult": { class: "session" },
  "telephony/calls/[id]/hangup": { class: "session" },
  "telephony/calls/[id]/hold": { class: "session" },
  "telephony/calls/[id]/park": { class: "session" },
  "telephony/calls/[id]/pickup": { class: "session" },
  "telephony/calls/[id]/add-party": { class: "session", note: "Pridá tretieho účastníka (kolegu alebo externé číslo) do konferencie hovoru; externé číslo prechádza rovnakým rate limitom a allowlistom ako vytáčanie." },
  "telephony/calls/[id]/leave": { class: "session", note: "Operátor odíde z trojstranného hovoru, zvyšní pokračujú." },
  "telephony/calls/[id]/parties/[legId]/kick": { class: "session" },
  "telephony/calls/[id]/parties/[legId]/mute": { class: "session" },
  "telephony/calls/[id]/parties/[legId]/unmute": { class: "session" },
  "telephony/calls/[id]/stop-supervise": { class: "session", role: ["manager", "admin"], note: "Ukončí vlastný dozor; role-gate je v call-actions (canSupervise)." },
  "telephony/calls/[id]/supervise": { class: "session", role: ["manager", "admin"], note: "Dozor nad cudzím hovorom (monitor/whisper/barge) cez Telnyx supervisor_role v konferencii; role-gate je v call-actions (canSupervise), dispečer dostane 403. Každý dozor zapisuje audit riadok." },
  "telephony/calls/[id]/transfer": { class: "session" },
  "telephony/calls/[id]/transfer-targets": { class: "session" },
  "telephony/calls/[id]/unhold": { class: "session" },
  // fronta spätných volaní (Fáza 4): čítanie aj akcie sú member-level v rámci
  // telefónie (dispatcher a vyššie, TELEPHONY_ROUTE_ROLES). Prevzatie cudzej
  // požiadavky je obmedzené na senior_dispatcher+ v callbacks.ts, nie rolou route.
  "telephony/callbacks": { class: "session", note: "Fronta spätných volaní; GET member-level, odpovedá aj keď telefónia nie je nakonfigurovaná (riadky sú bežné DB záznamy)." },
  "telephony/callbacks/[id]/call": { class: "session", note: "Spätné volanie cez bežnú odchádzajúcu cestu (kill switch, rate limit, allowlist); jediná callback route, ktorá vyžaduje nakonfigurovaného providera." },
  "telephony/callbacks/[id]/cancel": { class: "session" },
  "telephony/callbacks/[id]/claim": { class: "session" },
  "telephony/callbacks/[id]/done": { class: "session" },
  // konfigurácia telefónie (Fáza 3): čítanie member-level, zápis manager/admin,
  // nastavenia organizácie (kill switch, allowlist, limit čakárne) len admin.
  "telephony/config/business-hours": { class: "session", role: ["manager", "admin"], note: "GET je member-level (CONFIG_READ_ROLES), ale redigovaný: kill switche len admin, limity a allowlist manager/admin, cudzie SIP identity manager/admin. PUT manager/admin cez handleConfigWrite." },
  "telephony/config/ivr-menus": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný ako pri business-hours); PUT manager/admin — celé IVR menu aj s voľbami cez motorist_replace_ring_plan." },
  "telephony/config/numbers": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný ako pri business-hours); PATCH manager/admin. Kúpa čísla cez Telnyx nie je súčasťou tejto fázy." },
  "telephony/config/pause-reasons": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný); PUT manager/admin." },
  "telephony/config/ring-groups": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný); PUT manager/admin (transakčná výmena cez motorist_replace_ring_plan)." },
  "telephony/config/ring-plans": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný); PUT manager/admin (transakčná výmena cez motorist_replace_ring_plan)." },
  "telephony/config/settings": { class: "session", role: ["admin"], note: "Kill switche, allowlist cieľov a limit čakárne — GET aj PATCH len admin; rovnaké polia sú redigované aj v ostatných config GET." },
  "telephony/operators/[id]/credential": { class: "session", role: ["manager", "admin"], note: "Vytvorí alebo pregeneruje Telnyx SIP credential operátora; pri pregenerovaní zmaže pôvodný credential u Telnyxu (neúspech = 502)." },
  "telephony/operators/[id]/disconnect": { class: "session", role: ["manager", "admin"], note: "Odpojí prehliadačový telefón operátora (ďalší heartbeat dostane 409) a zmaže jeho Telnyx credential, aby sa starým tokenom nedalo znova zaregistrovať (neúspech = 502)." },
  "telephony/operators/[id]/settings": { class: "session", note: "PATCH vlastných nastavení (self) alebo cudzích (manager/admin)." },
  "telephony/devices/heartbeat": { class: "session", note: "Heartbeat prehliadačového telefónu; zastaraná device_session_id → 409." },
  "telephony/dev/simulate-inbound": { class: "session", role: ["admin"], note: "Vývojový simulátor prichádzajúceho hovoru; v produkcii (VERCEL_ENV=production) vracia 403." },
  "telephony/presence": { class: "session" },
  "telephony/presence/end-wrap-up": { class: "session" },
  "telephony/webphone/token": { class: "session", note: "Vydáva krátkodobý Telnyx WebRTC token a rotuje device_session_id." },
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
