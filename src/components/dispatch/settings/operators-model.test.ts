import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_OPERATOR_SETTINGS, validateOperatorSettingsPatch } from "@/server/telephony/config-service";
import type { LineDoc, OperatorDoc, ValidationContext } from "@/server/telephony/config-service";

import {
  AUTO_ANSWER_PENDING_NOTE,
  RING_VOLUME_PENDING_NOTE,
  ROLE_LABELS,
  confirmDisconnectDevice,
  confirmRotateCredential,
  confirmTakeover,
  activeLines,
  describeCallHandling,
  describeDevice,
  describeLineOption,
  describeOutboundLine,
  describeSeenAt,
  dirtyOperatorIds,
  findLine,
  findOperator,
  operatorDirty,
  operatorDraft,
  operatorDraftsFromDocument,
  operatorPatch,
  updateOperator,
  validateOperatorDraft,
  validateOperatorDrafts,
  type OperatorValidationContext,
} from "./operators-model";

const NOW = new Date("2026-09-03T10:00:00.000Z");

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
    displayName: "Jana Nováková",
    role: "dispatcher",
    active: true,
    settings: {
      defaultFromLineId: "line-1",
      wrapUpSeconds: 30,
      autoAnswerOutbound: true,
      ringDeviceVolume: 80,
      defaultMobileNumber: null,
      pauseRoutingMode: "none",
      pauseForwardProfileId: null,
      pauseForwardNumber: null,
    },
    device: {
      environment: "production",
      credentialId: "cred-1",
      sipUsername: "pm-prod-abc",
      registrationState: "registered",
      deviceSeenAt: new Date(NOW.getTime() - 10_000).toISOString(),
    },
    ...overrides,
  };
}

const CONTEXT: OperatorValidationContext = { lines: [line()] };

describe("drafting", () => {
  it("falls back to the server defaults for an operator with no settings row", () => {
    const draft = operatorDraft(operator({ settings: null }));

    expect(draft).toMatchObject({
      profileId: "profile-1",
      defaultFromLineId: DEFAULT_OPERATOR_SETTINGS.defaultFromLineId,
      wrapUpSeconds: DEFAULT_OPERATOR_SETTINGS.wrapUpSeconds,
      autoAnswerOutbound: DEFAULT_OPERATOR_SETTINGS.autoAnswerOutbound,
      ringDeviceVolume: DEFAULT_OPERATOR_SETTINGS.ringDeviceVolume,
    });
  });

  it("sorts operators by name and keeps the profile id as the key", () => {
    const drafts = operatorDraftsFromDocument([
      operator({ profileId: "b", displayName: "Zuzana" }),
      operator({ profileId: "a", displayName: "Adam" }),
    ]);

    expect(drafts.map((draft) => draft.profileId)).toEqual(["a", "b"]);
  });

  it("updates one operator only", () => {
    const drafts = operatorDraftsFromDocument([operator({ profileId: "a", displayName: "Adam" }), operator({ profileId: "b", displayName: "Boris" })]);
    const next = updateOperator(drafts, "b", { wrapUpSeconds: 60 });

    expect(next.find((draft) => draft.profileId === "a")?.wrapUpSeconds).toBe(30);
    expect(next.find((draft) => draft.profileId === "b")?.wrapUpSeconds).toBe(60);
  });

  it("finds an operator by profile id", () => {
    expect(findOperator([operator()], "profile-1")?.displayName).toBe("Jana Nováková");
    expect(findOperator([operator()], "nope")).toBeNull();
  });
});

describe("operatorPatch", () => {
  it("is empty when nothing changed", () => {
    const original = operator();
    expect(operatorPatch(operatorDraft(original), original)).toEqual({});
    expect(operatorDirty(operatorDraft(original), original)).toBe(false);
  });

  it("is empty for an operator without a settings row that nobody touched", () => {
    const original = operator({ settings: null });
    expect(operatorPatch(operatorDraft(original), original)).toEqual({});
  });

  it("carries only the changed fields, including clearing the line", () => {
    const original = operator();
    const draft = { ...operatorDraft(original), defaultFromLineId: null, wrapUpSeconds: 45 };

    expect(operatorPatch(draft, original)).toEqual({ defaultFromLineId: null, wrapUpSeconds: 45 });
    expect(operatorDirty(draft, original)).toBe(true);
  });

  it("lists the operators with unsaved changes", () => {
    const operators = [operator({ profileId: "a", displayName: "Adam" }), operator({ profileId: "b", displayName: "Boris" })];
    const drafts = updateOperator(operatorDraftsFromDocument(operators), "b", { autoAnswerOutbound: false });

    expect(dirtyOperatorIds(drafts, operators)).toEqual(["b"]);
  });
});

