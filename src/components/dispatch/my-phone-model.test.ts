import { describe, expect, it } from "vitest";

import type { LineDoc, OperatorDoc, PauseReasonDoc } from "@/server/telephony/config-service";

import {
  PRESENCE_LABELS,
  activePauseReasons,
  canChangePresence,
  canEndWrapUp,
  checkTestCallNumber,
  confirmTestCall,
  describePauseReason,
  describePresence,
  describeWrapUp,
  presenceLabel,
  presenceTone,
  testCallTarget,
  wrapUpRemainingSeconds,
  type MyPresence,
} from "./my-phone-model";

const NOW = new Date("2026-09-03T10:00:00.000Z");

function presence(overrides: Partial<MyPresence> = {}): MyPresence {
  return {
    profileId: "profile-1",
    status: "available",
    pauseReasonId: null,
    currentSessionId: null,
    wrapUpUntil: null,
    statusSince: NOW.toISOString(),
    ...overrides,
  };
}

function line(overrides: Partial<LineDoc> = {}): LineDoc {
  return {
    id: "line-1",
    phoneNumber: "+421232408718",
    label: "Hlavná linka",
    partnerName: null,
    telnyxNumberId: "tn-1",
    ringPlanId: "plan-1",
    ivrMenuId: null,
    businessHoursId: null,
    environment: "production",
    active: true,
    ...overrides,
  };
}

function operator(overrides: Partial<OperatorDoc> = {}): OperatorDoc {
  return {
    profileId: "profile-1",
    displayName: "Jana",
    role: "dispatcher",
    active: true,
    settings: { defaultFromLineId: "line-1", wrapUpSeconds: 30, autoAnswerOutbound: true, ringDeviceVolume: 80 },
    device: null,
    ...overrides,
  };
}

function reason(overrides: Partial<PauseReasonDoc> = {}): PauseReasonDoc {
  return { id: "reason-1", code: "obed", label: "Obed", maxMinutes: 30, sortOrder: 1, active: true, ...overrides };
}

describe("presence vocabulary", () => {
  it("labels every status and falls back for an unknown one", () => {
    expect(Object.keys(PRESENCE_LABELS)).toHaveLength(6);
    expect(presenceLabel("after_call_work")).toBe("Dopisuje");
    expect(presenceLabel(null)).toBe("Neznámy stav");
  });

  it("tones available as success, a pause as a warning and a call as info", () => {
    expect(presenceTone("available")).toBe("success");
    expect(presenceTone("paused")).toBe("warning");
    expect(presenceTone("after_call_work")).toBe("warning");
    expect(presenceTone("on_call")).toBe("info");
    expect(presenceTone("offline")).toBe("neutral");
    expect(presenceTone(null)).toBe("neutral");
  });
});

describe("wrap-up", () => {
  it("counts the seconds left", () => {
    const row = presence({ status: "after_call_work", wrapUpUntil: new Date(NOW.getTime() + 25_000).toISOString() });

    expect(wrapUpRemainingSeconds(row, NOW)).toBe(25);
    expect(describeWrapUp(row, NOW)).toContain("00:25");
    expect(canEndWrapUp(row)).toBe(true);
  });

  it("reports an expired wrap-up as over instead of a stuck timer", () => {
    const row = presence({ status: "after_call_work", wrapUpUntil: new Date(NOW.getTime() - 5_000).toISOString() });

    expect(wrapUpRemainingSeconds(row, NOW)).toBe(0);
    expect(describeWrapUp(row, NOW)).toContain("vypršal");
  });

  it("is silent in any other status", () => {
    expect(wrapUpRemainingSeconds(presence(), NOW)).toBe(0);
    expect(describeWrapUp(presence(), NOW)).toBeNull();
    expect(canEndWrapUp(presence())).toBe(false);
    expect(canEndWrapUp(null)).toBe(false);
    expect(wrapUpRemainingSeconds(null, NOW)).toBe(0);
  });

  it("survives a wrap-up row without a deadline", () => {
    expect(wrapUpRemainingSeconds(presence({ status: "after_call_work" }), NOW)).toBe(0);
  });
});

