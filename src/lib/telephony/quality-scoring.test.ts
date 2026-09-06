import { describe, expect, it } from "vitest";
import { QUALITY_CRITERIA, type QualityCriterion, type QualityVerdict } from "./recording-quality";
import { communicationMetrics, intersectIntervals, intervalSeconds, scoreQuality, subtractIntervals, unionIntervals, validateOperatorEvaluation } from "./quality-scoring";
import { modelCriteriaFixture, qualitySourceFixture, qualitySpan } from "@/test/quality-source-fixture";

const full = { identityVerified: true, conversationComplete: true };
function criteria(verdict: QualityVerdict = "met"): QualityCriterion[] { return QUALITY_CRITERIA.map((item) => ({ id: item.id, verdict, reason: "Overené.", evidence: [], absenceWindow: null, applicabilityReason: verdict === "not_applicable" ? "Nevzťahuje sa na tento hovor." : null, uncertaintyReason: null })); }

describe("deterministic seven-criterion score", () => {
  it("uses weights totaling 100 and returns observed 100/0, never a default score", () => {
    expect(QUALITY_CRITERIA.reduce((sum, criterion) => sum + criterion.weight, 0)).toBe(100);
    expect(scoreQuality(criteria(), full)).toMatchObject({ score: 100, coverage: 1, reasons: [] });
    expect(scoreQuality(criteria("not_met"), full)).toMatchObject({ score: 0, coverage: 1 });
  });
  it("returns no score when everything is unknown or inapplicable", () => {
    expect(scoreQuality(criteria("unknown"), full)).toMatchObject({ score: null, coverage: 0 });
    expect(scoreQuality(criteria("not_applicable"), full)).toMatchObject({ score: null, coverage: 0 });
  });
  it("gives 88 for met60 + partial20 + unknown20 at exact 80 percent coverage", () => {
    const rows = criteria(); rows.find((c) => c.id === "greeting")!.verdict = "unknown"; rows.find((c) => c.id === "hold_transfer")!.verdict = "unknown"; rows.find((c) => c.id === "discovery")!.verdict = "partial";
    expect(scoreQuality(rows, full)).toMatchObject({ score: 88, coverage: 0.8, reasons: [] });
  });
  it("excludes unused hold from both weights without reward or penalty", () => {
    const rows = criteria(); rows.find((c) => c.id === "hold_transfer")!.verdict = "not_applicable";
    expect(scoreQuality(rows, full)).toMatchObject({ score: 100, coverage: 1 });
  });
  it("does not round 78.95 percent coverage up across the 80 percent gate", () => {
    const rows = criteria(); rows.find((c) => c.id === "closing")!.verdict = "not_applicable"; rows.find((c) => c.id === "greeting")!.verdict = "unknown"; rows.find((c) => c.id === "hold_transfer")!.verdict = "unknown";
    expect(scoreQuality(rows, full)).toMatchObject({ score: null }); expect(scoreQuality(rows, full).coverage).toBeCloseTo(75 / 95);
  });
  it("blocks a missing critical criterion even at 85 percent overall coverage", () => {
    const rows = criteria(); rows.find((c) => c.id === "understanding")!.verdict = "unknown";
    expect(scoreQuality(rows, full)).toMatchObject({ score: null, coverage: 0.85 });
  });
  it("blocks incomplete, duplicated and unattributed rubrics", () => {
    expect(scoreQuality(criteria().slice(1), full).score).toBeNull();
    const duplicate = criteria(); duplicate[6] = duplicate[0]; expect(scoreQuality(duplicate, full).score).toBeNull();
    expect(scoreQuality(criteria(), { ...full, identityVerified: false }).score).toBeNull();
    expect(scoreQuality(criteria(), { ...full, conversationComplete: false }).score).toBeNull();
  });
});

