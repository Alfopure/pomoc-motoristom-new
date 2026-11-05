import { describe, expect, it, vi } from "vitest";
import { requestWorkNavigation } from "./work-navigation";
describe("edited work navigation", () => {
  it("keeps the card and draft when Back is cancelled, including a late discard callback", () => {
    const draft = { owner: "Ján", quantity: "2" };
    let selected: string | null = "tow-1";
    let discard = () => {}, keep = () => {};
    requestWorkNavigation(true, () => { selected = null; Object.assign(draft, { owner: "", quantity: "" }); }, (yes, no) => { discard = yes; keep = no; });
    keep(); discard();
    expect(selected).toBe("tow-1");
    expect(draft).toEqual({ owner: "Ján", quantity: "2" });
  });
  it("opens another card only after explicit discard, once", () => {
    const commit = vi.fn(); let discard = () => {};
    requestWorkNavigation(true, commit, yes => { discard = yes; });
    expect(commit).not.toHaveBeenCalled(); discard(); discard(); expect(commit).toHaveBeenCalledTimes(1);
  });
  it("navigates immediately when no unsaved edits exist", () => {
    const commit = vi.fn(), ask = vi.fn(); requestWorkNavigation(false, commit, ask);
    expect(commit).toHaveBeenCalledOnce(); expect(ask).not.toHaveBeenCalled();
  });
});
