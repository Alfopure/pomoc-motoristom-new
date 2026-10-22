import { describe, expect, it, vi } from "vitest";
import type { Reading, TrackingState } from "./background";
import { BackgroundTracker, type BackgroundSource, type Permission } from "./sharing";

const A = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d001", B = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d002";
const ME = "abababab-abab-4bab-8bab-abababababab", OTHER = "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd";
function setup({ permission = "granted", answer = "granted", always = "undetermined", alwaysAnswer = "granted", stored = null as TrackingState | null, running = false } = {} as {
  permission?: Permission; answer?: Permission; always?: Permission; alwaysAnswer?: Permission; stored?: TrackingState | null; running?: boolean }) {
  let saved = stored, active = running, queue: Reading[] = [{ lat: 1, lng: 1, accuracy: null, recordedAt: "2026-10-22T09:00:00Z" }];
  const source: BackgroundSource = {
    permission: vi.fn(async () => permission), request: vi.fn(async () => answer),
    backgroundPermission: vi.fn(async () => always), requestBackground: vi.fn(async () => alwaysAnswer),
    running: vi.fn(async () => active), start: vi.fn(async () => { active = true; }), stop: vi.fn(async () => { active = false; }),
  };
  const issue = vi.fn(async (deliveryId: string) => ({ token: (deliveryId === A ? "a" : "b").repeat(43), expiresAt: "2099-01-01T00:00:00Z" }));
  const revoke = vi.fn(async () => undefined);
  const tracker = new BackgroundTracker({
    source, issue, revoke, scope: { environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk" },
    store: { load: async () => saved, save: async value => { saved = value; }, clear: async () => { saved = null; } },
    queue: { load: async () => queue, save: async value => { queue = value; }, clear: async () => { queue = []; } },
  });
  tracker.setMember(ME);
  return { tracker, source, issue, revoke, saved: () => saved, running: () => active, queue: () => queue };
}
const kept = (deliveryId = A, memberId = ME): TrackingState => ({ version: 1, environment: "test", apiOrigin: "https://test.dispecing.linkapomoci.sk", memberId, deliveryId, token: "k".repeat(43), expiresAt: "2099-01-01T00:00:00Z" });

describe("background sharing of the pristavovač's position", () => {
  it("asks only when told, then shares also with the app closed", async () => {
    const quiet = setup({ permission: "undetermined" });
    await quiet.tracker.follow(A);
    expect(quiet.source.request).not.toHaveBeenCalled();
    expect(quiet.running()).toBe(false);
    const asked = setup({ permission: "undetermined" });
    await asked.tracker.follow(A, true);
    expect(asked.source.request).toHaveBeenCalledOnce();
    expect(asked.source.requestBackground).toHaveBeenCalledOnce();
    expect(asked.running()).toBe(true);
    expect(asked.saved()).toMatchObject({ deliveryId: A, memberId: ME, token: "a".repeat(43) });
    expect(asked.tracker.snapshot()).toMatchObject({ status: "sharing", background: "always" });
  });

  it("works with only While Using, and says so", async () => {
    const limited = setup({ always: "denied" });
    await limited.tracker.follow(A, true);
    expect(limited.tracker.snapshot()).toMatchObject({ status: "sharing", background: "whenInUse" });
  });

  it("reports a refusal and sends nothing", async () => {
    const refused = setup({ permission: "undetermined", answer: "denied" });
    await refused.tracker.follow(A, true);
    expect(refused.tracker.snapshot().status).toBe("denied");
    expect(refused.issue).not.toHaveBeenCalled();
  });

  it("goes on with the kept secret after the app was closed, and gets a new one for another delivery", async () => {
    const reopened = setup({ stored: kept(A), running: false });
    await reopened.tracker.follow(A);
    expect(reopened.issue).not.toHaveBeenCalled();
    expect(reopened.running()).toBe(true);
    const switched = setup({ stored: kept(A), running: true });
    await switched.tracker.follow(B);
    expect(switched.issue).toHaveBeenCalledWith(B);
    expect(switched.saved()?.deliveryId).toBe(B);
    expect(switched.queue()).toEqual([]);
  });

  it("stops and forgets when no delivery needs it", async () => {
    const done = setup({ stored: kept(A), running: true });
    await done.tracker.follow(null);
    expect(done.running()).toBe(false);
    expect(done.saved()).toBeNull();
    expect(done.queue()).toEqual([]);
    expect(done.tracker.snapshot().status).toBe("off");
  });

  it("stops what another account left running", async () => {
    const foreign = setup({ stored: kept(A, OTHER), running: true });
    await foreign.tracker.reconcile(ME);
    expect(foreign.running()).toBe(false);
    expect(foreign.saved()).toBeNull();
    const same = setup({ stored: kept(A, ME), running: true });
    await same.tracker.reconcile(ME);
    expect(same.running()).toBe(true);
  });

  it("revokes the secret at logout", async () => {
    const leaving = setup({ stored: kept(A), running: true });
    await leaving.tracker.forget();
    expect(leaving.revoke).toHaveBeenCalledWith(A);
    expect(leaving.running()).toBe(false);
    expect(leaving.saved()).toBeNull();
  });

  it("shows an error when the secret cannot be had, and does nothing without a pristavovač", async () => {
    const offline = setup();
    offline.issue.mockRejectedValueOnce(new Error("offline"));
    await offline.tracker.follow(A);
    expect(offline.tracker.snapshot().status).toBe("error");
    expect(offline.running()).toBe(false);
    const nobody = setup();
    nobody.tracker.setMember(null);
    await nobody.tracker.follow(A, true);
    expect(nobody.source.permission).not.toHaveBeenCalled();
  });

  it("keeps sending after the screen went away", async () => {
    const screen = setup();
    await screen.tracker.follow(A);
    screen.tracker.dispose();
    expect(screen.running()).toBe(true);
  });
});
