import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppState } from "react-native";

type PhoneSource = { subscribe: (notify: () => void) => () => void; snapshot: () => { call: unknown; termination: unknown } };
const PhoneOverlayBlocked = createContext({ blocked: false, subscribe: (_notify: () => void) => () => {} });
export function PhoneOverlayProvider({ blocked, source, children }: { blocked: boolean; source?: PhoneSource | null; children: ReactNode }) {
  const [background, setBackground] = useState(AppState.currentState === "background");
  const [listeners] = useState(() => new Set<() => void>());
  const subscribe = useCallback((notify: () => void) => { listeners.add(notify); return () => { listeners.delete(notify); }; }, [listeners]);
  useLayoutEffect(() => {
    if (!source) return;
    let wasBlocked = false;
    const update = () => {
      const state = source.snapshot(), next = Boolean(state.call || state.termination);
      if (next && !wasBlocked) for (const notify of listeners) notify();
      wasBlocked = next;
    };
    const unsubscribe = source.subscribe(update);
    update();
    return unsubscribe;
  }, [source, listeners]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", state => {
      if (state === "background") {
        // Native events can be batched back to active before React renders.
        // Revoke callbacks synchronously, even when that intermediate UI is skipped.
        for (const notify of listeners) notify();
        setBackground(true);
      }
      else if (state === "active") setBackground(false);
    });
    return () => listener.remove();
  }, [listeners]);
  return <PhoneOverlayBlocked.Provider value={{ blocked: blocked || background, subscribe }}>{children}</PhoneOverlayBlocked.Provider>;
}

/** A covering selection belongs to one visible page and one uninterrupted phone cycle. */
export class PhoneOverlaySelection<T> {
  private state: { value: T | null; epoch: number } = { value: null, epoch: 0 };
  private visible = false;
  private enabled = false;
  private listeners = new Set<() => void>();
  snapshot = () => this.state;
  subscribe = (notify: () => void) => { this.listeners.add(notify); return () => { this.listeners.delete(notify); }; };
  private update(value: T | null) {
    this.state = { value, epoch: this.state.epoch + 1 };
    for (const notify of this.listeners) notify();
  }
  context(visible: boolean, enabled: boolean) {
    this.enabled = visible && enabled;
    if (this.visible !== visible) { this.visible = visible; this.update(null); }
  }
  current = (epoch: number) => this.visible && this.enabled && epoch === this.state.epoch;
  show = (value: T, epoch: number) => { if (!this.current(epoch)) return false; this.update(value); return true; };
  close = (epoch = this.state.epoch) => { if (epoch === this.state.epoch) this.update(null); };
  begin = () => { if (!this.current(this.state.epoch)) return null; this.update(null); return this.state.epoch; };
}

/** visible is tab/page visibility, not AppState: an owned iOS permission sheet may make active false. */
export function usePhoneOverlay<T>(visible: boolean, enabled = visible) {
  const { blocked, subscribe } = useContext(PhoneOverlayBlocked);
  const [selection] = useState(() => new PhoneOverlaySelection<T>());
  const state = useSyncExternalStore(selection.subscribe, selection.snapshot, selection.snapshot);
  useLayoutEffect(() => { selection.context(visible && !blocked, enabled); }, [selection, visible, enabled, blocked]);
  useLayoutEffect(() => subscribe(() => selection.close()), [selection, subscribe]);
  useLayoutEffect(() => () => selection.context(false, false), [selection]);
  return {
    value: visible && !blocked ? state.value : null,
    canOpen: visible && enabled && !blocked,
    open: (value: T) => selection.show(value, state.epoch),
    close: () => selection.close(state.epoch),
    guard: <A extends unknown[]>(action: (...args: A) => void) => (...args: A) => { if (selection.current(state.epoch)) action(...args); },
    begin: () => selection.current(state.epoch) ? selection.begin() : null,
    current: selection.current,
    show: selection.show,
  };
}