describe("validation mirror", () => {
  function serverContext(): ValidationContext {
    return {
      organizationId: "org-1",
      profileIds: new Set(["profile-1"]),
      lineIds: new Set(["line-1"]),
      ivrMenuIds: new Set(),
      businessHoursIds: new Set(),
      ringPlanIds: new Set(),
      businessHoursInUse: new Set(),
      ivrMenusInUse: new Set(),
      ringPlansInUse: new Set(),
      destinationAllowlist: ["SK"],
      groups: [],
      plans: [],
    };
  }

  it("accepts a sane draft", () => {
    expect(validateOperatorDraft(operatorDraft(operator()), CONTEXT)).toEqual([]);
    expect(validateOperatorDrafts([operatorDraft(operator())], CONTEXT)).toEqual([]);
  });

  it("produces the same codes as the server for wrap-up, volume and a foreign line", () => {
    const draft = { ...operatorDraft(operator()), wrapUpSeconds: 9_999, ringDeviceVolume: 200, defaultFromLineId: "line-other" };
    const local = validateOperatorDraft(draft, CONTEXT).map((entry) => entry.code);
    const server = validateOperatorSettingsPatch(
      { wrapUpSeconds: 9_999, ringDeviceVolume: 200, defaultFromLineId: "line-other" },
      serverContext(),
    ).map((entry) => entry.code);

    expect(local).toEqual(server);
    expect(local).toEqual(["wrap_up_invalid", "volume_invalid", "line_foreign"]);
  });

  it("allows zero wrap-up and refuses a fractional one", () => {
    expect(validateOperatorDraft({ ...operatorDraft(operator()), wrapUpSeconds: 0 }, CONTEXT)).toEqual([]);
    expect(validateOperatorDraft({ ...operatorDraft(operator()), wrapUpSeconds: 12.5 }, CONTEXT).map((entry) => entry.code)).toEqual(["wrap_up_invalid"]);
  });

  it("does not complain about a cleared line", () => {
    expect(validateOperatorDraft({ ...operatorDraft(operator()), defaultFromLineId: null }, CONTEXT)).toEqual([]);
  });
});

describe("describeDevice", () => {
  it("reports an operator who never opened the phone", () => {
    const view = describeDevice(operator({ device: null }), NOW);

    expect(view).toMatchObject({ tone: "off", label: "Bez telefónu", live: false, provisioned: false });
  });

  it("reports a fresh registration as connected", () => {
    const view = describeDevice(operator(), NOW);

    expect(view).toMatchObject({ tone: "ok", label: "Pripojený", live: true, provisioned: true });
    expect(view.detail).toContain("pred 10 s");
    expect(view.detail).toContain("pm-prod-abc");
  });

  it("calls out a phone that claims to be registered but stopped sending heartbeats", () => {
    const stale = operator({
      device: { environment: "production", credentialId: "cred-1", sipUsername: "pm-prod-abc", registrationState: "registered", deviceSeenAt: new Date(NOW.getTime() - 300_000).toISOString() },
    });
    const view = describeDevice(stale, NOW);

    expect(view).toMatchObject({ tone: "warn", label: "Neozýva sa", live: false });
    expect(view.detail).toContain("nezazvoní");
  });

  it("reports an explicitly unregistered phone without alarm", () => {
    const view = describeDevice(
      operator({ device: { environment: "development", credentialId: "cred-1", sipUsername: "pm-dev-abc", registrationState: "unregistered", deviceSeenAt: null } }),
      NOW,
    );

    expect(view).toMatchObject({ tone: "off", label: "Odpojený", live: false, provisioned: true });
    expect(view.detail).toContain("nikdy");
    expect(view.detail).toContain("test / vývoj");
  });
});

describe("describeSeenAt", () => {
  it("counts seconds, minutes and hours", () => {
    expect(describeSeenAt(new Date(NOW.getTime() - 5_000).toISOString(), NOW)).toBe("pred 5 s");
    expect(describeSeenAt(new Date(NOW.getTime() - 300_000).toISOString(), NOW)).toBe("pred 5 min");
    expect(describeSeenAt(new Date(NOW.getTime() - 7_200_000).toISOString(), NOW)).toBe("pred 2 h");
  });

  it("says nikdy for a missing or unparsable timestamp", () => {
    expect(describeSeenAt(null, NOW)).toBe("nikdy");
    expect(describeSeenAt("not-a-date", NOW)).toBe("nikdy");
  });
});

