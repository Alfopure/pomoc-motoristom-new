import type { CallControlProgress } from "@/lib/telephony/active-calls-model";
import { effectGeneration, readPendingEffects } from "./continuation";
import { commandKey, readMeta, type SessionRow } from "./types";

/** Staged intent is not a completed media action. No extra reads or writes. */
export function pendingCallControl(session: SessionRow): {
  progress: CallControlProgress;
  state: SessionRow["state"];
  operatorProfileId: string | null;
} | null {
  if (session.ended_at || session.termination_requested_at) return null;
  const generation = effectGeneration(session);
  for (const entry of readPendingEffects(session).entries.toReversed()) {
    if (entry.branch !== "main" || entry.generation !== generation || entry.event.kind !== "app") continue;
    const action = entry.event.type;
    if (action !== "hold" && action !== "unhold" && action !== "park") continue;
    const targetState = action === "hold" ? "held" : action === "unhold" ? "talking" : "parked";
    if (session.state !== targetState || !["talking", "held"].includes(entry.stateBefore)) continue;
    const mediaKinds = action === "park" ? ["conference_leave", "hangup", "playback_start"]
      : [action === "hold" ? "conference_hold" : "conference_unhold"];
    const mediaPending = entry.commands.some(command => mediaKinds.includes(command.kind) &&
      !entry.completedCommands.includes(commandKey(command)));
    // A history/audit retry must not keep an already completed control busy.
    if (!mediaPending) continue;
    return {
      progress: { action, startedAt: entry.createdAt, failed: Boolean(entry.lastError) },
      state: entry.stateBefore,
      operatorProfileId: action === "park" ? readMeta(session).previous_operator ?? null : session.answered_by_profile_id,
    };
  }
  return null;
}