describe("interval communication metrics", () => {
  it("unions overlapping legs before intersecting and subtracting", () => {
    expect(unionIntervals([{ start: 0, end: 20 }, { start: 10, end: 30 }, { start: 30, end: 40 }, { start: -1, end: 2 }, { start: NaN, end: 8 }], 35)).toEqual([{ start: 0, end: 35 }]);
    expect(intersectIntervals([{ start: 0, end: 10 }], [{ start: 5, end: 20 }])).toEqual([{ start: 5, end: 10 }]);
    expect(subtractIntervals([{ start: 0, end: 20 }], [{ start: 5, end: 10 }, { start: 8, end: 15 }])).toEqual([{ start: 0, end: 5 }, { start: 15, end: 20 }]);
    expect(intervalSeconds([{ start: 0, end: 10 }, { start: 5, end: 20 }])).toBe(20);
  });
  it("excludes hold and gaps, unions same-role speech and reports overlap separately", () => {
    const source = qualitySourceFixture(); source.connected = [{ start: 0, end: 80 }, { start: 20, end: 100 }]; source.holds = [{ start: 20, end: 30 }, { start: 25, end: 35 }]; source.gaps = [{ start: 70, end: 80 }];
    source.spans = [qualitySpan("op1", 0, 10), qualitySpan("op2", 5, 15), qualitySpan("op-hold", 22, 28), qualitySpan("op-gap", 72, 76), qualitySpan("customer1", 10, 20, "customer"), qualitySpan("customer2", 35, 45, "customer"), qualitySpan("bot", 50, 60, "system"), { ...qualitySpan("unknown", 60, 65), identityVerified: false }];
    const result = communicationMetrics(source);
    expect(result).toMatchObject({ durationSeconds: 100, connectedSeconds: 100, holdSeconds: 15, operatorSpeechSeconds: 15, customerSpeechSeconds: 20, overlapSeconds: 5, silenceSeconds: 45, estimated: true });
    expect(result.operatorSpeechShare).toBeCloseTo(15 / 35);
  });
  it("does not assign invented speech shares when one side lacks verified identity", () => {
    const source = qualitySourceFixture(); source.spans = source.spans.map((span) => span.role === "customer" ? { ...span, identityVerified: false } : span);
    expect(communicationMetrics(source)).toMatchObject({ operatorSpeechSeconds: null, customerSpeechSeconds: null, operatorSpeechShare: null, overlapSeconds: null, silenceSeconds: null });
  });
  it("counts only pauses longer than five seconds within active conversation", () => {
    const source = qualitySourceFixture(); source.durationSeconds = 20; source.connected = [{ start: 0, end: 20 }]; source.spans = [qualitySpan("op", 0, 5), qualitySpan("customer", 10, 15, "customer")];
    expect(communicationMetrics(source).silenceSeconds).toBe(0);
  });
});

