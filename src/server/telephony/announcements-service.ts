import "server-only";

import { createHash } from "node:crypto";

import type { Database, Json } from "@/lib/supabase/database.types";
import {
  MAX_ANNOUNCEMENT_TEXT,
  announcementConfigFromMetadata,
  announcementVoiceSettings,
  isAnnouncementKey,
  isAnnouncementLanguage,
  isAnnouncementVoice,
  type AnnouncementConfig,
  type AnnouncementKey,
  type AnnouncementLanguage,
} from "@/lib/telephony/announcements";
import { isUuid } from "@/lib/telephony/uuid";

import { ConfigServiceError, type ConfigActor, type ConfigDeps } from "./config-service";

export const ANNOUNCEMENT_BUCKET = "motorist-telephony-prompts";
export const MAX_ANNOUNCEMENT_AUDIO_BYTES = 2 * 1024 * 1024;
const GENERATION_TIMEOUT_MS = 30_000;
const ELEVENLABS_MODEL = "eleven_multilingual_v2";
const LINE_COLUMNS = "id,label,phone_number,metadata,updated_at";
type LineRow = Pick<Database["public"]["Tables"]["motorist_telephony_lines"]["Row"], "id" | "label" | "phone_number" | "metadata" | "updated_at">;
export type AnnouncementLine = { id: string; label: string; phoneNumber: string; config: AnnouncementConfig; revision: string };
export type AnnouncementGenerationDeps = ConfigDeps & { fetch?: typeof fetch; apiKey?: string };
type GenerationInput = { lineId: string; key: AnnouncementKey; language: AnnouncementLanguage; text: string; voiceId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function invalid(message: string, code = "announcement_invalid"): never {
  throw new ConfigServiceError(message, 400, code);
}

function lineIdOf(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) invalid("Vyber platnú telefónnu linku.", "line_invalid");
  return value;
}

function promptText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ANNOUNCEMENT_TEXT) {
    invalid(`Text hlásenia musí mať 1 až ${MAX_ANNOUNCEMENT_TEXT} znakov.`, "announcement_text_invalid");
  }
  return value.trim();
}

function lineDocument(row: LineRow): AnnouncementLine {
  return { id: row.id, label: row.label, phoneNumber: row.phone_number, config: announcementConfigFromMetadata(row.metadata), revision: row.updated_at };
}

export function announcementGenerationAvailable(): boolean {
  return Boolean(process.env.ELEVENLABS_API_KEY?.trim());
}

export async function getAnnouncementLines(deps: ConfigDeps, organizationId: string): Promise<AnnouncementLine[]> {
  const { data, error } = await deps.admin.from("motorist_telephony_lines").select(LINE_COLUMNS).eq("organization_id", organizationId).eq("provider", "telnyx").order("label");
  if (error) throw new ConfigServiceError("Hlásenia sa nepodarilo načítať.", 500, "config_read_failed");
  return (data ?? []).map(lineDocument);
}

async function getLine(deps: ConfigDeps, organizationId: string, lineId: string): Promise<LineRow> {
  const { data, error } = await deps.admin.from("motorist_telephony_lines").select(LINE_COLUMNS).eq("id", lineId).eq("organization_id", organizationId).eq("provider", "telnyx").maybeSingle();
  if (error) throw new ConfigServiceError("Linku sa nepodarilo načítať.", 500, "config_read_failed");
  if (!data) throw new ConfigServiceError("Linka neexistuje.", 404, "line_not_found");
  return data;
}

function assetPrefix(organizationId: string, input: GenerationInput): string {
  // Binding the folder to text, language and voice prevents saving an old clip
  // beside edited text. Audio content has its own immutable hash filename.
  const descriptor = JSON.stringify([1, input.key, input.language, input.text, input.voiceId, ELEVENLABS_MODEL, announcementVoiceSettings(input.voiceId)]);
  const hash = createHash("sha256").update(descriptor).digest("hex");
  return `${organizationId}/${input.lineId}/${input.language}/${input.key}/${hash}/`;
}

function validateAudioUrl(deps: ConfigDeps, organizationId: string, input: GenerationInput, value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) invalid("Zvuk hlásenia nie je platný.", "announcement_audio_invalid");
  const prefix = deps.admin.storage.from(ANNOUNCEMENT_BUCKET).getPublicUrl(assetPrefix(organizationId, input)).data.publicUrl;
  if (!value.startsWith(prefix) || !/^[a-f0-9]{64}\.mp3$/.test(value.slice(prefix.length))) {
    invalid("Zvuk nezodpovedá textu, jazyku alebo hlasu. Vytvor ho znova.", "announcement_audio_stale");
  }
  return value;
}

