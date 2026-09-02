import "server-only";

import Anthropic from "@anthropic-ai/sdk";

import type { SpeakerSegment } from "@/server/telephony/transcripts-process";

const MODEL = "claude-opus-4-8";

export type CallAnalysis = {
  summary: string;
  extracted_fields: {
    spz: string | null;
    lokalita: string | null;
    typ_poruchy: string | null;
    dohodnuty_krok: string | null;
    telefon: string | null;
  };
  qa_score: number | null;
  qa_breakdown: Record<string, number> | null;
  qa_notes: Array<{ time_ref: string; note: string }>;
};

export class CallAnalysisError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
    this.name = "CallAnalysisError";
  }
}

export function isCallAnalysisConfigured() {
  return Boolean(apiKey());
}

export const DEFAULT_QA_RUBRIC = `Hodnotíš prácu dispečera asistenčnej služby pre motoristov (odťahy, poruchy, náhradné vozidlá).
Kritériá (každé 0-100):
- pozdrav: predstavil sa dispečer a firmu, profesionálny úvod
- zistenie_udajov: zistil polohu, vozidlo (ideálne ŠPZ), typ problému a kontakt
- riesenie: ponúkol konkrétne riešenie primerané problému
- dohodnuty_krok: hovor končí jasným ďalším krokom (kto, čo, kedy)
- ton: profesionálny, empatický a pokojný prejav
- efektivita_casu: hovor bez zbytočných odbočiek a hluchých miest
Celkové qa_score je vážený úsudok, nie priemer.`;

// One structured-outputs call over the diarized transcript. When includeQa is false
// (low speaker-attribution confidence — the plan's runtime gate), only the summary and
// extraction run and every QA field stays null.
export async function analyzeCallTranscript(options: {
  transcriptText: string;
  segments: SpeakerSegment[];
  direction: "inbound" | "outbound";
  durationSeconds?: number | null;
  rubric?: string | null;
  includeQa: boolean;
}): Promise<CallAnalysis> {
  const key = apiKey();

  if (!key) {
    throw new CallAnalysisError("ANTHROPIC_API_KEY is not configured.", 503);
  }

  const client = new Anthropic({ apiKey: key });
  const transcript = renderTranscript(options.segments, options.transcriptText);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: analysisSchema(options.includeQa) },
    },
    system: [
      "Si analytik hovorov dispečingu asistenčnej služby pre motoristov na Slovensku.",
      "Pracuješ s prepisom telefonátu s rolami hovorcov a časmi v sekundách.",
      "summary: 2-4 vety po slovensky — kto volal, čo potreboval, čo sa dohodlo.",
      "extracted_fields: vyplň len údaje skutočne povedané v hovore, inak null.",
      options.includeQa
        ? `QA hodnotenie dispečera podľa rubriky (skóre 0-100, qa_notes s odkazom na čas v tvare "m:ss"):\n${options.rubric?.trim() || DEFAULT_QA_RUBRIC}`
        : "QA hodnotenie je vypnuté (nedôveryhodné priradenie hovorcov) — hodnotiace polia neuvádzaš.",
    ].join("\n\n"),
    messages: [
      {
        role: "user",
        content: `Smer hovoru: ${options.direction === "inbound" ? "prichádzajúci" : "odchádzajúci"}${
          options.durationSeconds ? `, dĺžka ${options.durationSeconds}s` : ""
        }\n\nPrepis:\n${transcript}`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    throw new CallAnalysisError("Claude refused to analyze the transcript.");
  }

  const block = response.content.find((item) => item.type === "text");

  if (!block || block.type !== "text") {
    throw new CallAnalysisError("Claude returned no text content.");
  }

  const parsed = JSON.parse(block.text) as CallAnalysis;

  return {
    summary: parsed.summary ?? "",
    extracted_fields: {
      spz: parsed.extracted_fields?.spz ?? null,
      lokalita: parsed.extracted_fields?.lokalita ?? null,
      typ_poruchy: parsed.extracted_fields?.typ_poruchy ?? null,
      dohodnuty_krok: parsed.extracted_fields?.dohodnuty_krok ?? null,
      telefon: parsed.extracted_fields?.telefon ?? null,
    },
    qa_score: options.includeQa ? clampScore(parsed.qa_score) : null,
    qa_breakdown: options.includeQa ? (parsed.qa_breakdown ?? null) : null,
    qa_notes: options.includeQa && Array.isArray(parsed.qa_notes) ? parsed.qa_notes : [],
  };
}

/** @internal exported for unit tests */
export function renderTranscript(segments: SpeakerSegment[], fallbackText: string) {
  if (segments.length === 0) {
    return fallbackText;
  }

  return segments
    .map((segment) => `[${formatTime(segment.start)}] ${speakerLabel(segment.speaker)}: ${segment.text}`)
    .join("\n");
}

function speakerLabel(speaker: string) {
  if (speaker === "dispecer") {
    return "Dispečer";
  }

  if (speaker === "volajuci") {
    return "Volajúci";
  }

  return speaker;
}

function formatTime(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** @internal exported for unit tests */
export function clampScore(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return Math.min(100, Math.max(0, Math.round(value)));
}

function analysisSchema(includeQa: boolean) {
  const nullableString = { type: ["string", "null"] };

  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "extracted_fields", "qa_score", "qa_breakdown", "qa_notes"],
    properties: {
      summary: { type: "string" },
      extracted_fields: {
        type: "object",
        additionalProperties: false,
        required: ["spz", "lokalita", "typ_poruchy", "dohodnuty_krok", "telefon"],
        properties: {
          spz: nullableString,
          lokalita: nullableString,
          typ_poruchy: nullableString,
          dohodnuty_krok: nullableString,
          telefon: nullableString,
        },
      },
      qa_score: includeQa ? { type: ["number", "null"] } : { type: "null" },
      qa_breakdown: includeQa
        ? {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["pozdrav", "zistenie_udajov", "riesenie", "dohodnuty_krok", "ton", "efektivita_casu"],
            properties: {
              pozdrav: { type: "number" },
              zistenie_udajov: { type: "number" },
              riesenie: { type: "number" },
              dohodnuty_krok: { type: "number" },
              ton: { type: "number" },
              efektivita_casu: { type: "number" },
            },
          }
        : { type: "null" },
      qa_notes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["time_ref", "note"],
          properties: {
            time_ref: { type: "string" },
            note: { type: "string" },
          },
        },
      },
    },
  };
}

function apiKey() {
  const value = process.env.ANTHROPIC_API_KEY?.trim();
  return value && !value.startsWith("replace-with") ? value : undefined;
}
