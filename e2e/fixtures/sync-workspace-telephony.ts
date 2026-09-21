import { useEffect } from "react";
import { useTelephonyConsole as useFixture } from "./ustredna-telephony";
export { TELEPHONY_STALE_MESSAGE } from "./ustredna-telephony";
const evidence = { mounts: 0, cleanups: 0, actions: [] as { name: string; args: unknown[] }[] };
Object.assign(window, { syncPhoneEvidence: evidence });
export function useTelephonyConsole() {
  const model = useFixture();
  useEffect(() => { evidence.mounts++; return () => { evidence.cleanups++; }; }, []);
  return new Proxy(model, { get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? (...args: unknown[]) => {
      evidence.actions.push({ name: String(key), args });
      return value(...args);
    } : value;
  } });
}
