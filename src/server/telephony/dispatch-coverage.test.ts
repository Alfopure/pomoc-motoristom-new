import { describe, expect, it } from "vitest";

import { DISPATCH_QUEUE_NUMBERS } from "./dispatch-routing";
import {
  coverageStepIsSafe,
  diffDispatchCoverage,
  dispatchCoverageDigest,
  onlineDispatchExtensions,
  orderedDispatchPlanExtensions,
  packDispatchQueueCoverage,
} from "./dispatch-coverage";

const Q = DISPATCH_QUEUE_NUMBERS;

function queue(name: string, members: Array<{ extension: string; paused?: boolean; inUse?: boolean; dynamic?: boolean }>, waitingCalls = 0) {
  return {
    queue: name,
    waitingCalls,
    members: members.map((m) => ({
      extension: m.extension,
      paused: m.paused ?? false,
      inUse: m.inUse ?? false,
      dynamic: m.dynamic ?? true,
    })),
  } as never;
}

const registered = (...extensions: string[]) =>
  extensions.map((extension) => ({ extension, isRegistered: true })) as never[];

describe("ring coverage follows the number of operators online", () => {
  it("leaves every queue empty with nobody online, so the fallback fires immediately", () => {
    const map = packDispatchQueueCoverage(Q, []);
    expect(Q.every((q) => map[q].length === 0)).toBe(true);
  });

  it("keeps a lone operator ringing for the whole window when fill-forward is on", () => {
    // This is the reported bug: one operator planned into 601 stopped ringing
    // after the first rotation step and the caller sat in two empty queues.
    const map = packDispatchQueueCoverage(Q, ["20"], { fillForward: true });
    expect(map).toEqual({ "601": ["20"], "602": ["20"], "603": ["20"] });
  });

  it("gives two operators one rotation step each, then the second covers the rest", () => {
    const map = packDispatchQueueCoverage(Q, ["20", "21"], { fillForward: true });
    expect(map).toEqual({ "601": ["20"], "602": ["21"], "603": ["21"] });
  });

  it("gives each operator exactly one queue by default", () => {
    // Fill-forward is off until VIPTel stops re-offering a caller to an agent
    // already on that call. A member of two queues at once got rung twice for
    // one caller, which left two live legs sharing a queue identity and made
    // hanging up the call fail.
    expect(packDispatchQueueCoverage(Q, ["20"])).toEqual({ "601": ["20"], "602": [], "603": [] });
    expect(packDispatchQueueCoverage(Q, ["20", "21"]))
      .toEqual({ "601": ["20"], "602": ["21"], "603": [] });
  });

  it("never puts one extension in two queues with the default rule", () => {
    for (const online of [["20"], ["20", "21"], ["20", "21", "22"], ["20", "21", "22", "23"]]) {
      const placements = Q.flatMap((queue) => packDispatchQueueCoverage(Q, online)[queue]);
      expect(new Set(placements).size).toBe(placements.length);
    }
  });

  it("gives three operators one step each", () => {
    const map = packDispatchQueueCoverage(Q, ["20", "21", "22"]);
    expect(map).toEqual({ "601": ["20"], "602": ["21"], "603": ["22"] });
  });

  it("places a fourth operator rather than dropping them", () => {
    const map = packDispatchQueueCoverage(Q, ["20", "21", "22", "23"]);
    expect(map["601"]).toEqual(["20"]);
    expect(map["602"]).toEqual(["21"]);
    expect(map["603"]).toEqual(expect.arrayContaining(["22", "23"]));
  });

  it("always covers the first queue whenever anyone is online", () => {
    // A caller must never arrive into an empty 601 while somebody is available.
    for (const online of [["20"], ["20", "21"], ["20", "21", "22"], ["20", "21", "22", "23"]]) {
      expect(packDispatchQueueCoverage(Q, online)["601"]).toEqual([online[0]]);
    }
  });

  it("never leaves a gap between covered queues when filling forward", () => {
    for (const online of [["20"], ["20", "21"], ["20", "21", "22"]]) {
      const map = packDispatchQueueCoverage(Q, online, { fillForward: true });
      expect(Q.every((q) => map[q].length > 0)).toBe(true);
    }
  });

  it("contains no time constant, so a 30s to 20s rotation change needs no code change", () => {
    const source = packDispatchQueueCoverage.toString();
    expect(source).not.toMatch(/\b(20|30|20_000|30_000)\b/);
  });
});

