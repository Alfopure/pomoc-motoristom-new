import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_ANNOUNCEMENT_VOICE, defaultAnnouncementConfig, type AnnouncementConfig } from "@/lib/telephony/announcements";
import { createFakeSupabase } from "@/test/fake-supabase";

import {
  ANNOUNCEMENT_BUCKET,
  MAX_ANNOUNCEMENT_AUDIO_BYTES,
  announcementGenerationAvailable,
  generateAnnouncementAudio,
  getAnnouncementLines,
  parseAnnouncementConfig,
  saveLineAnnouncements,
  type AnnouncementGenerationDeps,
} from "./announcements-service";

const ORG = "00000000-0000-4000-8000-000000000001";
const LINE = "00000000-0000-4000-8000-000000000201";
const OTHER_ORG = "00000000-0000-4000-8000-000000000099";
const NOW = "2026-09-06T10:00:00.000Z";
const ACTOR = { profileId: "00000000-0000-4000-8000-000000000105", role: "manager" as const };
const GENERATE = { organizationId: ORG, lineId: LINE, key: "greeting", language: "sk", text: "Pomoc motoristom. Prosím, zostaňte na linke.", voiceId: DEFAULT_ANNOUNCEMENT_VOICE };
const AUDIO = Buffer.from("ID3a small mock mp3 body");

function world() {
  const fake = createFakeSupabase({ now: () => new Date(NOW) });
  fake.db.seed("motorist_telephony_lines", [
    { id: LINE, organization_id: ORG, provider: "telnyx", label: "Hlavná linka", phone_number: "+421232408700", metadata: { existingSetting: { enabled: true } } },
    { id: "00000000-0000-4000-8000-000000000299", organization_id: OTHER_ORG, provider: "telnyx", label: "Cudzia linka", phone_number: "+421232408799", metadata: {} },
  ]);
  const uploaded = new Map<string, Buffer>();
  const bucket = {
    upload: vi.fn(async (path: string, bytes: Buffer) => {
      uploaded.set(path, bytes);
      return { data: { path }, error: null as { statusCode: string; message: string } | null };
    }),
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://copy-project.supabase.co/storage/v1/object/public/${ANNOUNCEMENT_BUCKET}/${path}` } }),
  };
  const storage = {
    from: vi.fn(() => bucket),
    getBucket: vi.fn(async () => ({ data: { public: true } as { public: boolean } | null, error: null as { statusCode: string; message: string } | null })),
    createBucket: vi.fn(async () => ({ data: {}, error: null as { statusCode: string; message: string } | null })),
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(AUDIO, { headers: { "Content-Type": "audio/mpeg" } }));
  const deps: AnnouncementGenerationDeps = { admin: Object.assign(fake.admin, { storage }), now: () => new Date(NOW), apiKey: "test-server-key", fetch };
  return { ...fake, deps, fetch, storage, bucket, uploaded };
}

function configWith(text = GENERATE.text): AnnouncementConfig {
  return { ...defaultAnnouncementConfig(), prompts: { sk: { greeting: { text } } } };
}

afterEach(() => vi.unstubAllEnvs());

