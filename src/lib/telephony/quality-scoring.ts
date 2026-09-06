import {
  QUALITY_CRITERIA, QUALITY_RUBRIC_VERSION,
  type CallCommunicationMetrics, type OperatorQualityEvaluation, type QualityCriterion,
  type QualityCriterionId, type QualityEvidence, type QualityVerdict, type RecordingTranscriptSpan,
} from "./recording-quality";

export type TimeInterval = { start: number; end: number };
export type QualitySubject = {
  id: string;
  name: string;
  identityVerified: boolean;
  openingComplete: boolean;
  conversationComplete: boolean;
  closingComplete: boolean;
};
export type QualitySource = {
  callId: string;
  sourceRevision: number;
  spans: RecordingTranscriptSpan[];
  subjects: QualitySubject[];
  durationSeconds: number;
  connected: TimeInterval[];
  holds: TimeInterval[];
  gaps: TimeInterval[];
  transferCount: number;
  language: string | null;
};
export type ModelCriterion = {
  id: QualityCriterionId;
  verdict: QualityVerdict;
  reason: string;
  spanIds: string[];
  absenceWindow: "opening" | "conversation" | "closing" | null;
  applicabilityReason: string | null;
  uncertaintyReason: string | null;
};

export function unionIntervals(input: TimeInterval[], limit = Number.POSITIVE_INFINITY): TimeInterval[] {
  const intervals = input.filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.start >= 0 && x.end > x.start)
    .map((x) => ({ start: Math.min(x.start, limit), end: Math.min(x.end, limit) }))
    .filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: TimeInterval[] = [];
  for (const interval of intervals) {
    const last = out.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else out.push({ ...interval });
  }
  return out;
}
export function intervalSeconds(intervals: TimeInterval[]): number {
  return unionIntervals(intervals).reduce((sum, x) => sum + x.end - x.start, 0);
}
export function intersectIntervals(a: TimeInterval[], b: TimeInterval[]): TimeInterval[] {
  const out: TimeInterval[] = [];
  for (const x of unionIntervals(a)) for (const y of unionIntervals(b)) {
    const start = Math.max(x.start, y.start), end = Math.min(x.end, y.end);
    if (end > start) out.push({ start, end });
  }
  return unionIntervals(out);
}
export function subtractIntervals(input: TimeInterval[], removed: TimeInterval[]): TimeInterval[] {
  let out = unionIntervals(input);
  for (const cut of unionIntervals(removed)) {
    out = out.flatMap((x) => {
      if (cut.end <= x.start || cut.start >= x.end) return [x];
      return [...(cut.start > x.start ? [{ start: x.start, end: cut.start }] : []), ...(cut.end < x.end ? [{ start: cut.end, end: x.end }] : [])];
    });
  }
  return out;
}

export function communicationMetrics(source: QualitySource): CallCommunicationMetrics {
  const connected = unionIntervals(source.connected, source.durationSeconds);
  const holds = intersectIntervals(unionIntervals(source.holds, source.durationSeconds), connected);
  const active = subtractIntervals(connected, [...holds, ...source.gaps]);
  const verified = source.spans.filter((span) => span.identityVerified && (span.role === "operator" || span.role === "customer"));
  const speech = (role: "operator" | "customer") => intersectIntervals(verified.filter((x) => x.role === role).map((x) => ({ start: x.startSeconds, end: x.endSeconds })), active);
  const operators = speech("operator"), customers = speech("customer");
  const identified = operators.length > 0 && customers.length > 0;
  const operatorSeconds = intervalSeconds(operators), customerSeconds = intervalSeconds(customers);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    durationSeconds: round(Math.max(0, source.durationSeconds)), connectedSeconds: round(intervalSeconds(connected)),
    holdSeconds: round(intervalSeconds(holds)), transferCount: source.transferCount,
    operatorSpeechSeconds: identified ? round(operatorSeconds) : null,
    customerSpeechSeconds: identified ? round(customerSeconds) : null,
    overlapSeconds: identified ? round(intervalSeconds(intersectIntervals(operators, customers))) : null,
    silenceSeconds: identified ? round(intervalSeconds(subtractIntervals(active, [...operators, ...customers]).filter((x) => x.end - x.start > 5))) : null,
    operatorSpeechShare: identified && operatorSeconds + customerSeconds > 0 ? operatorSeconds / (operatorSeconds + customerSeconds) : null,
    estimated: true,
  };
}

export function evidenceFromSpan(span: RecordingTranscriptSpan): QualityEvidence {
  return { id: span.id, segmentId: span.segmentId, startSeconds: span.startSeconds, endSeconds: span.endSeconds, text: span.text, speakerLabel: span.speakerLabel, operatorId: span.operatorId };
}