export function parseAnnouncementConfig(deps: ConfigDeps, organizationId: string, lineId: string, value: unknown): AnnouncementConfig {
  if (!isRecord(value) || value.version !== 1 || !isAnnouncementLanguage(value.language) || !isAnnouncementVoice(value.voiceId) || !isRecord(value.prompts)) {
    invalid("Nastavenie hlásení je neplatné. Vyber jazyk a hlas.");
  }
  if (Object.keys(value).some((key) => !["version", "language", "voiceId", "inboundStartAnnouncements", "outboundStartAnnouncements", "recordingStatusAnnouncements", "prompts"].includes(key))) invalid("Nastavenie hlásení obsahuje neznáme pole.");
  for (const key of ["inboundStartAnnouncements", "outboundStartAnnouncements"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") invalid("Vyberte, či sa majú prehrávať úvodné hlášky pre každý smer hovoru.");
  }
  if (value.recordingStatusAnnouncements !== undefined && typeof value.recordingStatusAnnouncements !== "boolean") invalid("Vyberte, či sa majú prehrávať hlášky o zmenách nahrávania.");
  const config: AnnouncementConfig = { version: 1, language: value.language, voiceId: value.voiceId, inboundStartAnnouncements: value.inboundStartAnnouncements !== false,
    outboundStartAnnouncements: value.outboundStartAnnouncements === true, recordingStatusAnnouncements: value.recordingStatusAnnouncements === true, prompts: {} };
  for (const [language, prompts] of Object.entries(value.prompts)) {
    if (!isAnnouncementLanguage(language) || !isRecord(prompts)) invalid("Neplatný jazyk hlásenia.");
    for (const [key, prompt] of Object.entries(prompts)) {
      if (!isAnnouncementKey(key) || !isRecord(prompt) || Object.keys(prompt).some((field) => !["text", "audioUrl", "voiceId"].includes(field))) invalid("Neplatný typ hlásenia.");
      const text = promptText(prompt.text);
      if (prompt.voiceId !== undefined && !isAnnouncementVoice(prompt.voiceId)) invalid("Vyber jeden z dostupných hlasov.", "announcement_voice_invalid");
      if (prompt.audioUrl !== undefined && !isAnnouncementVoice(prompt.voiceId)) invalid("K zvuku chýba použitý hlas.", "announcement_voice_invalid");
      const audioUrl = prompt.audioUrl === undefined ? undefined : validateAudioUrl(deps, organizationId, { lineId, key, language, text, voiceId: prompt.voiceId as string }, prompt.audioUrl);
      (config.prompts[language] ??= {})[key] = { text, ...(audioUrl ? { audioUrl } : {}), ...(prompt.voiceId ? { voiceId: prompt.voiceId as string } : {}) };
    }
  }
  return config;
}

export async function saveLineAnnouncements(
  deps: ConfigDeps,
  input: { organizationId: string; actor: ConfigActor; lineId?: unknown; revision?: unknown; config?: unknown },
): Promise<AnnouncementLine> {
  const lineId = lineIdOf(input.lineId);
  if (typeof input.revision !== "string" || input.revision.length > 64 || !Number.isFinite(Date.parse(input.revision))) {
    invalid("Chýba verzia konfigurácie. Načítaj hlásenia znova.", "version_required");
  }
  const config = parseAnnouncementConfig(deps, input.organizationId, lineId, input.config);
  const current = await getLine(deps, input.organizationId, lineId);
  const stale = () => new ConfigServiceError("Linku medzitým upravil kolega. Načítaj hlásenia znova.", 409, "stale_document");
  if (current.updated_at !== input.revision) throw stale();
  const metadata = { ...(isRecord(current.metadata) ? current.metadata : {}), announcements: config } as Json;
  const updatedAt = new Date(Math.max((deps.now?.() ?? new Date()).getTime(), new Date(current.updated_at).getTime() + 1)).toISOString();
  const { data, error } = await deps.admin.from("motorist_telephony_lines")
    .update({ metadata, updated_at: updatedAt })
    .eq("id", lineId).eq("organization_id", input.organizationId).eq("provider", "telnyx").eq("updated_at", input.revision)
    .select(LINE_COLUMNS).maybeSingle();
  if (error) throw new ConfigServiceError("Hlásenia sa nepodarilo uložiť.", 500, "config_write_failed");
  if (!data) throw stale();

  // The save has already succeeded; an audit failure must not invite a retry
  // against a revision which is now stale.
  try {
    const audit = await deps.admin.from("motorist_audit_log").insert({
      organization_id: input.organizationId,
      actor_profile_id: input.actor.profileId,
      action: "telephony.announcements.update",
      entity_type: "telephony_line",
      entity_id: lineId,
      source: "dispatch_console",
      before_payload: announcementConfigFromMetadata(current.metadata) as unknown as Json,
      after_payload: config as unknown as Json,
    });
    if (audit.error) console.error("Announcement configuration audit insert failed.");
  } catch {
    console.error("Announcement configuration audit insert failed.");
  }
  return lineDocument(data);
}

function parseGenerationInput(input: Record<string, unknown>): GenerationInput {
  const lineId = lineIdOf(input.lineId);
  if (!isAnnouncementKey(input.key)) invalid("Vyber platné hlásenie.");
  if (!isAnnouncementLanguage(input.language)) invalid("Vyber dostupný jazyk hlásenia.");
  if (!isAnnouncementVoice(input.voiceId)) invalid("Vyber jeden z dostupných hlasov.", "announcement_voice_invalid");
  return { lineId, key: input.key, language: input.language, text: promptText(input.text), voiceId: input.voiceId };
}

function storageError(): ConfigServiceError {
  return new ConfigServiceError("Zvuk sa nepodarilo uložiť. Skús ho vytvoriť znova.", 502, "announcement_storage_failed");
}

async function ensurePublicBucket(deps: ConfigDeps): Promise<void> {
  const existing = await deps.admin.storage.getBucket(ANNOUNCEMENT_BUCKET);
  if (!existing.error) {
    if (!existing.data?.public) throw storageError();
    return;
  }
  if (String(existing.error.statusCode) !== "404" && !/bucket not found/i.test(existing.error.message)) throw storageError();
  const created = await deps.admin.storage.createBucket(ANNOUNCEMENT_BUCKET, { public: true, allowedMimeTypes: ["audio/mpeg"], fileSizeLimit: MAX_ANNOUNCEMENT_AUDIO_BYTES });
  if (!created.error) return;
  // Another generator may have created the bucket after our first lookup.
  const raced = await deps.admin.storage.getBucket(ANNOUNCEMENT_BUCKET);
  if (raced.error || !raced.data?.public) throw storageError();
}

async function readAudio(response: Response): Promise<Buffer> {
  if (!response.body || !/^audio\/(mpeg|mp3)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
    throw new ConfigServiceError("Generátor nevrátil platný zvuk. Skús to znova.", 502, "generation_invalid_audio");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_ANNOUNCEMENT_AUDIO_BYTES) {
        await reader.cancel();
        throw new ConfigServiceError("Vytvorený zvuk je príliš veľký. Skráť text hlásenia.", 502, "generation_audio_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const audio = Buffer.concat(chunks);
  if (audio.length < 3 || !(audio.subarray(0, 3).toString() === "ID3" || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0))) {
    throw new ConfigServiceError("Generátor nevrátil platný zvuk. Skús to znova.", 502, "generation_invalid_audio");
  }
  return audio;
}

export async function generateAnnouncementAudio(
  deps: AnnouncementGenerationDeps,
  input: { organizationId: string; [key: string]: unknown },
): Promise<{ audioUrl: string; text: string; voiceId: string; language: AnnouncementLanguage }> {
  const parsed = parseGenerationInput(input);
  // Verify tenancy before using paid generation or writing public storage.
  await getLine(deps, input.organizationId, parsed.lineId);
  const apiKey = deps.apiKey?.trim() || process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) throw new ConfigServiceError("Generovanie zvuku nie je nastavené. Správca musí pridať serverový kľúč ElevenLabs.", 503, "generation_unavailable");
  let audio: Buffer;
  try {
    const response = await (deps.fetch ?? fetch)(`https://api.elevenlabs.io/v1/text-to-speech/${parsed.voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      // Multilingual v2 detects the language from text; its API does not support language_code.
      body: JSON.stringify({ text: parsed.text, model_id: ELEVENLABS_MODEL, voice_settings: announcementVoiceSettings(parsed.voiceId) }),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 429) throw new ConfigServiceError("Generátor je zaneprázdnený alebo sa minul kredit. Skús to neskôr.", 429, "generation_limited");
      if (response.status === 401 || response.status === 403) throw new ConfigServiceError("Generátor odmietol prístup. Správca musí skontrolovať kľúč ElevenLabs.", 503, "generation_unavailable");
      throw new ConfigServiceError("Generátor zvuku je dočasne nedostupný. Skús to znova.", 502, "generation_failed");
    }
    audio = await readAudio(response);
  } catch (error) {
    if (error instanceof ConfigServiceError) throw error;
    if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
      throw new ConfigServiceError("Vytváranie zvuku trvalo príliš dlho. Skús to znova.", 504, "generation_timeout");
    }
    // Never return or log provider bodies, headers or errors containing the key.
    throw new ConfigServiceError("Generátor zvuku je dočasne nedostupný. Skús to znova.", 502, "generation_failed");
  }
  try {
    await ensurePublicBucket(deps);
    const hash = createHash("sha256").update(audio).digest("hex");
    const path = `${assetPrefix(input.organizationId, parsed)}${hash}.mp3`;
    const bucket = deps.admin.storage.from(ANNOUNCEMENT_BUCKET);
    const uploaded = await bucket.upload(path, audio, { contentType: "audio/mpeg", cacheControl: "31536000", upsert: false });
    // Identical immutable bytes at this exact descriptor path are safe to reuse.
    if (uploaded.error && String(uploaded.error.statusCode) !== "409" && !/already exists|duplicate/i.test(uploaded.error.message)) throw storageError();
    return { audioUrl: bucket.getPublicUrl(path).data.publicUrl, text: parsed.text, voiceId: parsed.voiceId, language: parsed.language };
  } catch {
    throw storageError();
  }
}