describe("announcement configuration", () => {
  it("reads only this organization's Telnyx lines without exposing unrelated metadata", async () => {
    const h = world();
    await expect(getAnnouncementLines(h.deps, ORG)).resolves.toEqual([
      { id: LINE, label: "Hlavná linka", phoneNumber: "+421232408700", config: defaultAnnouncementConfig(), revision: NOW },
    ]);
  });

  it("preserves unrelated metadata and records the save actor", async () => {
    const h = world();
    const saved = await saveLineAnnouncements(h.deps, { organizationId: ORG, actor: ACTOR, lineId: LINE, revision: NOW, config: configWith() });
    expect(saved.config).toEqual(configWith());
    expect(saved.revision).not.toBe(NOW);
    expect(h.db.find("motorist_telephony_lines", (row) => row.id === LINE)?.metadata).toEqual({ existingSetting: { enabled: true }, announcements: configWith() });
    expect(h.db.rows("motorist_audit_log")).toMatchObject([{ actor_profile_id: ACTOR.profileId, action: "telephony.announcements.update", entity_id: LINE }]);
  });

  it("rejects a stale browser revision instead of overwriting a colleague's edit", async () => {
    const h = world();
    await saveLineAnnouncements(h.deps, { organizationId: ORG, actor: ACTOR, lineId: LINE, revision: NOW, config: configWith() });
    await expect(saveLineAnnouncements(h.deps, { organizationId: ORG, actor: ACTOR, lineId: LINE, revision: NOW, config: configWith("Iný text.") })).rejects.toMatchObject({ status: 409, code: "stale_document" });
    expect(h.db.rows("motorist_audit_log")).toHaveLength(1);
  });

  it("compares the revision atomically when another write happens after the read", async () => {
    const h = world();
    const from = h.client.from.bind(h.client);
    vi.spyOn(h.deps.admin, "from").mockImplementation(((table: string) => {
      const builder = from(table);
      if (table === "motorist_telephony_lines") {
        const originalUpdate = builder.update.bind(builder);
        builder.update = ((...args: Parameters<typeof originalUpdate>) => {
          h.db.update("motorist_telephony_lines", { updated_at: "2026-09-06T10:00:01.000Z", metadata: { colleagueEdit: true } }, (row) => row.id === LINE);
          return originalUpdate(...args);
        }) as typeof builder.update;
      }
      return builder;
    }) as unknown as typeof h.deps.admin.from);
    await expect(saveLineAnnouncements(h.deps, { organizationId: ORG, actor: ACTOR, lineId: LINE, revision: NOW, config: configWith() })).rejects.toMatchObject({ status: 409, code: "stale_document" });
    expect(h.db.find("motorist_telephony_lines", (row) => row.id === LINE)?.metadata).toEqual({ colleagueEdit: true });
    expect(h.db.rows("motorist_audit_log")).toHaveLength(0);
  });

  it("rejects missing revisions and foreign lines before updating anything", async () => {
    const h = world();
    await expect(saveLineAnnouncements(h.deps, { organizationId: ORG, actor: ACTOR, lineId: LINE, config: configWith() })).rejects.toMatchObject({ status: 400, code: "version_required" });
    await expect(saveLineAnnouncements(h.deps, { organizationId: OTHER_ORG, actor: ACTOR, lineId: LINE, revision: NOW, config: configWith() })).rejects.toMatchObject({ status: 404 });
    expect(h.db.log.filter((entry) => entry.operation === "update")).toHaveLength(0);
  });

  it.each([
    null,
    { ...defaultAnnouncementConfig(), version: 2 },
    { ...defaultAnnouncementConfig(), language: "xx" },
    { ...defaultAnnouncementConfig(), voiceId: "arbitrary-paid-voice" },
    { ...defaultAnnouncementConfig(), prompts: [] },
    { ...defaultAnnouncementConfig(), prompts: { xx: {} } },
    { ...defaultAnnouncementConfig(), prompts: { sk: { unknown: { text: "Hello" } } } },
    configWith(" "),
    configWith("x".repeat(601)),
  ])("strictly rejects invalid config %j", (config) => {
    const h = world();
    expect(() => parseAnnouncementConfig(h.deps, ORG, LINE, config)).toThrow();
  });

  it("accepts generation output, then rejects audio reused with another text, language, key or line", async () => {
    const h = world();
    const generated = await generateAnnouncementAudio(h.deps, GENERATE);
    const prompt = { text: generated.text, audioUrl: generated.audioUrl, voiceId: generated.voiceId };
    const config: AnnouncementConfig = { ...defaultAnnouncementConfig(), prompts: { sk: { greeting: prompt } } };
    expect(parseAnnouncementConfig(h.deps, ORG, LINE, config)).toEqual(config);
    expect(() => parseAnnouncementConfig(h.deps, ORG, LINE, { ...config, prompts: { sk: { greeting: { ...prompt, text: "Nový text." } } } })).toThrow("Zvuk nezodpovedá");
    expect(() => parseAnnouncementConfig(h.deps, ORG, LINE, { ...config, prompts: { cs: { greeting: prompt } } })).toThrow("Zvuk nezodpovedá");
    expect(() => parseAnnouncementConfig(h.deps, ORG, LINE, { ...config, prompts: { sk: { allBusy: prompt } } })).toThrow("Zvuk nezodpovedá");
    expect(() => parseAnnouncementConfig(h.deps, ORG, "another-line", config)).toThrow("Zvuk nezodpovedá");
    expect(() => parseAnnouncementConfig(h.deps, ORG, LINE, { ...config, prompts: { sk: { greeting: { ...prompt, audioUrl: "https://other.test/file.mp3" } } } })).toThrow("Zvuk nezodpovedá");
  });
});

