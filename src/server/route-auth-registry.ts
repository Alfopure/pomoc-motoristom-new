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
 *  - `user-bearer` — verified Supabase user JWT + active organization profile; no cookies or machine secrets.
 *  - `field-bearer` — verified Supabase user JWT + active field membership with the needed capability;
 *    no dispatch profile, cookies or machine secrets (pristavovač in the mobile app).
 *  - `delivery-tracker` — a per-delivery secret issued to the pristavovač over `field-bearer`
 *    (`Authorization: Tracker …`, only its hash stored); it only adds positions to that open delivery.
 *
 * `role` je vyplnené LEN tam, kde route reálne používa role-gate (inak member-level prístup).
 *
 * DÔLEŽITÉ: modul je čisté dáta + typy. ŽIADEN `import "server-only"`, žiadne side-effecty —
 * musí byť importovateľný z testov (route-auth-registry.test.ts, route-auth.test.ts).
 */

export type RouteAuthClass = "public" | "bearer" | "dual" | "session" | "user-bearer" | "field-bearer" | "delivery-tracker";

export type MotoristRole = "dispatcher" | "senior_dispatcher" | "manager" | "admin";

export type RouteAuthEntry = {
  class: RouteAuthClass;
  /** Vyplnené len ak route reálne role-gatuje (napr. manager/admin). */
  role?: MotoristRole[];
  /** Voliteľná poznámka k netriviálnej klasifikácii. */
  note?: string;
};