export function scoreQuality(criteria: QualityCriterion[], gates: { identityVerified: boolean; conversationComplete: boolean }): { score: number | null; coverage: number; reasons: string[] } {
  const byId = new Map(criteria.map((c) => [c.id, c]));
  let applicable = 0, evaluable = 0, weighted = 0;
  const reasons: string[] = [];
  if (byId.size !== QUALITY_CRITERIA.length || criteria.length !== QUALITY_CRITERIA.length) reasons.push("Neúplná rubrika.");
  for (const definition of QUALITY_CRITERIA) {
    const criterion = byId.get(definition.id);
    if (criterion?.verdict === "not_applicable") continue;
    applicable += definition.weight;
    if (criterion && ["met", "partial", "not_met"].includes(criterion.verdict)) {
      evaluable += definition.weight;
      weighted += definition.weight * (criterion.verdict === "met" ? 1 : criterion.verdict === "partial" ? 0.5 : 0);
    } else if (definition.critical) reasons.push(`Chýbajú podklady: ${definition.label.toLowerCase()}.`);
  }
  const coverage = applicable > 0 ? evaluable / applicable : 0;
  if (!gates.identityVerified) reasons.push("Identita operátora nie je spoľahlivo overená.");
  if (!gates.conversationComplete) reasons.push("Relevantný rozhovor nie je zachytený celý.");
  if (coverage < 0.8) reasons.push("Pokrytie hodnotiteľných kritérií je menšie než 80 %.");
  if (evaluable === 0) reasons.push("Nie sú dostupné hodnotiteľné kritériá.");
  return { score: reasons.length === 0 ? Math.round(100 * weighted / evaluable) : null, coverage, reasons };
}

/** All citations are reconstructed from immutable source IDs, never model quotes. */
export function validateOperatorEvaluation(
  raw: { operatorId: string; criteria: ModelCriterion[]; coaching: string[] }, source: QualitySource,
): OperatorQualityEvaluation {
  const subject = source.subjects.find((s) => s.id === raw.operatorId);
  if (!subject) throw new Error("quality_unknown_subject");
  const spans = new Map(source.spans.map((s) => [s.id, s]));
  if (spans.size !== source.spans.length || source.spans.some((s) => !s.id || !Number.isFinite(s.startSeconds) || !Number.isFinite(s.endSeconds) || s.startSeconds < 0 || s.endSeconds <= s.startSeconds || s.endSeconds > source.durationSeconds)) throw new Error("quality_invalid_source");
  const byId = new Map(raw.criteria.map((c) => [c.id, c]));
  if (byId.size !== QUALITY_CRITERIA.length || raw.criteria.length !== QUALITY_CRITERIA.length) throw new Error("quality_invalid_criteria");
  const criteria: QualityCriterion[] = QUALITY_CRITERIA.map((definition) => {
    const item = byId.get(definition.id);
    if (!item) throw new Error("quality_missing_criterion");
    const cited = [...new Set(item.spanIds)].map((id) => spans.get(id));
    const invalidEvidence = cited.some((span) => !span || span.role === "system" || (span.operatorId !== null && span.operatorId !== subject.id));
    const evidence = cited.filter((span): span is RecordingTranscriptSpan => Boolean(span));
    const ownsEvidence = evidence.some((span) => span.role === "operator" && span.identityVerified && span.operatorId === subject.id);
    const windowComplete = item.absenceWindow === "opening" ? subject.openingComplete : item.absenceWindow === "closing" ? subject.closingComplete : item.absenceWindow === "conversation" ? subject.conversationComplete : false;
    let uncertainty = item.uncertaintyReason;
    let verdict = item.verdict;
    if (invalidEvidence || !subject.identityVerified && verdict !== "not_applicable") uncertainty = "Dôkaz alebo identita účastníka nie sú overené.";
    else if (verdict === "not_met" && definition.id === "greeting" && !subject.openingComplete || verdict === "not_met" && definition.id === "closing" && !subject.closingComplete) uncertainty = "Relevantný začiatok alebo koniec rozhovoru nie je zachytený celý.";
    else if ((verdict === "met" || verdict === "partial") && !ownsEvidence) uncertainty = "Chýba výrok hodnoteného operátora.";
    else if (verdict === "not_met" && !ownsEvidence && !windowComplete) uncertainty = "Chýbajúci prejav nemožno potvrdiť z neúplného časového okna.";
    else if (verdict === "not_applicable" && !item.applicabilityReason?.trim()) uncertainty = "Nie je doložená neaplikovateľnosť kritéria.";
    else if (definition.id === "hold_transfer" && verdict === "not_applicable" && !subject.conversationComplete) uncertainty = "Z neúplného rozhovoru nemožno vylúčiť podržanie alebo odovzdanie.";
    if (uncertainty) verdict = "unknown";
    return { id: definition.id, verdict, reason: item.reason, evidence: invalidEvidence ? [] : evidence.map(evidenceFromSpan), absenceWindow: item.absenceWindow, applicabilityReason: item.applicabilityReason, uncertaintyReason: uncertainty };
  });
  const score = scoreQuality(criteria, subject);
  return { operatorId: subject.id, operatorName: subject.name, rubricVersion: QUALITY_RUBRIC_VERSION, criteria, score: score.score, coverage: score.coverage, eligibilityReasons: score.reasons, coaching: raw.coaching, review: null };
}