describe("ElevenLabs announcement generation", () => {
  it("uses the server key and selected voice, uploads immutable MP3, and never activates the preview", async () => {
    const h = world();
    const result = await generateAnnouncementAudio(h.deps, GENERATE);
    expect(h.fetch).toHaveBeenCalledWith(`https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_ANNOUNCEMENT_VOICE}?output_format=mp3_44100_128`, expect.objectContaining({
      method: "POST", headers: { "xi-api-key": "test-server-key", "Content-Type": "application/json", Accept: "audio/mpeg" }, cache: "no-store", signal: expect.any(AbortSignal),
    }));
    const body = JSON.parse(h.fetch.mock.calls[0][1]?.body as string);
    expect(body).toMatchObject({ text: GENERATE.text, model_id: "eleven_multilingual_v2" });
    expect(body).not.toHaveProperty("language_code");
    expect(result).toMatchObject({ text: GENERATE.text, voiceId: DEFAULT_ANNOUNCEMENT_VOICE, language: "sk" });
    expect(result.audioUrl).toMatch(new RegExp(`/${ORG}/${LINE}/sk/greeting/[a-f0-9]{64}/[a-f0-9]{64}\\.mp3$`));
    expect(h.bucket.upload).toHaveBeenCalledWith(expect.any(String), AUDIO, { contentType: "audio/mpeg", cacheControl: "31536000", upsert: false });
    expect(h.db.log.some((entry) => entry.operation === "update")).toBe(false);
    expect(JSON.stringify(result)).not.toContain("test-server-key");
  });

  it("creates the public audio bucket only when it is absent", async () => {
    const h = world();
    h.storage.getBucket.mockResolvedValueOnce({ data: null, error: { statusCode: "404", message: "Bucket not found" } });
    await generateAnnouncementAudio(h.deps, GENERATE);
    expect(h.storage.createBucket).toHaveBeenCalledWith(ANNOUNCEMENT_BUCKET, { public: true, allowedMimeTypes: ["audio/mpeg"], fileSizeLimit: MAX_ANNOUNCEMENT_AUDIO_BYTES });
  });

  it("does not expose an existing private bucket", async () => {
    const h = world();
    h.storage.getBucket.mockResolvedValueOnce({ data: { public: false }, error: null });
    await expect(generateAnnouncementAudio(h.deps, GENERATE)).rejects.toMatchObject({ code: "announcement_storage_failed" });
    expect(h.storage.createBucket).not.toHaveBeenCalled();
    expect(h.bucket.upload).not.toHaveBeenCalled();
  });

  it("rejects foreign lines before contacting ElevenLabs or storage", async () => {
    const h = world();
    await expect(generateAnnouncementAudio(h.deps, { ...GENERATE, organizationId: OTHER_ORG })).rejects.toMatchObject({ status: 404 });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.storage.getBucket).not.toHaveBeenCalled();
  });

  it.each([
    { text: "x".repeat(601) },
    { text: " " },
    { voiceId: "../../different-endpoint" },
    { language: "fr" },
    { key: "unknown" },
    { lineId: "invalid-uuid" },
  ])("rejects invalid generation input %j before spending credits", async (patch) => {
    const h = world();
    await expect(generateAnnouncementAudio(h.deps, { ...GENERATE, ...patch })).rejects.toMatchObject({ status: 400 });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("reports absent server configuration and ignores keys supplied in the request", async () => {
    const h = world();
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect(announcementGenerationAvailable()).toBe(false);
    await expect(generateAnnouncementAudio({ ...h.deps, apiKey: undefined }, { ...GENERATE, apiKey: "browser-key" })).rejects.toMatchObject({ status: 503, code: "generation_unavailable" });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500])("sanitizes provider failure %s", async (status) => {
    const h = world();
    h.fetch.mockResolvedValueOnce(new Response("secret provider diagnostic test-server-key", { status }));
    const error = await generateAnnouncementAudio(h.deps, GENERATE).catch((error: Error) => error);
    expect(error).toMatchObject({ status: status === 429 ? 429 : status === 401 || status === 403 ? 503 : 502 });
    expect(JSON.stringify(error)).not.toContain("test-server-key");
    expect(String(error)).not.toContain("secret provider diagnostic");
    expect(h.bucket.upload).not.toHaveBeenCalled();
  });

  it("sanitizes rejected network requests and reports timeout separately", async () => {
    const h = world();
    h.fetch.mockRejectedValueOnce(new Error("socket failure with test-server-key"));
    await expect(generateAnnouncementAudio(h.deps, GENERATE)).rejects.toMatchObject({ status: 502, message: "Generátor zvuku je dočasne nedostupný. Skús to znova." });
    h.fetch.mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"));
    await expect(generateAnnouncementAudio(h.deps, GENERATE)).rejects.toMatchObject({ status: 504, code: "generation_timeout" });
  });

  it("rejects errors disguised as audio, empty clips and oversized streams", async () => {
    const h = world();
    h.fetch.mockResolvedValueOnce(new Response("not an MP3", { headers: { "Content-Type": "audio/mpeg" } }));
    await expect(generateAnnouncementAudio(h.deps, GENERATE)).rejects.toMatchObject({ code: "generation_invalid_audio" });
    h.fetch.mockResolvedValueOnce(new Response("", { headers: { "Content-Type": "audio/mpeg" } }));
    await expect(generateAnnouncementAudio(h.deps, GENERATE)).rejects.toMatchObject({ code: "generation_invalid_audio" });
    h.fetch.mockResolvedValueOnce(new Response(Buffer.alloc(MAX_ANNOUNCEMENT_AUDIO_BYTES + 1), { headers: { "Content-Type": "audio/mpeg" } }));
    await expect(generateAnnouncementAudio(h.deps, GENERATE)).rejects.toMatchObject({ code: "generation_audio_too_large" });
    expect(h.bucket.upload).not.toHaveBeenCalled();
  });

  it("sanitizes storage errors and safely reuses identical immutable output", async () => {
    const h = world();
    h.bucket.upload.mockResolvedValueOnce({ data: { path: "" }, error: { statusCode: "500", message: "secret storage diagnostic" } });
    await expect(generateAnnouncementAudio(h.deps, GENERATE)).rejects.toMatchObject({ code: "announcement_storage_failed", message: "Zvuk sa nepodarilo uložiť. Skús ho vytvoriť znova." });
    h.bucket.upload.mockResolvedValueOnce({ data: { path: "" }, error: { statusCode: "409", message: "Already exists" } });
    await expect(generateAnnouncementAudio(h.deps, GENERATE)).resolves.toMatchObject({ text: GENERATE.text });
  });
});
