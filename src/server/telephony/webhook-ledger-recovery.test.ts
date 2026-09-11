import { afterEach, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS } from "@/test/telephony-harness";
import { replayStalledWebhookEvents } from "./cron-jobs";
import { readPendingEffects } from "./state/continuation";
import type { SessionRow } from "./state/types";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("RC-03: final processed-mark failure replays the same ledger event through cron with one physical answer and one durable outcome", async () => {
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Live network forbidden in webhook ledger recovery QA"); }));
  const h = createTelephonyHarness();
  const eventId = "ledger-final-mark-fault";
  const envelope = h.envelope("call.initiated", { call_control_id: "cc-ledger-recovery", call_leg_id: "leg-ledger-recovery",
    call_session_id: "tsess-ledger-recovery", direction: "incoming", to: NUMBERS.allianz, from: NUMBERS.customer }, eventId);
  const physicalAnswer = vi.spyOn(h.telnyx.physical, "answered");
  const audit = () => h.rows("motorist_call_events").filter(row => row.event_fingerprint === eventId);
  const ledger = () => h.rows("motorist_telnyx_webhook_events").find(row => row.event_id === eventId)!;
  // Inject at the final mark itself, asserting that all mandatory persistence,
  // provider execution and the processed call-event outcome already succeeded.
  let faultReached = false;
  const takeError = h.db.takeInjectedError.bind(h.db);
  vi.spyOn(h.db, "takeInjectedError").mockImplementation((table, operation) => {
    const error = takeError(table, operation);
    if (table === "motorist_telnyx_finish_webhook_event_v2" && operation === "rpc" && error) {
      faultReached = true;
      expect(physicalAnswer).toHaveBeenCalledTimes(1);
      expect(h.rows("motorist_call_sessions")).toHaveLength(1);
      expect(h.rows("motorist_calls")).toHaveLength(1);
      expect(readPendingEffects(h.rows("motorist_call_sessions")[0] as unknown as SessionRow).entries).toEqual([]);
      expect(audit()).toMatchObject([{ handled_status: "processed", normalized_payload: { commands: [{kind:"answer",ok:true}] } }]);
    }
    return error;
  });
  h.db.failNext("motorist_telnyx_finish_webhook_event_v2", "rpc", "injected final processed-mark failure");
  expect(await h.process(envelope)).toMatchObject({ status:200, outcome:"failed", error:expect.stringContaining("Could not finish event") });
  expect(faultReached).toBe(true);
  expect(ledger()).toMatchObject({ status:"failed", attempts:1, claimed_at:null, processed_at:null, effect_failure_count:1 });
  const savedAudit = audit()[0], originalPayload = ledger().payload, originalOccurredAt = ledger().occurred_at;
  expect(h.telnyx.physical.legs.get("cc-ledger-recovery")).toMatchObject({ answered:true, ended:false });
  // The failed final mark releases its claim with backoff; immediate redelivery is busy.
  expect(await h.process(envelope)).toMatchObject({ outcome:"busy", claim:{attempts:1} });
  expect(h.telnyx.of("answer")).toHaveLength(1);
  vi.stubEnv("TELEPHONY_STABILITY_V1_ENABLED", "false");
  h.advance(5 * 60_000);
  expect(await replayStalledWebhookEvents(h.deps)).toMatchObject({status:"ok",detail:{stalled:1,replayed:1,errors:[]}});
  expect(ledger()).toMatchObject({status:"processed",attempts:2,claimed_at:null,processed_at:h.now().toISOString(),error:null,payload:originalPayload,occurred_at:originalOccurredAt});
  // The actual processor runs again. Telnyx receives the identical command ID,
  // and the physical-provider fake accepts that command only once.
  expect(h.telnyx.of("answer")).toHaveLength(2);
  expect(new Set(h.telnyx.of("answer").map(call=>call.params.commandId)).size).toBe(1);
  expect(physicalAnswer).toHaveBeenCalledTimes(1);
  expect(audit()).toEqual([savedAudit]);
  expect(h.rows("motorist_call_sessions")).toHaveLength(1);expect(h.rows("motorist_call_legs")).toHaveLength(1);expect(h.rows("motorist_calls")).toHaveLength(1);
  expect(readPendingEffects(h.rows("motorist_call_sessions")[0] as unknown as SessionRow).entries).toEqual([]);
  expect(await h.process(envelope)).toMatchObject({outcome:"duplicate",claim:{attempts:2}});
  expect(await replayStalledWebhookEvents(h.deps)).toMatchObject({status:"ok",detail:{stalled:0,replayed:0,errors:[]}});
  expect(physicalAnswer).toHaveBeenCalledTimes(1);expect(audit()).toEqual([savedAudit]);
});
