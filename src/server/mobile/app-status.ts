import "server-only";
import type { MobileAppErrorReport, MobileAppStatus } from "@/lib/mobile-api";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/mutation-error";
import { maskDiagnostic } from "@/lib/diagnostic-mask";
import { mobileEnvironment } from "./auth";

/** Release gate of the native app, configured per Vercel project. An unset or
 * malformed minimum never locks anybody out. */
const VERSION = /^\d{1,4}(?:\.\d{1,4}){0,2}$/;
export function readAppStatus(env: Record<string, string | undefined> = process.env): MobileAppStatus {
  const minimum = env.MOBILE_MINIMUM_APP_VERSION?.trim() ?? "";
  const update = env.MOBILE_UPDATE_URL?.trim() ?? "";
  let updateUrl: string | null = null;
  try { updateUrl = update && new URL(update).protocol === "https:" ? update : null; } catch { updateUrl = null; }
  return { ok: true, apiVersion: 1, environment: mobileEnvironment(), minimumVersion: VERSION.test(minimum) ? minimum : null, updateUrl };
}

const KEYS = ["kind", "message", "stack", "component", "version", "build", "platform", "osVersion", "preview"] as const;
const text = (value: unknown, max: number) => typeof value === "string" && value.length <= max ? value : null;
/** The app masks before sending; the server masks again before logging. */
export const scrubDiagnostic = maskDiagnostic;
export function readAppErrorReport(value: unknown): MobileAppErrorReport {
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!body || Object.keys(body).some(key => !(KEYS as readonly string[]).includes(key))) throw new MutationError("Neplatné hlásenie chyby.", 400);
  const kind = body.kind === "fatal" || body.kind === "error" || body.kind === "render" ? body.kind : null;
  const message = text(body.message, 1000), stack = body.stack === undefined || body.stack === null ? null : text(body.stack, 8000);
  const component = body.component === undefined || body.component === null ? null : text(body.component, 4000);
  const version = text(body.version, 20), build = body.build === null || body.build === undefined ? null : text(body.build, 20);
  const platform = body.platform === "ios" || body.platform === "android" ? body.platform : null, osVersion = text(body.osVersion, 40);
  if (!kind || message === null || version === null || !VERSION.test(version) || build !== null && !/^[\w.-]{1,20}$/.test(build) || !platform || osVersion === null
    || typeof body.preview !== "boolean" || body.stack !== undefined && body.stack !== null && stack === null || body.component !== undefined && body.component !== null && component === null) {
    throw new MutationError("Neplatné hlásenie chyby.", 400);
  }
  return { kind, message: scrubDiagnostic(message).slice(0, 300), stack: stack === null ? null : scrubDiagnostic(stack).split("\n").slice(0, 25).join("\n"),
    component: component === null ? null : scrubDiagnostic(component).split("\n").slice(0, 15).join("\n"), version, build, platform, osVersion, preview: body.preview };
}

/** One structured runtime log line per report; nothing is stored in the database. */
export function logAppError(actor: MotoristActor, report: MobileAppErrorReport, log: (line: string) => void = console.error) {
  log(JSON.stringify({ event: "mobile.app_error", environment: mobileEnvironment(), organizationId: actor.organizationId, profileId: actor.profileId, ...report }));
}
