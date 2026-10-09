import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test("installed SDK quality codes reach the timeline only for the exact current call", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", error => failures.push(error.message));
  await page.route("**/*", route => route.request().url() === "https://voice-quality.test/"
    ? route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div></body></html>' })
    : route.abort());
  const bundle = await build({ bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    stdin: { sourcefile: "quality-warning-fixture.tsx", loader: "tsx", resolveDir: process.cwd(), contents: `
      import { SDK_WARNINGS } from "@telnyx/webrtc";
      import { createRoot } from "react-dom/client";
      import { TelnyxWebphone } from "./src/lib/telephony/telnyx-webphone";
      import { correlateWebphoneDiagnostic, webphoneDiagnostic } from "./src/lib/telephony/diagnostics";
      import { DiagnosticEvents } from "./src/components/monitor/DiagnosticTimeline";
      const session = "00000000-0000-4000-8000-000000000001";
      const handlers = new Map(); const events = []; const root = createRoot(document.getElementById("root"));
      const client = { sessionid: "sdk-session", options: {}, connection: { connected: true }, remoteElement: null,
        on(name, handler) { handlers.set(name, handler); }, off(name) { handlers.delete(name); },
        async login() {}, async connect() {}, async disconnect() {} };
      const call = { id: "sdk-call", state: "active", direction: "inbound", options: {}, isAudioMuted: false,
        telnyxIDs: { telnyxCallControlId: "control-current", telnyxSessionId: "provider-session", telnyxLegId: "provider-leg" },
        async answer() {}, async hangup() { call.state = "hangup"; }, muteAudio() {}, unmuteAudio() {}, dtmf() {} };
      const server = { sessionId: session, state: "talking", legs: [{ callControlId: "control-current", muted: false }] };
      let calls = [server];
      const phone = new TelnyxWebphone({ silent: true, createClient: () => client,
        requestJson: async url => url.includes("token")
          ? { ok: true, status: 200, body: { token: "synthetic", expiresAt: new Date(Date.now() + 3600000).toISOString(),
            deviceSessionId: "00000000-0000-4000-8000-000000000002", sipUsername: "synthetic" } }
          : { ok: true, status: 200, body: { ok: true } },
        logger(entry) {
          const linked = correlateWebphoneDiagnostic(entry, phone.getSnapshot().call, calls);
          const event = linked && webphoneDiagnostic(linked);
          if (!event?.sdkWarningCode) return;
          const now = new Date().toISOString();
          events.push({ ...event, id: crypto.randomUUID(), pageId: session, sequence: events.length, monotonicMs: 1,
            occurredAt: now, receivedAt: now, buildId: "quality-fixture", serverBuild: "quality-fixture", source: "browser",
            profileId: null, sampled: false, sampleRate: 1 });
          root.render(<DiagnosticEvents events={events.slice()} />);
        } });
      phone.start();
      window.qualityFixture = {
        ready() { if (!handlers.has("telnyx.warning")) return false;
          handlers.get("telnyx.ready")(); phone.expectOperatorLeg({ callControlId: "control-current", sessionId: session });
          handlers.get("telnyx.notification")({ type: "callUpdate", call }); return true; },
        warn(code, callId = "sdk-call") { handlers.get("telnyx.warning")({ warning: { ...SDK_WARNINGS[code], code,
          message: "PRIVATE SDP 192.0.2.1 +421900111222" }, sessionId: "sdk-session", callId }); },
        hold(state) { server.state = state; }, mute(value) { call.isAudioMuted = value;
          handlers.get("telnyx.notification")({ type: "callUpdate", call }); },
        snapshot() { return { events, phone: phone.getSnapshot() }; }, stop() { phone.stop(); }
      };
    ` },
  });
  await page.goto("https://voice-quality.test/");
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect.poll(() => page.evaluate(() => window.qualityFixture.ready())).toBe(true);
  await page.evaluate(() => {
    const q = window.qualityFixture;
    q.warn(31001, "foreign-call");
    q.hold("held"); q.warn(31006); q.hold("talking");
    q.mute(true); q.warn(31005); q.mute(false);
    q.warn(31003); q.warn(31003);
  });
  const evidence = await page.evaluate(() => window.qualityFixture.snapshot());
  expect(evidence.events).toHaveLength(1);
  expect(evidence.events[0]).toMatchObject({ sdkWarningCode: 31003, reason: "sdk_high_packet_loss", outcome: "unknown",
    callSessionId: "00000000-0000-4000-8000-000000000001" });
  expect(JSON.stringify(evidence.events)).not.toMatch(/PRIVATE|192\.0\.2|421900|control-current|provider-session/);
  expect(evidence.phone).toMatchObject({ status: "registered", callError: null });
  await expect(page.getByText(/Strata zvukových paketov · SDK 31003/)).toBeVisible();
  await expect(page.getByText(/samo nepotvrdzuje výpadok ani príčinu/)).toBeVisible();
  await page.screenshot({ path: ".context/voice-quality-timeline.png", fullPage: true });
  await page.evaluate(() => window.qualityFixture.stop());
  expect(failures).toEqual([]);
});

declare global {
  interface Window {
    qualityFixture: {
      ready(): boolean; warn(code: number, callId?: string): void; hold(state: string): void; mute(value: boolean): void;
      snapshot(): { events: Array<Record<string, unknown>>; phone: Record<string, unknown> }; stop(): void;
    };
  }
}
