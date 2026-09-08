import { describe, expect, it } from "vitest";
import { createFakeTelnyx } from "./fake-telnyx";

describe("physical provider graph and lost acknowledgements", () => {
  it("models provider transfer connecting on target answer without an application bridge", async () => {
    const fake = createFakeTelnyx(); fake.physical.answered("customer");
    await fake.client.transfer({ commandId: "transfer", callControlId: "customer", to: "+421900111222" });
    const target = [...fake.physical.legs.values()].find((leg) => leg.to === "+421900111222")!;
    expect(fake.physical.connections()).toEqual([]);
    fake.physical.answered(target.id);
    expect(fake.physical.connected("customer", target.id)).toBe(true);
    expect(fake.of("bridge")).toHaveLength(0);
  });
  it("models an armed bridge as physically connected before processing the answer webhook", async () => {
    const fake = createFakeTelnyx(); fake.physical.answered("customer");
    await fake.client.bridge({ commandId: "early", callControlId: "customer", targetCallControlId: "operator" });
    expect(fake.physical.connections()).toEqual([]);
    fake.physical.answered("operator");
    expect(fake.physical.connected("customer", "operator")).toBe(true);
    await fake.client.hangup({ commandId: "withdraw", callControlId: "operator" });
    expect(fake.physical.connections()).toEqual([]);
  });
  it("RC-04 stable dial, bridge and conference IDs survive accepted operations with lost HTTP replies", async () => {
    const fake = createFakeTelnyx();
    const dial = { commandId: "dial-once", to: "+421900111222", from: "+421900222333" };
    fake.loseNextResponse("dial");
    await expect(fake.client.dial(dial)).rejects.toMatchObject({ code: "timeout" });
    const result = await fake.client.dial(dial);
    expect(fake.physical.legs.size).toBe(1);
    expect(result.callControlId).toBe([...fake.physical.legs.keys()][0]);
    fake.physical.answered("customer"); fake.physical.answered(result.callControlId);
    const bridge = { commandId: "bridge-once", callControlId: "customer", targetCallControlId: result.callControlId };
    fake.loseNextResponse("bridge");
    await expect(fake.client.bridge(bridge)).rejects.toMatchObject({ code: "timeout" });
    await fake.client.bridge(bridge);
    expect(fake.physical.connections()).toHaveLength(1);
    const conference = { commandId: "conference-once", callControlId: "customer", name: "test" };
    fake.loseNextResponse("createConference");
    await expect(fake.client.createConference(conference)).rejects.toMatchObject({ code: "timeout" });
    const created = await fake.client.createConference(conference);
    expect((await fake.client.createConference(conference)).id).toBe(created.id);
    fake.loseNextResponse("conference:join");
    const join = { commandId: "join-once", call_control_id: result.callControlId };
    await expect(fake.client.conferenceAction(created.id, "join", join)).rejects.toMatchObject({ code: "timeout" });
    await fake.client.conferenceAction(created.id, "join", join);
    expect(fake.physical.connections()).toHaveLength(1);
  });
});
