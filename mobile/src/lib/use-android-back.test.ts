import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAndroidBack } from "./use-android-back";
const native = vi.hoisted(() => ({ os: "android", handlers: new Set<() => boolean>(), cleanup: undefined as undefined | (() => void) }));
vi.mock("react", () => ({ useEffect: (effect: () => undefined | (() => void)) => { native.cleanup = effect(); } }));
vi.mock("react-native", () => ({ Platform: { get OS() { return native.os; } }, BackHandler: {
  addEventListener: (_name: string, handler: () => boolean) => { native.handlers.add(handler); return { remove: () => native.handlers.delete(handler) }; },
} }));
function BackScreen(active: boolean, back: () => void, blocked = false) {
  native.cleanup = undefined; useAndroidBack(active, back, blocked); return native.cleanup ?? (() => {});
}
function press() { return [...native.handlers].reverse().some(handler => handler()); }
beforeEach(() => { native.os = "android"; native.handlers.clear(); native.cleanup = undefined; });
describe("Android screen back ownership", () => {
  it("calls the visible Back callback once and consumes the native event", () => {
    const back = vi.fn(), remove = BackScreen(true, back); expect(press()).toBe(true); expect(back).toHaveBeenCalledTimes(1);
    remove(); expect(press()).toBe(false);
  });
  it("consumes blocked saves without navigating or falling through to app exit", () => {
    const back = vi.fn(); BackScreen(true, back, true); expect(press()).toBe(true); expect(back).not.toHaveBeenCalled();
  });
  it.each(["ios", "web"])("does not intercept %s behavior", os => {
    native.os = os; BackScreen(true, vi.fn()); expect(native.handlers.size).toBe(0);
  });
  it("does not register hidden or inactive screens", () => {
    BackScreen(false, vi.fn()); expect(native.handlers.size).toBe(0);
  });
  it.each([true, false])("nested task alone owns Back independent of parent registration order: %s", parentFirst => {
    const parent = vi.fn(), task = vi.fn();
    const mounts = [() => BackScreen(false, parent), () => BackScreen(true, task)]; if (!parentFirst) mounts.reverse();
    const cleanups = mounts.map(run => run()); expect(native.handlers.size).toBe(1); press(); expect(task).toHaveBeenCalledOnce(); expect(parent).not.toHaveBeenCalled();
    cleanups.forEach(cleanup => cleanup()); BackScreen(true, parent); BackScreen(false, task); press(); expect(parent).toHaveBeenCalledOnce();
  });
  it("uses the same live controller guard before a saving rerender reaches the hook", () => {
    const back = vi.fn(); let saving = false;
    const guardedBack = () => { if (!saving) back(); };
    BackScreen(true, guardedBack, false); saving = true; expect(press()).toBe(true); expect(back).not.toHaveBeenCalled();
    saving = false; press(); expect(back).toHaveBeenCalledOnce();
  });
  it("unsubscribes on pause and registers the current callback on resume", () => {
    const oldBack = vi.fn(), newBack = vi.fn(), remove = BackScreen(true, oldBack); remove(); BackScreen(false, oldBack);
    expect(press()).toBe(false); BackScreen(true, newBack); press(); expect(newBack).toHaveBeenCalledOnce(); expect(oldBack).not.toHaveBeenCalled();
  });
});