describe("outbound line", () => {
  it("keeps only the active lines for the picker", () => {
    expect(activeLines([line(), line({ id: "line-2", active: false })]).map((entry) => entry.id)).toEqual(["line-1"]);
  });

  it("finds a line and tolerates an empty choice", () => {
    expect(findLine([line()], "line-1")?.label).toBe("Hlavná linka");
    expect(findLine([line()], null)).toBeNull();
    expect(findLine([line()], "missing")).toBeNull();
  });

  it("labels a line with its number and marks an inactive one", () => {
    expect(describeLineOption(line())).toContain("Hlavná linka");
    expect(describeLineOption(line({ active: false }))).toContain("(vypnutá)");
  });

  it("explains the fallback to the system number", () => {
    const draft = { ...operatorDraft(operator()), defaultFromLineId: null };
    expect(describeOutboundLine(draft, [line()])).toContain("systémového čísla");
  });

  it("warns that an inactive default line falls back too", () => {
    const draft = operatorDraft(operator());
    expect(describeOutboundLine(draft, [line({ active: false })])).toContain("vypnutá");
  });

  it("names the number the customer will see", () => {
    expect(describeOutboundLine(operatorDraft(operator()), [line()])).toContain("Hlavná linka");
  });
});

describe("describeCallHandling", () => {
  it("describes zero wrap-up and the auto-answer choice", () => {
    expect(describeCallHandling({ ...operatorDraft(operator()), wrapUpSeconds: 0 })).toContain("hneď zase dostupný");
    expect(describeCallHandling(operatorDraft(operator()))).toContain("30 s");
    expect(describeCallHandling({ ...operatorDraft(operator()), autoAnswerOutbound: false })).toContain("prijať sám");
  });

  it("keeps the honest note about the switch that is not wired to the phone yet", () => {
    expect(AUTO_ANSWER_PENDING_NOTE).toContain("zatiaľ hovor neovplyvní");
  });
});

describe("ROLE_LABELS", () => {
  it("covers every role", () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual(["admin", "dispatcher", "manager", "senior_dispatcher"]);
  });
});

describe("honesty of the panel's wording", () => {
  it("keeps the server module out of the browser bundle graph", () => {
    // Every value this model needs lives in `src/lib/telephony`; only *types*
    // come from `config-service.ts`, which pulls in `node:crypto` and the
    // Supabase client. A value import would put that file in the client graph
    // for the default "Môj telefón"/"Operátori" tabs.
    const source = readFileSync(new URL("./operators-model.ts", import.meta.url), "utf8");
    const configImports = [...source.matchAll(/^import (type )?\{[\s\S]*?\} from "@\/server\/telephony\/config-service";$/gm)];
    expect(configImports).toHaveLength(1);
    expect(configImports[0][1]).toBe("type ");
    expect(DEFAULT_OPERATOR_SETTINGS).toEqual({
      defaultFromLineId: null,
      wrapUpSeconds: 30,
      autoAnswerOutbound: true,
      ringDeviceVolume: 80,
      defaultMobileNumber: null,
      pauseRoutingMode: "none",
      pauseForwardProfileId: null,
      pauseForwardNumber: null,
    });
  });

  it("says that the ring volume is stored but not used yet", () => {
    expect(RING_VOLUME_PENDING_NOTE).toContain("zatiaľ nepoužíva");
  });

  it("tells the manager that a device action ends a call in progress and revokes the SIP identity", () => {
    // Both actions revoke `device_session_id`; the tab disconnects its WebRTC
    // client at the next heartbeat and the live leg goes with it. Both also
    // delete a credential at Telnyx, which is the half that a tab ignoring the
    // heartbeat cannot survive — the promise of "odpojiť" depends on it.
    expect(confirmRotateCredential("Peter")).toContain("hovor sa preruší");
    expect(confirmRotateCredential("Peter")).toContain("zrušia aj u operátora");
    expect(confirmDisconnectDevice("Peter")).toContain("hovor sa preruší");
    expect(confirmDisconnectDevice("Peter")).toContain("zrušia aj u operátora");
    expect(confirmTakeover("Peter", "Operátor má práve hovor.")).toContain("ukončiť mu prebiehajúci hovor");
  });
});
