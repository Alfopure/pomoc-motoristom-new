import { TELEPHONY_TIMEOUT_MS, telephonyJson } from "@/lib/telephony/client-request";
import type { AnnouncementConfig, AnnouncementKey, AnnouncementLanguage } from "@/lib/telephony/announcements";

export type AnnouncementLine = {
  id: string;
  label: string;
  phoneNumber: string;
  config: AnnouncementConfig;
  revision: string;
};

export type AnnouncementsResponse = {
  lines: AnnouncementLine[];
  canEdit: boolean;
  generationAvailable: boolean;
};

export type GeneratedAnnouncement = {
  audioUrl: string;
  text: string;
  voiceId: string;
  language: AnnouncementLanguage;
};

type ErrorBody = { error?: string; code?: string };
const ENDPOINT = "/api/telephony/config/announcements";

export class AnnouncementRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "AnnouncementRequestError";
  }
}

async function request<T>(
  url: string,
  { method, body, signal }: { method?: "PUT" | "POST"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const result = await telephonyJson<T & ErrorBody>(url, {
    ...(method ? { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    signal,
    label: method === "POST" ? "vytvorenie hlasovej nahrávky" : "nastavenia hlášok",
    timeoutMs: method === "POST" ? 60_000 : method ? TELEPHONY_TIMEOUT_MS.mutation : TELEPHONY_TIMEOUT_MS.read,
  });
  if (!result.ok || !result.body) {
    throw new AnnouncementRequestError(
      result.body?.error ?? "Požiadavku sa nepodarilo dokončiť. Vaše rozpísané zmeny zostali zachované.",
      result.body?.code ?? "announcements_failed",
      result.status,
    );
  }
  return result.body;
}

export function loadAnnouncements(signal?: AbortSignal) {
  return request<AnnouncementsResponse>(ENDPOINT, { signal });
}

export function saveAnnouncements(line: AnnouncementLine, config: AnnouncementConfig) {
  return request<AnnouncementLine>(ENDPOINT, { method: "PUT", body: { lineId: line.id, revision: line.revision, config } });
}

export function generateAnnouncement(body: { lineId: string; key: AnnouncementKey; language: AnnouncementLanguage; text: string; voiceId: string }) {
  return request<GeneratedAnnouncement>(`${ENDPOINT}/generate`, { method: "POST", body });
}