describe("operator attribution, applicability and evidence gates", () => {
  it("reconstructs citations from source, including deduplication", () => {
    const source = qualitySourceFixture(), rows = modelCriteriaFixture(); rows[0].spanIds = ["greeting-a", "greeting-a"];
    const result = validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source);
    expect(result.criteria[0].evidence).toHaveLength(1); expect(result.criteria[0].evidence[0].text).toBe(source.spans.find((span) => span.id === "greeting-a")!.text); expect(result.score).toBe(100);
  });
  it.each(["system", "customer-a", "missing"])("does not credit %s as the operator greeting", (spanId) => {
    const source = qualitySourceFixture(), rows = modelCriteriaFixture(); rows[0].spanIds = [spanId];
    expect(validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source).criteria[0].verdict).toBe("unknown");
  });
  it("rejects another operator's quotation and an invented subject", () => {
    const source = qualitySourceFixture(), rows = modelCriteriaFixture(); source.spans.push(qualitySpan("other", 50, 55, "operator", "operator-b")); rows[0].spanIds = ["other"];
    const result = validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source); expect(result.criteria[0]).toMatchObject({ verdict: "unknown", evidence: [] });
    expect(() => validateOperatorEvaluation({ operatorId: "invented", criteria: rows, coaching: [] }, source)).toThrow("quality_unknown_subject");
  });
  it("allows a negative greeting only with its complete absence window", () => {
    const source = qualitySourceFixture(), rows = modelCriteriaFixture(); rows[0] = { ...rows[0], verdict: "not_met", spanIds: [], absenceWindow: "opening" };
    expect(validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source).criteria[0].verdict).toBe("not_met");
    source.subjects[0].openingComplete = false;
    expect(validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source).criteria[0].verdict).toBe("unknown");
  });
  it("does not use unrelated own midcall text to prove a missing opening", () => {
    const source = qualitySourceFixture(), rows = modelCriteriaFixture(); source.subjects[0].openingComplete = false; source.subjects[0].conversationComplete = false; rows[0] = { ...rows[0], verdict: "not_met", spanIds: ["next-a"], absenceWindow: "opening" };
    expect(validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source).criteria[0].verdict).toBe("unknown");
  });
  it("does not use own midcall text to prove an absent closing outside the captured window", () => {
    const source = qualitySourceFixture(), rows = modelCriteriaFixture(); source.subjects[0].closingComplete = false; source.subjects[0].conversationComplete = false; rows[6] = { ...rows[6], verdict: "not_met", spanIds: ["next-a"], absenceWindow: "closing" };
    expect(validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source).criteria[6].verdict).toBe("unknown");
  });
  it("can acknowledge an observed greeting in a fragment while keeping the numeric score unavailable", () => {
    const source = qualitySourceFixture(); source.subjects[0].openingComplete = false; source.subjects[0].conversationComplete = false;
    const result = validateOperatorEvaluation({ operatorId: "operator-a", criteria: modelCriteriaFixture(), coaching: [] }, source);
    expect(result.criteria[0].verdict).toBe("met"); expect(result.score).toBeNull();
  });
  it("keeps unused hold NA only for a complete conversation with a reason", () => {
    const source = qualitySourceFixture(), rows = modelCriteriaFixture(); rows[5] = { ...rows[5], verdict: "not_applicable", spanIds: [], applicabilityReason: "V celom rozhovore sa nepoužilo podržanie ani odovzdanie." };
    expect(validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source).criteria[5].verdict).toBe("not_applicable");
    source.subjects[0].conversationComplete = false; expect(validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source).criteria[5].verdict).toBe("unknown");
    source.subjects[0].conversationComplete = true; rows[5].applicabilityReason = ""; expect(validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source).criteria[5].verdict).toBe("unknown");
  });
  it("keeps well-supported applicability independent from personal identity, while score stays null", () => {
    const source = qualitySourceFixture(), rows = modelCriteriaFixture(); source.subjects[0].identityVerified = false; rows[5] = { ...rows[5], verdict: "not_applicable", spanIds: [], applicabilityReason: "Úplný rozhovor bez podržania." };
    const result = validateOperatorEvaluation({ operatorId: "operator-a", criteria: rows, coaching: [] }, source); expect(result.criteria[5].verdict).toBe("not_applicable"); expect(result.criteria[0].verdict).toBe("unknown"); expect(result.score).toBeNull();
  });
  it.each([{ start: -1, end: 8 }, { start: NaN, end: 8 }, { start: 8, end: 5 }, { start: 5, end: Infinity }, { start: 5, end: 101 }])("malformed source timing %j cannot become evaluable evidence", ({ start, end }) => {
    const source = qualitySourceFixture(); const span = source.spans.find((item) => item.id === "greeting-a")!; span.startSeconds = start; span.endSeconds = end;
    try { const result = validateOperatorEvaluation({ operatorId: "operator-a", criteria: modelCriteriaFixture(), coaching: [] }, source); expect(result.score).toBeNull(); expect(result.criteria[0].evidence).toEqual([]); }
    catch (error) { if (error instanceof Error && error.name === "AssertionError") throw error; expect(error).toBeInstanceOf(Error); }
  });
  it("duplicate source IDs cannot silently replace a citation", () => {
    const source = qualitySourceFixture(); source.spans.push({ ...source.spans.find((span) => span.id === "greeting-a")!, text: "Pozmenený druhý výrok s rovnakým ID." });
    try { const result = validateOperatorEvaluation({ operatorId: "operator-a", criteria: modelCriteriaFixture(), coaching: [] }, source); expect(result.score).toBeNull(); expect(result.criteria[0].evidence).toEqual([]); }
    catch (error) { if (error instanceof Error && error.name === "AssertionError") throw error; expect(error).toBeInstanceOf(Error); }
  });
});
