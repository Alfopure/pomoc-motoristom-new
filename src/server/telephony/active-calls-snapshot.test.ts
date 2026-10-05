import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelephonyHarness, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { loadActiveCalls, readActiveCallRows } from "./active-calls";

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("activated single-request call overview", () => {
  it("keeps the same per-operator offers, call links and private leg correlation as table reads", async () => {
    const h = createTelephonyHarness();
    const call = await h.inbound({ to: NUMBERS.allianz });
    const deps = { ...h.deps, configured: true };
    const actors = [PROFILES.o1, PROFILES.o2].map(profileId => ({ profileId, canManageAssignments: false }));
    const original = await Promise.all(actors.map(actor => loadActiveCalls(deps, actor)));
    const rows = await readActiveCallRows(deps);
    const payload = JSON.parse(JSON.stringify({ ...rows, callRows: [...rows.callIdBySession].map(([session_id, id]) => ({ id, session_id })) }));
    const signal = vi.fn((_signal: AbortSignal) => Promise.resolve({ data: payload, error: null }));
    const rpc = vi.spyOn(h.admin, "rpc").mockReturnValue({ abortSignal: signal } as unknown as ReturnType<typeof h.admin.rpc>);
    const from = vi.spyOn(h.client, "from");
    const before = h.telnyx.calls.length;
    vi.stubEnv("TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED", "true");

    const projected = await Promise.all(actors.map(actor => loadActiveCalls(deps, actor)));

    expect(projected).toEqual(original);
    expect(projected[0].calls.find(row => row.sessionId === call.sessionId)?.callId).toBeTruthy();
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc).toHaveBeenCalledWith("motorist_active_call_snapshot_v1", { p_organization_id: ORG, p_environment: h.deps.environment });
    expect(signal.mock.calls.every(args => args[0] instanceof AbortSignal)).toBe(true);
    expect(from).not.toHaveBeenCalled();
    expect(h.telnyx.calls).toHaveLength(before);
  });

  it("does not add table queries after an RPC outage or missing migration", async () => {
    const h = createTelephonyHarness();
    const rpc = vi.spyOn(h.admin, "rpc").mockReturnValue({ abortSignal: () => Promise.resolve({ data: null, error: { code: "PGRST202", message: "not installed" } }) } as unknown as ReturnType<typeof h.admin.rpc>);
    const from = vi.spyOn(h.client, "from");
    vi.stubEnv("TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED", "true");

    await expect(loadActiveCalls({ ...h.deps, configured: true }, { profileId: PROFILES.o1, canManageAssignments: false })).rejects.toThrow("active call snapshot failed: not installed");

    expect(rpc).toHaveBeenCalledOnce();
    expect(from).not.toHaveBeenCalled();
    expect(h.telnyx.calls).toHaveLength(0);
  });

  it.each([null, [], {}, { sessions: [] }])("rejects an incomplete overview before projection (%j)", async data => {
    const h = createTelephonyHarness();
    vi.spyOn(h.admin, "rpc").mockReturnValue({ abortSignal: () => Promise.resolve({ data, error: null }) } as unknown as ReturnType<typeof h.admin.rpc>);
    const from = vi.spyOn(h.client, "from");
    vi.stubEnv("TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED", "true");
    await expect(readActiveCallRows({ ...h.deps, configured: true })).rejects.toThrow(/active call snapshot/);
    expect(from).not.toHaveBeenCalled();
  });

  it("keeps the compatible table path until activation", async () => {
    const h = createTelephonyHarness();
    vi.stubEnv("TELEPHONY_ACTIVE_SNAPSHOT_V1_ENABLED", "false");
    const rpc = vi.spyOn(h.admin, "rpc");
    await expect(readActiveCallRows({ ...h.deps, configured: true })).resolves.toMatchObject({ sessions: [], legs: [], attempts: [] });
    expect(rpc).not.toHaveBeenCalled();
  });
});
