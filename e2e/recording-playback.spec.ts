import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import type { CallRecordingDetail } from "../src/lib/telephony/recording-quality";
import { pcmWav } from "../src/test/recording-wav-fixture";

const origin = "https://recording-playback.invalid";
const wav = pcmWav(8_000 * 2 * 8, 1, 8_000);
// A real, decodable low-volume tone; only the network boundary is mocked.
for (let sample = 0; sample < 8_000 * 8; sample += 1) wav.writeInt16LE(Math.round(Math.sin(sample * 2 * Math.PI * 440 / 8_000) * 1_000), 44 + sample * 2);
let script = "";

test.beforeAll(async () => {
  const bundle = await build({ entryPoints: ["e2e/fixtures/recording-playback.tsx"], bundle: true,
    write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  script = bundle.outputFiles[0].text;
});

test("plays a partial segment, seeks using segment-local time and switches the source", async ({ page }) => {
  const requests = await mount(page);
  await page.getByRole("button", { name: /Úsek 1/ }).click();
  const audio = page.locator("audio");
  await expect(audio).toHaveCount(1);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime > 0)).toBe(true);
  await expect(audio).toHaveAttribute("src", /segment-one\/audio$/);
  await page.getByRole("button", { name: /Syntetická replika/ }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime >= 3)).toBe(true);
  await audio.evaluate((element: HTMLAudioElement) => { element.pause(); element.currentTime = 5; });
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(5);
  await audio.evaluate((element: HTMLAudioElement) => element.play());
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused)).toBe(true);
  await audio.evaluate((element: HTMLAudioElement) => { (window as unknown as { oldAudio: HTMLAudioElement }).oldAudio = element; });
  await page.getByRole("button", { name: /Úsek 2/ }).click();
  await expect(audio).toHaveAttribute("src", /segment-two\/audio$/);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime > 0 && element.currentTime < 3)).toBe(true);
  expect(await page.evaluate(() => {
    const old = (window as unknown as { oldAudio: HTMLAudioElement }).oldAudio;
    return old.paused && !old.hasAttribute("src");
  })).toBe(true);
  expect(requests.audio.map((url) => url.split("/").at(-2))).toContain("segment-one");
  expect(requests.audio.map((url) => url.split("/").at(-2))).toContain("segment-two");
  expect(requests.blocked).toEqual([]);
});

test("shows an audio access failure and a new selection can recover", async ({ page }) => {
  const requests = await mount(page, { audioStatus: 403 });
  await page.getByRole("button", { name: /Úsek 1/ }).click();
  await expect(page.getByText("Zvuk sa nepodarilo načítať.", { exact: false })).toBeVisible();
  expect(await page.locator("audio").evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
  requests.allowAudio();
  await page.getByRole("button", { name: /Úsek 2/ }).click();
  await expect.poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime > 0)).toBe(true);
  await expect(page.getByText("Zvuk sa nepodarilo načítať.", { exact: false })).toHaveCount(0);
  expect(requests.blocked).toEqual([]);
});

test("an available partial file plays despite unverified global coverage, while transcript seeks stay blocked", async ({ page }) => {
  const requests = await mount(page, { unverifiedCoverage: true });
  await page.getByRole("button", { name: /Syntetická replika/ }).click();
  await expect(page.getByText("Tento čas nie je v dostupnej nahrávke.", { exact: false })).toBeVisible();
  expect(requests.audio).toEqual([]);
  await page.getByRole("button", { name: /Úsek 1/ }).click();
  await expect(page.locator("audio")).toHaveCount(1);
  await expect.poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime > 0)).toBe(true);
  await expect(page.getByText("Tento čas nie je v dostupnej nahrávke.", { exact: false })).toHaveCount(0);
  expect(requests.blocked).toEqual([]);
});

test("denied detail refresh removes the audio and stops playback", async ({ page }) => {
  const requests = await mount(page);
  await page.getByRole("button", { name: /Úsek 1/ }).click();
  await expect.poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => !element.paused)).toBe(true);
  await page.locator("audio").evaluate((element: HTMLAudioElement) => { (window as unknown as { removedAudio: HTMLAudioElement }).removedAudio = element; });
  requests.denyDetail();
  await page.getByRole("button", { name: "Obnoviť", exact: true }).click();
  await expect(page.locator("audio")).toHaveCount(0);
  expect(await page.evaluate(() => {
    const audio = (window as unknown as { removedAudio: HTMLAudioElement }).removedAudio;
    return audio.paused && !audio.hasAttribute("src");
  })).toBe(true);
  expect(requests.blocked).toEqual([]);
});

async function mount(page: Page, options: { audioStatus?: number; unverifiedCoverage?: boolean } = {}) {
  let audioStatus = options.audioStatus ?? 206;
  let detailStatus = 200;
  const audio: string[] = [];
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (request.method() !== "GET" || url.origin !== origin) { blocked.push(`${request.method()} ${url.pathname}`); await route.abort(); return; }
    if (url.pathname === "/") { await route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div></body></html>' }); return; }
    if (url.pathname === "/api/telephony/calls/fixture-call/recording-detail") {
      const recording = detail();
      if (options.unverifiedCoverage) recording.gaps = [{ startSeconds: 16, endSeconds: 24, reason: "Úplnosť záznamu nie je overená" }];
      await route.fulfill({ status: detailStatus, contentType: "application/json", body: JSON.stringify(detailStatus === 200 ? recording : { error: "Prístup bol odobratý." }) }); return;
    }
    if (/^\/api\/telephony\/calls\/fixture-call\/recordings\/segment-(one|two)\/audio$/.test(url.pathname)) {
      audio.push(url.pathname);
      if (audioStatus !== 206) { await route.fulfill({ status: audioStatus, contentType: "application/json", body: '{"error":"Prístup bol odobratý."}' }); return; }
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "bytes=0-")!;
      const start = Number(range[1]); const end = Math.min(range[2] ? Number(range[2]) : wav.length - 1, wav.length - 1);
      await route.fulfill({ status: 206, body: wav.subarray(start, end + 1), headers: {
        "content-type": "audio/wav", "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${wav.length}`,
        "accept-ranges": "bytes", "cache-control": "private, no-store",
      } }); return;
    }
    blocked.push(`${request.method()} ${url.pathname}`); await route.abort();
  });
  await page.goto(origin);
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("button", { name: /Úsek 1/ })).toBeVisible();
  return { audio, blocked, allowAudio: () => { audioStatus = 206; }, denyDetail: () => { detailStatus = 403; } };
}

function detail(): CallRecordingDetail {
  return {
    callId: "fixture-call", sourceRevision: 1, access: "full", state: "partial", stateReason: null, liveState: "stopped", suppressed: false,
    segments: [
      { id: "segment-one", index: 0, startSeconds: 16, durationSeconds: 8, state: "partial", channels: null, canPlay: true, error: null },
      { id: "segment-two", index: 1, startSeconds: 26, durationSeconds: 8, state: "ready", channels: 2, canPlay: true, error: null },
    ], gaps: [{ startSeconds: 24, endSeconds: 26, reason: "Nezachytený úsek" }],
    transcript: { status: "ready", language: "sk", spans: [{ id: "span", transcriptId: "transcript", segmentId: "segment-one", startSeconds: 19, endSeconds: 20,
      text: "Syntetická replika", speakerLabel: "Operátor", role: "operator", operatorId: "operator", identityVerified: true }] }, analysis: null, metrics: null,
    capabilities: { canReview: false, canAppeal: false, canCorrect: false, canDelete: false, canControl: false, canRetry: false },
  };
}
