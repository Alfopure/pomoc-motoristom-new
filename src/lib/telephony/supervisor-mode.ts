import type { AppRole } from "@/domain/types";

/**
 * Supervision modes shared by the console and the server.
 *
 * The values are the Telnyx `supervisor_role` enum used on
 * `POST /conferences/{id}/actions/join` and `…/actions/update`; the server-side
 * type in `src/server/telephony/state/types.ts` is asserted to match in
 * `active-calls-model.test.ts`. Browser code must not import server modules.
 */
export type SupervisorMode = "monitor" | "whisper" | "barge";

export const SUPERVISOR_MODE_LABELS: Record<SupervisorMode, string> = {
  monitor: "Počúvať",
  whisper: "Šepkať operátorovi",
  barge: "Vstúpiť do hovoru",
};

export const SUPERVISOR_MODE_HINTS: Record<SupervisorMode, string> = {
  monitor: "Len počúvaš, nikto ťa nepočuje.",
  whisper: "Počuje ťa iba operátor, volajúci nie.",
  barge: "Počujú ťa obaja — operátor aj volajúci.",
};

export const SUPERVISOR_MODE_ORDER: readonly SupervisorMode[] = ["monitor", "whisper", "barge"];

export function isSupervisorMode(value: unknown): value is SupervisorMode {
  return typeof value === "string" && (SUPERVISOR_MODE_ORDER as readonly string[]).includes(value);
}

/** Roles allowed to monitor, whisper into or barge a colleague's live call. */
export const SUPERVISOR_ROLES: readonly AppRole[] = ["manager", "admin"];

export function canSuperviseRole(role: AppRole | null | undefined): boolean {
  return role !== null && role !== undefined && SUPERVISOR_ROLES.includes(role);
}