export const ROUTE_AUTH_REGISTRY: Record<string, RouteAuthEntry> = {
  operations: { class: 'session', note: 'Current dispatch profile or active deliver membership; organization-scoped RPC authorizes every command.' },
  'operations/[id]': { class: 'session', note: 'Current organization and assignment checked by operations RPC; revisions and immutable command receipts.' },
  'operations/[id]/files': { class: 'session', note: 'Current operation access on every upload/download; private storage, validated MIME/size and explicit evidence reference.' },
  partners: { class: 'session', note: 'Dispatch profile for office commands; portal read requires current versioned partner membership and explicit share.' },
  'partners/outputs/[id]': { class: 'session', note: 'Private immutable output/PDF; current dispatcher or active partner member plus unrevoked share on every request.' },
  "towing/workspace": { class: "session", note: "Isolated auth.users towing membership; capability and own assignment projection, no legacy profile role." },
  "towing/access": { class: "session", note: "Identity-bound driver access/lease; explicit verified revocation codes." },
  "towing/commands": { class: "session", note: "Same-origin, current towing capability, atomic revision and command receipts." },
  "towing/orders/[id]/attachments": { class: "session", note: "Own assignment or office capability; private verified file proxy." },
  "towing/orders/[id]/documents": { class: "session", note: "Towing document capability, immutable version and private download." },
  "towing/orders/[id]/email": { class: "session", note: "Towing document capability, explicit recipient/version and deduplicated delivery." },
  "towing/memberships": { class: "session", note: "Towing members capability; isolated onboarding without legacy driver profiles." },
  "towing/sources": { class: "session", note: "Towing operate capability; bounded case snapshot choices in own organization." },
  "towing/reports": { class: "session", note: "Towing report capability; bounded UTC performance, invoice and receipt periods." },
  "towing/auth/forgot-password": { class: "public", note: "Same-origin, throttled non-enumerating recovery for existing towing accounts only." },
  "mobile/v1/me": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "mobile/v1/push/register": { class: "user-bearer", note: "This installation's Expo push token and per-type switches for a dispatcher profile or a pristavovač field member; off unless MOBILE_PUSH_ENABLED." },
  "mobile/v1/push/unregister": { class: "user-bearer", note: "Removes this installation from push delivery, for a dispatcher or a pristavovač." },
  "mobile/v1/field/me": { class: "field-bearer", note: "Pristavovač identity: active field membership with the deliver capability; off unless MOBILE_DELIVERY_ENABLED." },
  "mobile/v1/field/deliveries": { class: "field-bearer", note: "Only handoffs sent to this pristavovač in the app; service-role RPC re-checks membership and version." },
  "mobile/v1/field/deliveries/[id]": { class: "field-bearer", note: "One own delivery; opening marks it seen." },
  "mobile/v1/field/deliveries/[id]/commands": { class: "field-bearer", note: "Own delivery steps with revision, receipts and dispatcher notice, as the public link." },
  "mobile/v1/field/deliveries/[id]/position": { class: "field-bearer", note: "Position only during an accepted own delivery; throttled, kept 30 days." },
  "mobile/v1/field/deliveries/[id]/tracker": { class: "field-bearer", note: "Issues or revokes the secret for background positions of an own delivery the pristavovač took a step in." },
  "mobile/v1/field/track": { class: "delivery-tracker", note: "Background positions by the per-delivery secret (hash lookup); answers only stored count and whether to go on." },
  "mobile/v1/diagnostics/errors": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Masked app error report; one structured runtime log line, no database write." },
  "mobile/v1/drafts/scope": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Private verified organization scope for account-bound device drafts and expected-organization fencing." },
  "mobile/v1/tasks": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Bounded current-actor assigned or reviewer task overview; no arbitrary actor selection." },
  "mobile/v1/cases": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Scoped bounded case list and allowlisted draft creation owned by the authenticated actor." },
  "mobile/v1/cases/overview": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only organization-scoped exact open-case counts; no arbitrary organization or actor selection." },
  "mobile/v1/cases/[id]": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Organization-scoped case detail and allowlisted revision-safe atomic edits with actor-bound replay receipts." },
  "mobile/v1/cases/[id]/owner": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Active same-organization dispatcher assignment with exact revision and immutable atomic replay receipt." },
  "mobile/v1/maps/picker": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Private Google browser map with scoped case projection, header-only credentials and an explicit local-form selection bridge." },
  "mobile/v1/tools/vehicle-lookup": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Explicit vehicle lookup with required expected organization and existing live integration/rate guards." },
  "mobile/v1/tools/route": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Scoped driving route calculation through the guarded Maps service." },
  "mobile/v1/tools/fleet": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Private organization fleet snapshot projection; no provider refresh or fleet mutation." },
  "mobile/v1/cases/[id]/notes": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Append-only organization/case/actor-bound UUID notes with exact replay and explicit audit warnings." },
  "mobile/v1/cases/[id]/handoffs": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Existing user RPC with complete published-data previews, exact mutation receipts and distinct current-link retrieval; no automatic recipient contact." },
  "mobile/v1/cases/[id]/attachments": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Bounded private attachment list and revision-safe upload; immutable actor/command path and verified atomic receipt." },
  "mobile/v1/cases/[id]/attachments/[attachmentId]/download": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Temporary download URL for an exact scoped private attachment." },
  "mobile/v1/cases/[id]/tasks": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Bounded link-based task pages; user RLS and actor-scoped task RPC for path-bound creation." },
  "mobile/v1/tasks/[id]": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Minimal task detail through an exact verified user RPC client." },
  "mobile/v1/tasks/colleagues": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Bounded active human login choices for task assignment and review." },
  "mobile/v1/tasks/[id]/workflow": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Existing user RPC command/revision workflow with exact replay and minimal committed receipt." },
  "mobile/v1/tasks/[id]/messages": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Bounded task messages and actor/task/client-message receipt verification." },
  "mobile/v1/cases/dispatchers": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Bounded organization-scoped human dispatcher choices, including inactive historical owners." },
  "mobile/v1/console": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only own-call DTO; no provider or presence operations." },
  "mobile/v1/calls/history": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Uses existing actor-authorized search; excludes archive and provider fields." },
  "mobile/v1/calls/[id]/wrap-up": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Required expected organization; organization call-log outcome, explicit case link and live case suggestions; no provider fields." },
  "mobile/v1/calls/[id]/outcome": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Required expected organization; existing outcome write with actor identity, mutation replay and callback scheduling contract." },
  "mobile/v1/calls/[id]/case": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Required expected organization; existing case link conditional on the link the actor saw; same link is a no-op." },
  "mobile/v1/calls/target": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only verified directory callback target for an explicit number; dialing revalidates the same verification." },
  "mobile/v1/callbacks": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Required expected organization; existing priority callback queue projected without provider or session metadata." },
  "mobile/v1/callbacks/summary": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only organization-scoped exact callback counters; no actor or organization selection." },
  "mobile/v1/callbacks/[id]/claim": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Required expected organization; existing conditional claim with senior takeover rule and audit." },
  "mobile/v1/callbacks/[id]/resolve": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Required expected organization; existing claimant-conditional done/cancel with bounded note and audit." },
  "mobile/v1/voice/calls/callback": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Current native TEST lease; existing callback call path with verified target, claim and immutable attempt identity." },
  "mobile/v1/calls/[id]/context": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only explicit call/session reference and linked case; required expected organization, own console session visibility, no provider or number matching." },
  "mobile/v1/voice/readiness": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only native TEST configuration opt-ins; no provider, device or audio readiness claim." },
  "mobile/v1/voice/token": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native mobile lease; dedicated TEST pilot with provider provenance guards." },
  "mobile/v1/voice/heartbeat": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native mobile lease; dedicated TEST pilot with provider provenance guards." },
  "mobile/v1/voice/offers": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native mobile lease; dedicated TEST pilot with provider provenance guards." },
  "mobile/v1/voice/colleagues": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Scoped human colleague availability hints; no provider operations." },
  "mobile/v1/voice/calls/attempt/end": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Exact immutable original command and current mobile endpoint cleanup; absence stays unresolved." },
  "mobile/v1/voice/calls/internal": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Current native TEST lease; immutable internal-call attempt and scoped eligible colleague." },
  "mobile/v1/voice/calls": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native mobile lease; dedicated TEST pilot with provider provenance guards." },
  "mobile/v1/voice/calls/[id]/end": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native mobile lease; dedicated TEST pilot with provider provenance guards." },
  "mobile/v1/voice/calls/[id]/status": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native mobile lease; dedicated TEST pilot with provider provenance guards." },
  "mobile/v1/voice/calls/[id]/hold": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Immutable hold command under session ownership and exact accepted native endpoint." },
  "mobile/v1/voice/calls/[id]/hold/status": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only immutable hold receipt and current journal-confirmed media; no provider dispatch." },
  "mobile/v1/voice/calls/[id]/transfer-targets": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Current native lease and connected own call; read-only colleague list with the web's availability badge." },
  "mobile/v1/voice/calls/[id]/transfer": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Current native lease and connected own customer call; web blind transfer to a colleague, never between colleagues." },
  "mobile/v1/voice/calls/[id]/recording": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native lease (cleanup allowed) and connected own call; web recording stop on the caller's request." },
  "mobile/v1/voice/presence": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native mobile lease; dedicated TEST pilot with provider provenance guards." },
  "mobile/v1/voice/disconnect": { class: "user-bearer", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Native mobile lease; dedicated TEST pilot with provider provenance guards." },
  diagnostics: {class: 'session', role: ['manager','admin']},
  'diagnostics/canary': {class: 'dual', role: ['admin'], note: 'Fixed synthetic error only: dedicated TEST + expiring deployment flag; temporary purpose-bound bearer or same-origin admin. Disabled deployments return 404. No application-session or provider access.'},
  'diagnostics/events': {class: 'session', role: ['dispatcher','senior_dispatcher','manager','admin'], note: 'Same-origin, authenticated account-bound diagnostic batch.'},
  'diagnostics/incidents/[id]': {class: 'session', role: ['manager','admin']},
  "telephony/team": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Narrow operational DTO; report and device secrets excluded." },
  "telephony/routing-summary": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "telephony/config/incoming-flow": { class: "session", role: ["manager", "admin"], note: "PUT only; same-origin guard, scoped per-line flow validation and atomic snapshot/version CAS." },
  "telephony/config/incoming": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read scoped configuration; PUT manager/admin plus same-origin and atomic CAS." },
  "cases/live": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only POST for version manifest; actor-derived audience, no-store." },
  "cases/presence": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Server-derived actor and expiring lease, same-origin mutation." },
  "cases/drafts/[sessionId]": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "GET same-organization live draft preview; PUT same-origin session owner only; no-store." },
  "guide/knowledge": { class: "session", note: "Versioned documentation only; no live telephony or organization data." },
  "telephony/callback-target": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "directory/contacts/[id]/callback-policy": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "GET directory policy; PUT manager/admin only with same-origin guard." },
  "vehicles/lookup": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  // ── public (6) ──────────────────────────────────────────────────────────
  "auth/forgot-password": { class: "public" },
  "health/live": { class: "public", note: "Sanitized infrastructure liveness probe." },
  "health/ready": { class: "public", note: "Sanitized dependency readiness probe." },
  "mobile/v1/app-status": { class: "public", note: "Native app release gate: environment, minimum supported version and update link only." },
  "public/location-links/[token]": { class: "public" },
  "public/handoffs/session": { class: "public", note: "Purpose-bound 256-bit link credential, strict same-origin JSON, hashed limited HttpOnly session; never an app account." },
  "public/handoffs/current": { class: "public", note: "Requires limited handoff cookie AND displayed grant ID; rechecks generation/expiry, minimal no-store DTO only." },
  "public/handoffs/commands": { class: "public", note: "Limited handoff cookie + displayed grant ID + strict origin + current revision; transactional allowlisted actions, no ordinary case access." },
  // Telnyx webhooky: autentifikáciou je Ed25519 podpis (`telnyx-signature-ed25519` + `telnyx-timestamp`,
  // tolerancia 300 s) overený PRED akoukoľvek prácou; neplatný podpis → 400, cudzí `connection_id` → 200 ignored.
  "telephony/telnyx/webhook": { class: "public", note: "Telnyx Call Control webhook; Ed25519 signature verification namiesto session." },
  "telephony/webhooks/scribe": { class: "public", note: "ElevenLabs HMAC signature and five-minute replay window, verified before database access." },
  "telephony/webhooks/openai": { class: "public", note: "OpenAI GPT-Live webhook; Standard Webhooks HMAC podpis a 5-minútové okno namiesto session. Podpis nie je oprávnenie — reláciu musí potvrdiť riadok pokusu dema." },
  "sms/telnyx/webhook": { class: "public", note: "Telnyx messaging delivery-status webhook; Ed25519 signature verification." },

  // ── bearer (4) — zdieľané tajomstvo (cron/stroj) ────────────────────────
  // commander/* majú INLINE authorize() + safeEquals (COMMANDER_SYNC_SECRET + timingSafeEqual)
  "integrations/commander/sync": { class: "bearer" },
  "integrations/commander/import-all": { class: "bearer" },
  // telephony/cron: Vercel cron (*/5) s `Authorization: Bearer ${CRON_SECRET}` + timingSafeEqual
  "telephony/cron": { class: "bearer", note: "Vercel cron každých 5 minút; ring sweep, replay ledgera, zmierenie s Telnyxom, detekcia zaseknutých hovorov, e-mailové alerty a prune ledgera." },
  "telephony/health": { class: "bearer", note: "Prevádzkový stav ústredne (zaseknuté relácie, zlyhané webhooky, incidenty, denné využitie) pre externý monitoring; rovnaký CRON_SECRET ako cron, 503 pri stave fail." },
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
  "notes": { class: "session" },
  "notes/[id]": { class: "session" },
  "notes/colleagues": { class: "session" },
  "workspace/capabilities": { class: "session" },
  "tasks": { class: "session" },
  "tasks/[id]": { class: "session" },
  "tasks/[id]/links": { class: "session" },
  "tasks/[id]/messages": { class: "session" },
  "tasks/[id]/workflow": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },

  // ── session — Supabase session guard ────────────────────────────────────
  // attendance
  "attendance": { class: "session" },
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

  // Shared directory: authenticated reading, manager/admin mutations checked per verb.
  directory: { class: "session" },
  "directory/[kind]/[id]": { class: "session", role: ["manager", "admin"] },

  // cases
  cases: { class: "session" },
  "cases/location-updates": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "cases/[id]": { class: "session" },
  "cases/[id]/actions": { class: "session" },
  "cases/[id]/assign": { class: "session" },
  "cases/[id]/attachments": { class: "session" },
  "cases/[id]/sms": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "cases/[id]/pdf": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "cases/[id]/handoffs": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Actor- and case-authorized internal grant management, no token/session authority." },

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
  "push/mobile-calls": { class: "session", note: "Authenticated account mobile call push preference; never changes another profile." },
  "push/pause-ending": { class: "session", note: "Authenticated account pause-ending preference and idempotent own-warning trigger." },
  "push/subscriptions": { class: "session", note: "Per-device subscription management for the authenticated profile; never returns endpoint keys." },
  "push/test": { class: "session", note: "Test push to the authenticated profile's own device; durable 30-second cooldown." },

  // partner-directory (správa adresára manager/admin; rýchle pridanie asistenčky pre členov organizácie)
  "partner-directory": { class: "session", role: ["manager", "admin"] },
  "partner-directory/assistance": { class: "session" },
  "partner-directory/backfill-assistance": { class: "session", role: ["manager", "admin"] },
  "partner-directory/[id]": { class: "session", role: ["manager", "admin"] },

  // reports
  "reports/dashboard": { class: "session" },

  // SMS
  "sms": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "sms/context": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "sms/inbox": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "sms/inbox/[id]": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "sms/prepare": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },
  "sms/send": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"] },

  // telephony (provider-neutral routes + Telnyx call control)
  "telephony/calls": { class: "session", note: "Click-to-call; kill switch, rate limit 10/min a allowlist sú v call-actions." },
  "telephony/calls/active": { class: "session" },
  "telephony/calls/journeys": { class: "session", note: "Read-only call progress; every query is scoped to the actor organization. No provider operations." },
  "telephony/calls/[id]/journey": { class: "session", note: "Read-only observed history after exact call/session organization authorization." },
  "telephony/calls/internal": { class: "session" },
  "telephony/calls/[id]/cancel-consult": { class: "session" },
  "telephony/calls/[id]/complete-transfer": { class: "session" },
  "telephony/calls/[id]/consult": { class: "session" },
  "telephony/calls/[id]/hangup": { class: "session" },
  "telephony/calls/[id]/hold": { class: "session" },
  "telephony/calls/[id]/reconcile": { class: "session" },
  "telephony/calls/[id]/park": { class: "session" },
  "telephony/calls/[id]/defer": { class: "session" },
  "telephony/calls/[id]/pickup": { class: "session" },
  "telephony/calls/[id]/add-party": { class: "session", note: "Pridá tretieho účastníka (kolegu alebo externé číslo) do konferencie hovoru; externé číslo prechádza rovnakým rate limitom a allowlistom ako vytáčanie." },
  "telephony/calls/[id]/leave": { class: "session", note: "Operátor odíde z trojstranného hovoru, zvyšní pokračujú." },
  "telephony/calls/[id]/parties/[legId]/kick": { class: "session" },
  "telephony/calls/[id]/parties/[legId]/mute": { class: "session" },
  "telephony/calls/[id]/parties/[legId]/unmute": { class: "session" },
  "telephony/calls/[id]/stop-supervise": { class: "session", note: "Manažér/admin ukončí vlastný dozor; pozvaný dispečer iba vlastné prijaté počúvanie." },
  "telephony/monitor-invitations": { class: "session", note: "Privátny inbox iba pozývateľa/príjemcu v jeho organizácii; DB gate default false." },
  "telephony/calls/[id]/monitor-invitations": { class: "session", note: "Účastník vlastného hovoru pozýva/odvoláva, presný príjemca prijme jednorazovo pod session lease/CAS; server/provider monitor-only." },
  "telephony/calls/[id]/supervise": { class: "session", role: ["manager", "admin"], note: "Dozor nad cudzím hovorom (monitor/whisper/barge). Na bežne premostenom hovore sa dozorca pripája priamo cez Telnyx supervise_call_control_id (volajúci sa nerozpája), v konferencii cez supervisor_role. Role-gate je v call-actions (canSupervise), dispečer dostane 403. Každý dozor zapisuje audit riadok." },
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
  "telephony/config/announcements": { class: "session", role: ["manager", "admin"], note: "GET member-level vracia iba hlásenia liniek; PUT manager/admin cez handleConfigWrite s kontrolou verzie." },
  "telephony/config/announcements/generate": { class: "session", role: ["manager", "admin"], note: "POST manager/admin a CSRF cez handleConfigWrite; serverové ElevenLabs generovanie vytvára náhľad bez aktivácie linky." },
  "telephony/config/business-hours": { class: "session", role: ["manager", "admin"], note: "GET je member-level (CONFIG_READ_ROLES), ale redigovaný: kill switche len admin, limity a allowlist manager/admin, cudzie SIP identity manager/admin. PUT manager/admin cez handleConfigWrite." },
  "telephony/config/ivr-menus": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný ako pri business-hours); PUT manager/admin — celé IVR menu aj s voľbami cez motorist_replace_ring_plan." },
  "telephony/config/numbers": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný ako pri business-hours); PATCH manager/admin. Kúpa čísla cez Telnyx nie je súčasťou tejto fázy." },
  "telephony/config/pause-reasons": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný); PUT manager/admin." },
  "telephony/config/ring-groups": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný); PUT manager/admin (transakčná výmena cez motorist_replace_ring_plan)." },
  "telephony/config/ring-plans": { class: "session", role: ["manager", "admin"], note: "GET je member-level (redigovaný); PUT manager/admin (transakčná výmena cez motorist_replace_ring_plan)." },
  "telephony/config/settings": { class: "session", role: ["admin"], note: "Kill switche, allowlist cieľov a limit čakárne — GET aj PATCH len admin; rovnaké polia sú redigované aj v ostatných config GET." },
  // ── AI demo „Veronika" (admin-only, vrátane čítania) ────────────────────
  "telephony/ai-demo": { class: "session", role: ["admin"], note: "História pokusov dema s maskovanými číslami a meraniami latencie." },
  "telephony/ai-demo/start": { class: "session", role: ["admin"], note: "Spustí jeden demo hovor; okrem role aj env prepínač, allowlist cieľov organizácie, serverový zoznam príjemcov a denný limit." },
  "telephony/ai-demo/[id]": { class: "session", role: ["admin"], note: "Stav jedného pokusu pre časovú os." },
  "telephony/ai-demo/[id]/review": { class: "session", role: ["admin"], note: "Prečíta prepis hovoru modelom a uloží súhrn, chyby a návrhy na úpravu pokynov." },
  "telephony/ai-demo/[id]/stop": { class: "session", role: ["admin"], note: "Ukončí demo; zámerne nekontroluje vypínače, aby vypnutie nových hovorov neblokovalo ukončenie bežiaceho." },
  "telephony/ai-demo/listen": { class: "public", note: "Volá ju bridge webhook, ktorý nemôže čakať celý hovor. Autentifikáciou je HMAC token viazaný na jeden konkrétny pokus, nie session — drží sideband a zaznamená prepis." },
  "telephony/ai-demo/settings": { class: "session", role: ["admin"], note: "Ako sa AI správa: meno, hlas, stále pravidlá a oprávnenia. Čítanie je tiež admin-only — kto smie vidieť, čo má dovolené, je tá istá otázka ako kto to smie meniť." },
  "telephony/ai-demo/preflight": { class: "session", role: ["admin"], note: "Read-only kontrola pripravenosti; `?remote=1` pridá tri GET dopyty k poskytovateľom. Nič nevytvára hovor." },
  "telephony/operators/[id]/credential": { class: "session", role: ["manager", "admin"], note: "Vytvorí alebo pregeneruje Telnyx SIP credential operátora; pri pregenerovaní zmaže pôvodný credential u Telnyxu (neúspech = 502)." },
  "telephony/operators/[id]/disconnect": { class: "session", role: ["manager", "admin"], note: "Odpojí prehliadačový telefón operátora (ďalší heartbeat dostane 409) a zmaže jeho Telnyx credential, aby sa starým tokenom nedalo znova zaregistrovať (neúspech = 502)." },
  "telephony/operators/[id]/settings": { class: "session", note: "PATCH vlastných nastavení (self) alebo cudzích (manager/admin)." },
  "telephony/devices/heartbeat": { class: "session", note: "Heartbeat prehliadačového telefónu; zastaraná device_session_id → 409." },
  "telephony/devices/observations": { class: "session", note: "Bounded browser timings; only actor-owned legs in the current organization/environment. ACK identifies emitted log observations." },
  "telephony/dev/simulate-inbound": { class: "session", role: ["admin"], note: "Vývojový simulátor prichádzajúceho hovoru; v produkčnom aplikačnom prostredí (MOTORIST_APP_ENV=production; legacy VERCEL fallback) vracia 403." },
  "telephony/presence": { class: "session" },
  "telephony/presence/end-wrap-up": { class: "session" },
  "telephony/webphone/token": { class: "session", note: "Vydáva krátkodobý Telnyx WebRTC token a rotuje device_session_id." },
  "telephony/webphone/offer-status": { class: "session", role: ["dispatcher", "senior_dispatcher", "manager", "admin"], note: "Read-only exact actor-owned WEB lease and SIP leg status, including ended offers; no provider operations." },
  "telephony/calls/[id]/link-case": { class: "session" },
  "telephony/calls/[id]/outcome": { class: "session" },
  "telephony/calls/[id]/transcript": { class: "session", note: "GET requires archive permission; PATCH also requires quality-review permission and source revision." },
  "telephony/calls/[id]/recording-detail": { class: "session", note: "Archive permission or own approved feedback; DELETE manager/admin with source revision." },
  "telephony/calls/[id]/recordings/[recordingId]/audio": { class: "session", note: "Manager/admin or explicit senior archive grant; per-request source restriction and organization checks." },
  "telephony/calls/[id]/recording-control": { class: "session", note: "Current participant or manager/admin; same-origin and session control authorization." },
  "telephony/calls/[id]/recording-retry": { class: "session", role: ["manager", "admin"] },
  "telephony/calls/[id]/quality/review": { class: "session", note: "Manager/admin or senior with explicit archive and quality-review grants." },
  "telephony/calls/[id]/quality/appeal": { class: "session", note: "Only own current approved review." },
  "telephony/config/recording-policy": { class: "session", note: "GET member; PUT manager/admin with policy version and explicit scope confirmation." },
  "telephony/quality/dashboard": { class: "session", note: "Manager/admin or senior with explicit archive and quality-review grants." },
  "telephony/calls/history": { class: "session" },
  "telephony/calls/match": { class: "session" },
  "telephony/directory": { class: "session" },
  "telephony/directory/favorites": { class: "session" },
  "telephony/directory/favorites/[contactId]": { class: "session" },
  "telephony/qa/dashboard": { class: "session", role: ["senior_dispatcher", "manager", "admin"] },
  "telephony/stats": {
    class: "session",
    role: ["senior_dispatcher", "manager", "admin"],
    note: "Wallboard a widgety v reportoch; odpoveď je nezávislá od čitateľa a servíruje sa z 5-sekundovej cache na organizáciu, aby nástenné displeje nemleli databázu.",
  },

  // users
  users: { class: "session", role: ["manager", "admin"] },
  "users/[id]": { class: "session", role: ["manager", "admin"], note: "PATCH (úprava, deaktivácia) manager/admin; DELETE (trvalé vymazanie účtu vrátane Auth používateľa a Telnyx credentialu) len admin." },
  "users/[id]/access/reset-password": { class: "session", role: ["manager", "admin"] },
  "users/[id]/access/send": { class: "session", role: ["manager", "admin"] },
};

/** Množina `public` routes — jediný pohľad, ktorý 0.2 enumeračný test číta (len na parity assert). */
export const PUBLIC_ROUTES: readonly string[] = Object.entries(ROUTE_AUTH_REGISTRY)
  .filter(([, entry]) => entry.class === "public")
  .map(([route]) => route);
