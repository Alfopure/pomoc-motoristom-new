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
const FAST = { ...AI_DEMO_LIMITS, probeOpenMs: 200, probeAppendedMs: 200, probeFirstDeltaMs: 300, probeWindowMs: 400, probeMaxEvents: 40 };

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
    // One entry per change of speaker, not one per delta.
    expect(result.probe.filter((entry) => entry.dir === "out")).toHaveLength(1);
  });

  it("measures the gap between the caller finishing and Veronika answering", async () => {
    const sideband = createFakeSideband({
      onInstructions: [
        { delayMs: 5, event: { type: "session.instructions.appended", client_event_id: "greet-1a2b3c4d" } },
        { delayMs: 20, event: { type: "session.output_transcript.delta", delta: "Dobrý deň" } },
        { delayMs: 60, event: { type: "session.input_transcript.delta", delta: "áno" } },
        { delayMs: 120, event: { type: "session.output_transcript.delta", delta: "Ďakujem" } },
      ],
    });

    const result = await runGreeting({ ...BASE, webSocketFactory: sideband.factory, limits: FAST });

    expect(result.probe.map((entry) => entry.dir)).toEqual(["out", "in", "out"]);
    expect(result.responseGapsMs).toHaveLength(1);
    expect(result.responseGapsMs[0]).toBeGreaterThanOrEqual(0);
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
    expect(Object.keys(result.probe[0]).sort()).toEqual(["dir", "ms"]);
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
