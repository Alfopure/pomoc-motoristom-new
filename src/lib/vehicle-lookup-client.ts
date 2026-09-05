import { readVehicleLookupSnapshot, type VehicleLookupInput, type VehicleLookupResponse } from "./vehicle-lookup";

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Only an occupied lookup lease is retried. Provider failures and limits are not. */
export async function requestVehicleLookup(input: VehicleLookupInput, signal: AbortSignal, onWaiting: (seconds: number) => void): Promise<VehicleLookupResponse> {
  const body = JSON.stringify(input);
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    const response = await fetch("/api/vehicles/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, signal, body });
    const result = await response.json() as VehicleLookupResponse & { error?: string };
    signal.throwIfAborted();
    if (response.status === 409 && attempt < 6) {
      const header = response.headers.get("Retry-After");
      const seconds = header === null ? 5 : /^\d+$/.test(header) ? Number(header) : (Date.parse(header) - Date.now()) / 1000;
      const delay = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 5;
      // Do not retry earlier than the server requests, or wait indefinitely.
      if (waited + delay <= 30) {
        waited += delay;
        onWaiting(delay);
        await pause(delay * 1000, signal);
        onWaiting(0);
        continue;
      }
    }
    if (!response.ok || !readVehicleLookupSnapshot(result.snapshot)) throw new Error(result.error || "Dohľadanie sa nepodarilo dokončiť.");
    return result;
  }
}
