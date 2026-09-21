import { describe, expect, it } from "vitest";
import { caseSyncPanelPosition, caseSyncPresentation, EMPTY_CASE_SYNC_SNAPSHOT, type CaseSyncSnapshot } from "./case-sync-status";

const current: CaseSyncSnapshot = { ...EMPTY_CASE_SYNC_SNAPSHOT, available: true, hidden: false, authorizedUntil: 30_000, lastVerifiedAt: 10 };
describe("case sync status meaning", () => {
  it("never claims success from initial props or unavailable capability", () => {
    expect(caseSyncPresentation(EMPTY_CASE_SYNC_SNAPSHOT, true, 0).kind).toBe("initial");
    expect(caseSyncPresentation({ ...current, available: false }, true, 100).kind).toBe("unavailable");
  });
  it("accepts successful HTTP fallback while naming only cases and notifications", () => {
    expect(caseSyncPresentation(current, true, 100)).toMatchObject({ kind: "current", label: "Prípady a upozornenia sú aktuálne.", spinning: false });
    expect(caseSyncPresentation(current, true, 100).detail).toContain("25 sekúnd");
    expect(caseSyncPresentation({ ...current, connected: true }, true, 100).detail).toContain("priebežne");
  });
  it("shows a spinner only during an actual read, including an incomplete continuation", () => {
    expect(caseSyncPresentation({ ...current, inFlight: true }, true, 100)).toMatchObject({ kind: "updating", spinning: true });
    expect(caseSyncPresentation({ ...current, incomplete: true }, true, 100)).toMatchObject({ kind: "updating", spinning: false });
  });
  it("keeps failures visible during retries and reconnects", () => {
    expect(caseSyncPresentation({ ...current, connected: true, inFlight: true, error: "failed" }, true, 100)).toMatchObject({ kind: "error", spinning: false, retry: true });
    expect(caseSyncPresentation(current, false, 100)).toMatchObject({ kind: "offline", retry: false });
  });
  it("gives denial and expired access priority over loading or a previous success", () => {
    expect(caseSyncPresentation({ ...current, denied: true, inFlight: true, error: "failed" }, true, 100).kind).toBe("denied");
    expect(caseSyncPresentation({ ...current, inFlight: true, error: "failed" }, true, 30_000).kind).toBe("expired");
    expect(caseSyncPresentation({ ...current, hidden: true }, true, 100).kind).toBe("expired");
  });
});

describe("case sync popup safety", () => {
  const anchor = { left: 230, bottom: 48, width: 36, height: 36 };
  it("stays below all current phone bars", () => {
    const box = caseSyncPanelPosition(anchor, { left: 0, top: 0, width: 1280, height: 800, bottomInset: 0 }, 260)!;
    expect(box.top).toBe(268); expect(box.left).toBe(230); expect(box.maxHeight).toBe(524);
  });
  it("clamps mobile width and protects the bottom navigation and zoomed viewport", () => {
    const box = caseSyncPanelPosition(anchor, { left: 10, top: 40, width: 300, height: 600, bottomInset: 72 }, 170)!;
    expect(box.left).toBe(18); expect(box.width).toBe(284); expect(box.top).toBe(178);
    expect(box.top + box.maxHeight).toBe(560);
  });
  it("closes when growing call bars leave no useful space or the responsive trigger is hidden", () => {
    expect(caseSyncPanelPosition(anchor, { left: 0, top: 0, width: 390, height: 600, bottomInset: 72 }, 450)).toBeNull();
    expect(caseSyncPanelPosition({ ...anchor, width: 0, height: 0 }, { left: 0, top: 0, width: 390, height: 800, bottomInset: 72 }, 120)).toBeNull();
  });
});