describe("canChangePresence", () => {
  it("mirrors setPresence: refused only during a call with a live session", () => {
    expect(canChangePresence(presence())).toBe(true);
    expect(canChangePresence(presence({ status: "ringing", currentSessionId: "session-1" }))).toBe(true);
    expect(canChangePresence(presence({ status: "on_call", currentSessionId: "session-1" }))).toBe(false);
    expect(canChangePresence(presence({ status: "on_call", currentSessionId: null }))).toBe(true);
    expect(canChangePresence(null)).toBe(true);
  });
});

describe("describePresence", () => {
  it("names the pause reason when there is one", () => {
    expect(describePresence(presence({ status: "paused", pauseReasonId: "reason-1" }), [reason()])).toContain("Obed");
    expect(describePresence(presence({ status: "paused", pauseReasonId: null }), [reason()])).toContain("pauzu");
  });

  it("says a call blocks the change", () => {
    expect(describePresence(presence({ status: "on_call", currentSessionId: "s" }), [])).toContain("až po jeho skončení");
  });

  it("covers the remaining statuses", () => {
    expect(describePresence(presence(), [])).toContain("dostupný");
    expect(describePresence(presence({ status: "ringing" }), [])).toContain("zvoní");
    expect(describePresence(presence({ status: "after_call_work" }), [])).toContain("Dopisuješ");
    expect(describePresence(presence({ status: "offline" }), [])).toContain("odhlásený");
    expect(describePresence(null, [])).toContain("nenačítala");
  });
});

describe("pause reasons", () => {
  it("keeps the active ones in their sort order", () => {
    const reasons = [
      reason({ id: "b", label: "Porada", sortOrder: 2 }),
      reason({ id: "a", label: "Obed", sortOrder: 1 }),
      reason({ id: "c", label: "Zrušené", sortOrder: 0, active: false }),
    ];

    expect(activePauseReasons(reasons).map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("shows the time limit when the reason has one", () => {
    expect(describePauseReason(reason())).toBe("Obed (max 30 min)");
    expect(describePauseReason(reason({ maxMinutes: null }))).toBe("Obed");
  });
});

describe("testCallTarget", () => {
  it("prefills the operator's own active line", () => {
    const target = testCallTarget({ lines: [line()], operators: [operator()] }, "profile-1");

    expect(target.line?.id).toBe("line-1");
    expect(target.number).toBe("+421232408718");
    expect(target.note).toContain("Hlavná linka");
  });

  it("warns that an inactive default line falls back to the system number", () => {
    const target = testCallTarget({ lines: [line({ active: false })], operators: [operator()] }, "profile-1");

    expect(target.line).toBeNull();
    expect(target.number).toBe("+421232408718");
    expect(target.note).toContain("vypnutá");
  });

  it("has no prefill without a default line or without a known profile", () => {
    expect(testCallTarget({ lines: [line()], operators: [operator({ settings: null })] }, "profile-1").number).toBe("");
    expect(testCallTarget({ lines: [line()], operators: [operator()] }, null).number).toBe("");
  });
});

describe("checkTestCallNumber", () => {
  const lines = [line()];

  it("normalises a national number and accepts an allowlisted destination", () => {
    expect(checkTestCallNumber("0900 123 456", { allowlist: ["SK"], lines })).toMatchObject({ number: "+421900123456", error: null, warning: null });
  });

  it("refuses an empty or malformed number", () => {
    expect(checkTestCallNumber("   ", { allowlist: ["SK"], lines }).error).toContain("Zadaj číslo");
    expect(checkTestCallNumber("12", { allowlist: ["SK"], lines }).error).toBe("Neplatné telefónne číslo.");
  });

  it("refuses a destination outside the allowlist", () => {
    expect(checkTestCallNumber("+12125550123", { allowlist: ["SK", "CZ"], lines }).error).toContain("povolených destináciách");
  });

  it("leaves the allowlist to the server when the reader cannot see it", () => {
    expect(checkTestCallNumber("+12125550123", { allowlist: null, lines })).toMatchObject({ number: "+12125550123", error: null });
  });

  it("warns when the number is one of our own lines", () => {
    const check = checkTestCallNumber("+421232408718", { allowlist: ["SK"], lines });

    expect(check.number).toBe("+421232408718");
    expect(check.warning).toContain("plánom zvonenia");
  });
});

describe("confirmTestCall", () => {
  it("always says the call is real and appends the ring-plan warning", () => {
    expect(confirmTestCall("+421900123456", null)).toContain("spoplatnený");
    expect(confirmTestCall("+421232408718", "pozor")).toContain("pozor");
  });
});
