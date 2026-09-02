import "server-only";

// ElevenLabs Scribe speech-to-text with diarization. Request/response shape mirrors the
// production-proven voice worker in the Alfo ERP (scribe_v2, multipart, word timestamps).

export type ScribeWord = {
  type: string;
  text: string;
  start?: number;
  end?: number;
  speaker_id?: string;
};

export type ScribeTranscription = {
  text: string;
  languageCode?: string;
  languageProbability?: number;
  words: ScribeWord[];
  raw: Record<string, unknown>;
};

export class ScribeError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "ScribeError";
  }
}

export function isScribeConfigured() {
  return Boolean(apiKey());
}

export async function transcribeWithScribe(options: {
  audio: ArrayBuffer;
  mimeType?: string | null;
  diarize?: boolean;
  timeoutMs?: number;
}): Promise<ScribeTranscription> {
  const key = apiKey();

  if (!key) {
    throw new ScribeError("ELEVENLABS_API_KEY is not configured.", 503);
  }

  const form = new FormData();
  form.set("model_id", "scribe_v2");
  form.set("tag_audio_events", "true");
  form.set("timestamps_granularity", "word");
  form.set("diarize", options.diarize === false ? "false" : "true");
  form.set("no_verbatim", "false");
  form.set("file", new Blob([options.audio], { type: options.mimeType ?? "application/octet-stream" }), "audio");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 240_000);

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
      signal: controller.signal,
    });
    const text = await response.text();

    if (!response.ok) {
      throw new ScribeError(`Scribe returned HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
    }

    const raw = JSON.parse(text) as Record<string, unknown>;

    return {
      text: typeof raw.text === "string" ? raw.text : "",
      languageCode: typeof raw.language_code === "string" ? raw.language_code : undefined,
      languageProbability: typeof raw.language_probability === "number" ? raw.language_probability : undefined,
      words: Array.isArray(raw.words) ? (raw.words as ScribeWord[]) : [],
      raw,
    };
  } catch (error) {
    if (error instanceof ScribeError) {
      throw error;
    }

    if (error instanceof Error && error.name === "AbortError") {
      throw new ScribeError("Scribe transcription timed out.", 504);
    }

    throw new ScribeError(error instanceof Error ? error.message : "Scribe transcription failed.");
  } finally {
    clearTimeout(timeout);
  }
}

function apiKey() {
  const value = process.env.ELEVENLABS_API_KEY?.trim();
  return value && !value.startsWith("replace-with") ? value : undefined;
}
