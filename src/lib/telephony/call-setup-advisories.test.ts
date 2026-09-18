import { describe, expect, it } from "vitest";

import { callSetupAdvisories, type CallSetupInput } from "./call-setup-advisories";

const operator = (profileId: string) => ({ memberKind: "operator", profileId, externalNumber: null });
const number = (externalNumber: string) => ({ memberKind: "external_number", profileId: null, externalNumber });

function setup(overrides: Partial<CallSetupInput> = {}): CallSetupInput {
  return {
    groups: [{ id: "g1", name: "Denná", active: true, members: [operator("p1"), operator("p2")] }],
    plans: [{ name: "Hlavný", active: true, steps: [{ ringGroupId: "g1", strategy: "all" }] }],
    operators: [{ displayName: "Jana", active: true, settings: { deliveryMode: "web", defaultMobileNumber: null } }],
    parkMaxMinutes: 30,
    maxRingFanout: 3,
    ...overrides,
  };
}

const titles = (input: CallSetupInput) => callSetupAdvisories(input).map((advisory) => advisory.title);

describe("callSetupAdvisories", () => {
  it("says plainly when a call will ring nobody", () => {
    expect(titles(setup({ plans: [] }))).toEqual(["Žiadny aktívny plán zvonenia"]);
    expect(titles(setup({ groups: [{ id: "g1", name: "Denná", active: true, members: [] }] })))
      .toContain("Plán zvonenia nemá koho volať");
  });

  it("names the number the queue will dial, and that it costs money", () => {
    const advisories = callSetupAdvisories(setup({
      groups: [{ id: "g1", name: "Denná", active: true, members: [operator("p1"), number("+421900000000")] }],
    }));
    const escalation = advisories.find((advisory) => advisory.title.startsWith("Keď nikto nedvíha"))!;

    expect(escalation.text).toContain("+421 900 000 000");
    expect(escalation.text).toContain("účtuje");
    expect(escalation.text).toContain("Raz za hovor");
  });

  it("says when there is nothing to escalate to, and how long the caller waits instead", () => {
    const advisory = callSetupAdvisories(setup()).find((item) => item.title === "Nie je kam eskalovať")!;

    // This is the case the dispatcher has to see: it is allowed, it is just
    // not what they probably think is happening.
    expect(advisory.tone).toBe("warning");
    expect(advisory.text).toContain("30 min");
  });

  it("calls out mobile delivery with no number at all", () => {
    const advisories = callSetupAdvisories(setup({
      operators: [
        { displayName: "Peter", active: true, settings: { deliveryMode: "personal_mobile", defaultMobileNumber: null } },
        { displayName: "Jana", active: true, settings: { deliveryMode: "personal_mobile", defaultMobileNumber: "+421905123456" } },
      ],
    }));

    expect(advisories.find((item) => item.title === "Doručovanie na mobil bez čísla")).toMatchObject({ tone: "error" });
    expect(advisories.find((item) => item.title === "Doručovanie na mobil bez čísla")!.text).toContain("Peter");
    expect(advisories.find((item) => item.title.startsWith("Niektorí operátori"))!.text).toContain("Jana");
  });

  it("says the backup number is out of play when escalation is turned off", () => {
    const advisories = callSetupAdvisories(setup({
      groups: [{ id: "g1", name: "Denná", active: true, members: [operator("p1"), number("+421900000000")] }],
      escalateAfterSeconds: 0,
    }));

    // A configured number that will never be dialled is exactly the kind of
    // thing that looks fine on the ring-group tab and is not.
    expect(advisories.find((item) => item.title === "Keď nikto nedvíha, skúsi sa záložné číslo")).toBeUndefined();
    expect(advisories.find((item) => item.title === "Záložné číslo sa nikdy nevytočí")).toMatchObject({ tone: "warning" });
  });

  it("uses the configured delay, not the built-in one", () => {
    const advisory = callSetupAdvisories(setup({
      groups: [{ id: "g1", name: "Denná", active: true, members: [operator("p1"), number("+421900000000")] }],
      escalateAfterSeconds: 300,
    })).find((item) => item.title.startsWith("Keď nikto nedvíha"))!;

    expect(advisory.text).toContain("5 min");
  });

  it("says when a step cannot ring everyone it lists", () => {
    const advisory = callSetupAdvisories(setup({
      groups: [{ id: "g1", name: "Denná", active: true, members: [operator("p1"), operator("p2"), operator("p3")] }],
      maxRingFanout: 2,
    })).find((item) => item.title === "Nezazvonia všetci naraz")!;

    expect(advisory.text).toContain("Denná");
    expect(advisory.text).toContain("2");
  });

  it("ignores an inactive plan and an inactive group", () => {
    expect(titles(setup({ plans: [{ name: "Starý", active: false, steps: [{ ringGroupId: "g1", strategy: "all" }] }] })))
      .toEqual(["Žiadny aktívny plán zvonenia"]);
    expect(titles(setup({ groups: [{ id: "g1", name: "Denná", active: false, members: [operator("p1")] }] })))
      .toContain("Plán zvonenia nemá koho volať");
  });
});
