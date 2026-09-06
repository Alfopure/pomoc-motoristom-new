import { QUALITY_CRITERIA, type RecordingTranscriptSpan } from "@/lib/telephony/recording-quality";
import type { ModelCriterion, QualitySource } from "@/lib/telephony/quality-scoring";

export function qualitySpan(id: string, start: number, end: number, role: RecordingTranscriptSpan["role"] = "operator", operatorId: string | null = role === "operator" ? "operator-a" : null): RecordingTranscriptSpan {
  return { id, transcriptId: "transcript-a", segmentId: "segment-a", startSeconds: start, endSeconds: end, text: `Výrok ${id}.`, speakerLabel: role === "operator" ? "Jana" : "Zákazník", role, operatorId, identityVerified: true };
}

export function qualitySourceFixture(): QualitySource {
  const system = { ...qualitySpan("system", 0, 2, "system"), text: "Pomoc motoristom. Zostaňte na linke.", speakerLabel: "Automat" };
  const greeting = { ...qualitySpan("greeting-a", 5, 8), text: "Dobrý deň, Pomoc motoristom, Jana pri telefóne." };
  const next = { ...qualitySpan("next-a", 25, 30), text: "Overím dostupnosť technika a zavolám vám do desiatich minút." };
  return { callId: "call-a", sourceRevision: 1, durationSeconds: 100, connected: [{ start: 0, end: 100 }], holds: [], gaps: [], transferCount: 0, language: "sk",
    subjects: [{ id: "operator-a", name: "Jana", identityVerified: true, openingComplete: true, conversationComplete: true, closingComplete: true }],
    spans: [system, { ...qualitySpan("customer-a", 2, 5, "customer"), text: "Auto mi nenaštartuje, som na parkovisku v Trnave." }, greeting, qualitySpan("discovery-a", 12, 18), { ...qualitySpan("location-a", 18, 24, "customer"), text: "Som na parkovisku pri stanici v Trnave." }, next, { ...qualitySpan("closing-a", 80, 85), text: "Ďakujem, dovidenia." }],
  };
}

export function modelCriteriaFixture(): ModelCriterion[] {
  return QUALITY_CRITERIA.map((criterion) => ({ id: criterion.id, verdict: "met", reason: "Správanie je doložené výrokom operátora.", spanIds: [criterion.id === "greeting" ? "greeting-a" : criterion.id === "closing" ? "closing-a" : "next-a"], absenceWindow: null, applicabilityReason: null, uncertaintyReason: null }));
}

export function qualityModelOutputFixture() {
  return { topic: "Pomoc s neštartujúcim autom", reason: "Zákazník chce sprevádzkovať auto.", summary: "Dispečer sľúbil overenie technika a spätný kontakt. Príchod ešte nebol potvrdený.", outcome: "next_step_agreed",
    facts: [{ label: "Lokalita", value: "Trnava", spanIds: ["location-a"] }], actions: [], nextSteps: [{ label: "Spätný kontakt", value: "Operátor zavolá do desiatich minút.", spanIds: ["next-a"] }],
    operators: [{ operatorId: "operator-a", criteria: modelCriteriaFixture(), coaching: [] as string[] }], warnings: [] as string[],
  };
}
