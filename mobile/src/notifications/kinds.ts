import type { MobilePushType } from "../../../src/lib/mobile-api";
import type { FieldModules } from "../shell/modules";

/** A dispatcher's kinds, then the field member's: Pristavenia, Moja práca, Pobočka. */
export const DISPATCH_PUSH: readonly MobilePushType[] = ["tasks", "task_due", "cases", "callbacks_mine", "callbacks_unclaimed"];
export function pushKinds(dispatch: boolean, field: boolean | FieldModules): MobilePushType[] {
  const value: FieldModules = field === true ? { delivery: true, work: false, branch: false } : field || { delivery: false, work: false, branch: false };
  return [...(dispatch ? DISPATCH_PUSH : []), ...(value.delivery ? ["handoffs" as const] : []), ...(value.work ? ["work" as const] : []), ...(value.branch ? ["branch" as const] : [])];
}
/** What "Zapnúť notifikácie" promises, for the kinds this account has. */
export function pushOffer(kinds: readonly MobilePushType[]): string {
  const parts = [kinds.includes("tasks") ? "úlohy, prípady a spätné volania" : null, kinds.includes("handoffs") ? "pristavenia" : null,
    kinds.includes("work") ? "pridelenú prácu" : null, kinds.includes("branch") ? "požiadavky pobočky" : null].filter((part): part is string => part !== null);
  const text = parts.length > 1 ? parts.slice(0, -1).join(", ") + " a " + parts[parts.length - 1] : parts[0] ?? "upozornenia";
  return text.charAt(0).toUpperCase() + text.slice(1) + " aj pri zamknutom telefóne";
}
