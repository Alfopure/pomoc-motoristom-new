import { build } from "esbuild";
import { expect, test } from "@playwright/test";
import type { TelnyxRTC } from "@/lib/telephony/telnyx-rtc";

type Client = TelnyxRTC & {
  _triggerKeepAliveTimeoutCheck(): void;
  _onSocketMessage(message: unknown): void;
};
declare global {
  interface Window {
    keepaliveSdk: { TelnyxRTC: typeof TelnyxRTC; UnpatchedTelnyxRTC: typeof TelnyxRTC };
    keepaliveClient: Client;
    keepaliveSocket: { readyState: number; sent: Array<{ method: string }>; send(body: string): void; close(): void };
    keepaliveRejections: string[];
    keepaliveWarnings: number[];
  }
}

let script: string;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: { contents: 'export { TelnyxRTC } from "./src/lib/telephony/telnyx-rtc"; export { TelnyxRTC as UnpatchedTelnyxRTC } from "@telnyx/webrtc";', resolveDir: process.cwd() },
    bundle: true, write: false, platform: "browser", format: "iife", globalName: "keepaliveSdk",
  });
  script = bundle.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route("**/*", route => route.request().resourceType() === "document"
    ? route.fulfill({ contentType: "text/html", body: "<!doctype html><title>SDK keepalive regression</title>" })
    : route.abort());
  await page.goto("https://keepalive.test/");
  await page.clock.install();
  await page.addScriptTag({ content: script });
});

test.afterEach(async ({ page }) => { await page.evaluate(() => window.keepaliveClient?.disconnect()); });

async function start(page: import("@playwright/test").Page, unpatched = false) {
  await page.evaluate(unpatched => {
    window.keepaliveRejections = [];
    window.keepaliveWarnings = [];
    window.addEventListener("unhandledrejection", event => {
      window.keepaliveRejections.push(event.reason?.name ?? "unknown");
      event.preventDefault();
    });
    const Constructor = unpatched ? window.keepaliveSdk.UnpatchedTelnyxRTC : window.keepaliveSdk.TelnyxRTC;
    const client = window.keepaliveClient = new Constructor({ login_token: "fixture", keepConnectionAliveOnSocketClose: true }) as Client;
    client.on("telnyx.warning", event => window.keepaliveWarnings.push(event.warning.code));
    const socket = window.keepaliveSocket = {
      readyState: 1, sent: [] as Array<{ method: string }>,
      send(body: string) { this.sent.push(JSON.parse(body)); },
      close() { this.readyState = 3; },
    };
    Object.assign(client.connection, { _wsClient: socket, socketGeneration: 1 });
  }, unpatched);
}

async function cancel(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    window.keepaliveClient.connection.socketGeneration++;
    window.keepaliveClient.connection.close();
  });
  await page.clock.runFor(1);
}

test("unmodified ESM SDK reproduces the production stale-request rejection", async ({ page }) => {
  await start(page, true);
  await page.evaluate(() => window.keepaliveClient._onSocketMessage({ id: "server-ping", method: "telnyx_rtc.ping", params: {} }));
  await cancel(page);
  await expect.poll(() => page.evaluate(() => window.keepaliveRejections)).toEqual(["StaleRequestError"]);
});

for (const source of ["server-ping", "keepalive-timer"]) {
  test(`${source} cancellation stays handled in the application adapter`, async ({ page }) => {
    await start(page);
    if (source === "server-ping") {
      await page.evaluate(() => window.keepaliveClient._onSocketMessage({ id: "server-ping", method: "telnyx_rtc.ping", params: {} }));
    } else {
      await page.evaluate(() => window.keepaliveClient._triggerKeepAliveTimeoutCheck());
      await page.clock.runFor(35_000);
    }
    expect(await page.evaluate(() => window.keepaliveSocket.sent.map(request => request.method))).toEqual(["telnyx_rtc.ping"]);
    await cancel(page);
    await page.clock.runFor(10_000);
    expect(await page.evaluate(() => window.keepaliveRejections)).toEqual([]);
  });
}

test("a real ping timeout still starts SDK signaling recovery without an unhandled rejection", async ({ page }) => {
  await start(page);
  await page.evaluate(() => window.keepaliveClient._onSocketMessage({ id: "server-ping", method: "telnyx_rtc.ping", params: {} }));
  await page.clock.runFor(10_001);
  expect(await page.evaluate(() => window.keepaliveWarnings)).toEqual([36003]);
  expect(await page.evaluate(() => window.keepaliveSocket.readyState)).toBe(3);
  expect(await page.evaluate(() => window.keepaliveRejections)).toEqual([]);
});

test("an unhandled non-keepalive failure remains visible to browser diagnostics", async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    void window.keepaliveClient.execute({ request: { id: "modify", method: "telnyx_rtc.modify", params: {} } } as Parameters<Client["execute"]>[0]);
  });
  await cancel(page);
  await expect.poll(() => page.evaluate(() => window.keepaliveRejections)).toEqual(["StaleRequestError"]);
});