describe("who counts as online", () => {
  it("ignores an unregistered extension whose membership survived a crashed browser", () => {
    const online = onlineDispatchExtensions({
      planOrder: ["20", "21"],
      queueStatuses: [queue("601", [{ extension: "20" }]), queue("602", [{ extension: "21" }])],
      extensions: registered("20"), // 21 is a member but not registered
    });
    expect(online).toEqual(["20"]);
  });

  it("ignores a paused member", () => {
    const online = onlineDispatchExtensions({
      planOrder: ["20", "21"],
      queueStatuses: [queue("601", [{ extension: "20" }, { extension: "21", paused: true }])],
      extensions: registered("20", "21"),
    });
    expect(online).toEqual(["20"]);
  });

  it("still counts an operator who is on a call", () => {
    // VIPTel marks an operator in-use while the very call being offered rings
    // at them; treating busy as offline would make a ringing call trigger its
    // own coverage change.
    const online = onlineDispatchExtensions({
      planOrder: ["20"],
      queueStatuses: [queue("601", [{ extension: "20", inUse: true }])],
      extensions: registered("20"),
    });
    expect(online).toEqual(["20"]);
  });

  it("returns operators in manager plan order, not provider order", () => {
    const online = onlineDispatchExtensions({
      planOrder: ["22", "20", "21"],
      queueStatuses: [queue("601", [{ extension: "20" }, { extension: "21" }, { extension: "22" }])],
      extensions: registered("20", "21", "22"),
    });
    expect(online).toEqual(["22", "20", "21"]);
  });

  it("ignores an extension outside the committed plan", () => {
    const online = onlineDispatchExtensions({
      planOrder: ["20"],
      queueStatuses: [queue("601", [{ extension: "20" }, { extension: "99" }])],
      extensions: registered("20", "99"),
    });
    expect(online).toEqual(["20"]);
  });
});

describe("diffing towards the desired arrangement", () => {
  const managed = new Set(["20", "21", "22"]);

  it("adds before removing so no queue is momentarily empty", () => {
    const steps = diffDispatchCoverage(
      { "601": ["20"], "602": ["21"], "603": ["21"] },
      [queue("601", [{ extension: "20" }]), queue("602", [{ extension: "22" }]), queue("603", [])],
      { managed },
    );
    expect(steps[0]?.action).toBe("add");
    expect(steps.filter((s) => s.action === "remove").every((s) => s.extension === "22")).toBe(true);
  });

  it("never touches an extension outside the plan", () => {
    const steps = diffDispatchCoverage(
      { "601": ["20"], "602": [], "603": [] },
      [queue("601", [{ extension: "20" }, { extension: "99" }])],
      { managed },
    );
    expect(steps.some((s) => s.extension === "99")).toBe(false);
  });

  it("never removes a statically configured member", () => {
    const steps = diffDispatchCoverage(
      { "601": [], "602": [], "603": [] },
      [queue("601", [{ extension: "21", dynamic: false }])],
      { managed },
    );
    expect(steps).toEqual([]);
  });

  it("produces nothing once the arrangement already matches", () => {
    const desired = { "601": ["20"], "602": ["21"], "603": ["21"] };
    const observed = [queue("601", [{ extension: "20" }]), queue("602", [{ extension: "21" }]), queue("603", [{ extension: "21" }])];
    expect(diffDispatchCoverage(desired, observed, { managed })).toEqual([]);
    expect(dispatchCoverageDigest(desired)).toBe(dispatchCoverageDigest({ ...desired }));
  });
});

describe("per-step safety", () => {
  const desired = { "601": ["20"], "602": ["20"], "603": ["20"] };

  it("refuses to remove a member who is on a call", () => {
    const verdict = coverageStepIsSafe(
      { action: "remove", queue: "602", extension: "21" },
      { queueStatuses: [queue("602", [{ extension: "21", inUse: true }])], desired },
    );
    expect(verdict.safe).toBe(false);
  });

  it("defers a removal while callers are waiting in that queue", () => {
    const verdict = coverageStepIsSafe(
      { action: "remove", queue: "602", extension: "21" },
      { queueStatuses: [queue("602", [{ extension: "21" }], 2)], desired },
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.reason).toBe("callers_waiting");
  });

  it("still empties the queues when nobody is online, even with callers waiting", () => {
    // This is exactly the case where removal must happen: emptying every queue
    // is what lets the no-available-operator fallback fire.
    const verdict = coverageStepIsSafe(
      { action: "remove", queue: "602", extension: "21" },
      {
        queueStatuses: [queue("602", [{ extension: "21" }], 3)],
        desired: { "601": [], "602": [], "603": [] },
      },
    );
    expect(verdict.safe).toBe(true);
  });

  it("always allows an add", () => {
    expect(coverageStepIsSafe(
      { action: "add", queue: "601", extension: "20" },
      { queueStatuses: [queue("601", [], 5)], desired },
    ).safe).toBe(true);
  });
});

describe("plan ordering", () => {
  it("reads the manager plan as an ordered priority list", () => {
    expect(orderedDispatchPlanExtensions({ "601": "20", "602": "21", "603": "22" }))
      .toEqual(["20", "21", "22"]);
    expect(orderedDispatchPlanExtensions({ "601": "20", "602": null, "603": "22" }))
      .toEqual(["20", "22"]);
  });
});
