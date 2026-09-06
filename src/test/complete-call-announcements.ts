import type { TelephonyHarness } from "./telephony-harness";
import type { AnnouncementSequence } from "@/server/telephony/state/recording-types";
import { CallActionError, type CallActionResult } from "@/server/telephony/call-actions";

/** Simulate explicit provider media completions; never call this when testing the pending phase. */
export async function completeCallAnnouncements(h: TelephonyHarness, sessionId: string) {
  const results = [];
  for (let i = 0; i < 8; i += 1) {
    const meta = h.session(sessionId).metadata as { announcement_sequence?: AnnouncementSequence | null };
    const sequence = meta.announcement_sequence;
    if (!sequence) return results;
    const command = [...h.telnyx.calls].reverse().find((entry) => (entry.method === "speak" || entry.method === "playbackStart") && entry.params.callControlId === sequence.callControlId);
    if (!command) throw new Error("pending announcement has no provider command");
    results.push(await h.legEvent(sequence.callControlId, command.method === "speak" ? "call.speak.ended" : "call.playback.ended", { status: "completed", client_state: command.params.clientState }));
  }
  throw new Error("announcement sequence did not terminate");
}

/** Existing action-flow tests assert the result AFTER their explicit media completion. */
export async function completeAnnouncedAction(h: TelephonyHarness, action: Promise<CallActionResult>): Promise<CallActionResult> {
  const result = await action;
  const completions = await completeCallAnnouncements(h, result.sessionId);
  const failed = completions.find((entry) => entry.outcome === "failed");
  if (failed) throw new CallActionError(failed.error ?? "Announcement continuation failed", 502, "command_failed");
  return { ...result, state: h.session(result.sessionId).state as CallActionResult["state"], commands: [...result.commands, ...completions.flatMap((entry) => entry.commands.map((command) => ({ kind: command.kind, ok: command.ok, error: command.error })))] };
}
