import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import type { ShellBackStore } from "./back-store";

export const ShellBackContext = createContext<ShellBackStore | null>(null);

/** Shows "‹ label" in the shell top bar while `active`; Android Back stays with
 * the screen's own useAndroidBack. Outside the shell (tests, previews) it does nothing. */
export function useShellBack(active: boolean, label: string, onBack: () => void, disabled = false) {
  const store = useContext(ShellBackContext);
  const [id] = useState(() => store?.nextId() ?? 0);
  const handler = useRef(onBack);
  useLayoutEffect(() => { handler.current = onBack; });
  useLayoutEffect(() => {
    if (!store || !active) return;
    store.set(id, { label, disabled, onBack: () => handler.current() });
    return () => store.set(id, null);
  }, [store, id, active, label, disabled]);
}
