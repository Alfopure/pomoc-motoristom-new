import { describe, expect, it } from "vitest";

import { createFakeSideband } from "@/test/fake-openai-live";

import { AI_DEMO_LIMITS } from "./config";
import { runGreeting } from "./greeting";

const BASE = {
  sessionId: "live_abc123",
  apiKey: "sk-test",
  greetingText: "Povedz: Dobrý deň, tu je Veronika.",
  commentaryText: "Začni rozhovor teraz.",
  eventIdSeed: "1a2b3c4d",
};

/** Short budgets keep the suite fast without changing any of the logic. */
const FAST = { probeOpenMs: 200, probeAppendedMs: 200, probeFirstDeltaMs: 300, probeWindowMs: 600, probeMaxEvents: 40, backchannelMaxMs: 50 };

describe("runGreeting", () => {
  it("attaches with the project key and the documented session URL", async () => {
    const sideband = createFakeSideband({
      onInstructions: [{ event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } }],
    });

    await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(sideband.url).toBe("wss://api.openai.com/v1/live/sessions/live_abc123/attach");
    expect(sideband.headers).toEqual({ Authorization: "Bearer sk-test" });
  });

  it("sends both commands without waiting for the acknowledgement in between", async () => {
    // The whole point: a round trip here is silence in somebody's ear.
    const sideband = createFakeSideband({
      onInstructions: [{ delayMs: 50, event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } }],
    });

    await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(sideband.sent).toHaveLength(2);
    const [instructions, commentary] = sideband.sent.map((raw) => JSON.parse(raw));
    expect(instructions).toEqual({
      type: "session.instructions.append",
      event_id: "greet-1a2b3c4d",
      // A non-null delegation id is refused with Responses delegation.
      delegation_id: null,
      content: BASE.greetingText,
    });
    expect(commentary.type).toBe("session.commentary.append");
    expect(commentary.event_id).toBe("begin-1a2b3c4d");
  });

  it("never sends session.start, input audio or response.create", async () => {
    const sideband = createFakeSideband({ onInstructions: [{ event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } }] });
    await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });
    const types = sideband.sent.map((raw) => JSON.parse(raw).type as string);
    expect(types).not.toContain("session.start");
    expect(types).not.toContain("session.input_audio.append");
    expect(types).not.toContain("response.create");
  });

  it("reports heard_started with the time to her first word", async () => {
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 10, event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } },
        { delayMs: 40, event: { type: "session.output_transcript.delta", delta: "Dobrý" } },
        { delayMs: 60, event: { type: "session.output_transcript.delta", delta: " deň" } },
      ],
    });

    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(result.status).toBe("heard_started");
    expect(result.appendedMs).not.toBeNull();
    expect(result.firstDeltaMs).not.toBeNull();
    // One entry per stretch of speech, not one per delta.
    expect(result.probe.filter((entry) => entry.dir === "out")).toHaveLength(1);
  });

  it("measures the response time from when the caller stopped, not when they started", async () => {
    // The caller speaks from 60 ms to 200 ms, she answers at 400 ms. The
    // response time is 200 ms, not 340 ms — the earlier version measured the
    // caller's whole utterance as part of the gap.
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } },
        { delayMs: 20, event: { type: "session.output_transcript.delta", delta: "Dobrý deň" } },
        { delayMs: 30, event: { type: "session.output_transcript.delta", delta: ", tu je Veronika" } },
        { delayMs: 60, event: { type: "session.input_transcript.delta", delta: "áno" } },
        { delayMs: 200, event: { type: "session.input_transcript.delta", delta: " mám chvíľku" } },
        { delayMs: 400, event: { type: "session.output_transcript.delta", delta: "Ďakujem, tak" } },
        { delayMs: 480, event: { type: "session.output_transcript.delta", delta: " sa dohodneme" } },
      ],
    });

    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(result.probe.map((entry) => entry.dir)).toEqual(["out", "in", "out"]);
    expect(result.responseGapsMs).toHaveLength(1);
    expect(result.responseGapsMs[0]).toBeGreaterThanOrEqual(150);
    expect(result.responseGapsMs[0]).toBeLessThan(320);
  });

  it("does not count an acknowledgement as an answer", async () => {
    // The prompt asks for "hm" on purpose; counting one as a 20 ms reply would
    // make the demo look faster than it is.
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } },
        // The greeting runs over several deltas, like real speech.
        { delayMs: 20, event: { type: "session.output_transcript.delta", delta: "Dobrý deň," } },
        { delayMs: 100, event: { type: "session.output_transcript.delta", delta: " tu je Veronika" } },
        { delayMs: 160, event: { type: "session.input_transcript.delta", delta: "no ja neviem" } },
        // One delta, over in an instant: an acknowledgement.
        { delayMs: 200, event: { type: "session.output_transcript.delta", delta: "hm" } },
        { delayMs: 240, event: { type: "session.input_transcript.delta", delta: "asi v stredu" } },
        { delayMs: 380, event: { type: "session.output_transcript.delta", delta: "Dobre, tak v stredu" } },
        { delayMs: 500, event: { type: "session.output_transcript.delta", delta: " popoludní." } },
      ],
    });

    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    const backchannels = result.probe.filter((entry) => entry.backchannel === true);
    expect(backchannels).toHaveLength(1);
    // Only the real answer produced a response time.
    expect(result.responseGapsMs).toHaveLength(1);
  });

  it("records how long each stretch of speech lasted", async () => {
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } },
        { delayMs: 20, event: { type: "session.output_transcript.delta", delta: "Dobrý" } },
        { delayMs: 300, event: { type: "session.output_transcript.delta", delta: " deň" } },
      ],
    });

    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(result.probe).toHaveLength(1);
    expect(result.probe[0].durMs).toBeGreaterThanOrEqual(200);
  });

  it("records no transcript text, only offsets and a direction", async () => {
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } },
        { delayMs: 20, event: { type: "session.output_transcript.delta", delta: "tajný obsah hovoru" } },
      ],
    });

    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(JSON.stringify(result)).not.toContain("tajný");
    // Offsets, a direction and a duration — no words, ever.
    for (const key of Object.keys(result.probe[0])) expect(["ms", "dir", "durMs", "backchannel"]).toContain(key);
  });

  it("settles as appended when she is acknowledged but never starts speaking", async () => {
    const sideband = createFakeSideband({
      onInstructions: [{ delayMs: 5, event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } }],
    });

    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(result.status).toBe("appended");
    expect(result.firstDeltaMs).toBeNull();
  });

  it("fails cleanly when the socket never opens", async () => {
    const sideband = createFakeSideband({ failOpen: true });
    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });
    expect(result.status).toBe("failed");
    expect(result.firstDeltaMs).toBeNull();
  });

  it("fails cleanly when the WebSocket implementation is unavailable", async () => {
    const result = await runGreeting({
      ...BASE,
      webSocketFactory: () => {
        throw new Error("websocket_unavailable");
      },
      limits: FAST,
    });
    expect(result).toMatchObject({ status: "failed", error: "websocket_unavailable" });
  });

  it("records a rejected append but still returns rather than throwing", async () => {
    const sideband = createFakeSideband({
      onInstructions: [{ delayMs: 5, event: { type: "error", client_event_id: "greet-1a2b3c4d", error: { code: "invalid_value" } } }],
    });

    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(result.error).toBe("append_rejected");
    expect(result.status).toBe("failed");
  });
});
