import type { MobileFieldMe } from "@/lib/mobile-api";
import { fieldAdmin, fieldScope, requireMobileMember } from "@/server/mobile/field-auth";
import { mobileError, mobileJson } from "@/server/mobile/http";

export const runtime = "nodejs";
/** The field member signed in on this phone (pristavovač, vodič or miestny dispečer);
 * not a dispatcher. Capabilities and branch seats tell the app which modules to show. */
export async function GET(request: Request) {
  try {
    const actor = await requireMobileMember(request);
    let branches: { id: string; name: string }[] = [];
    const seats = await fieldAdmin().rpc("motorist_branch_actor", { p_user_id: actor.userId, p_organization_id: actor.organizationId });
    // No seat (42501) or a server without branches yet: the member simply has none. A passing
    // failure leaves `branches` out (unknown), so the app keeps what it knew and deliveries still open.
    const passing = Boolean(seats.error && !["42501", "PGRST202", "42883"].includes(seats.error.code ?? ""));
    if (passing) console.warn(JSON.stringify({ event: "mobile.field.me.branches", error: seats.error?.code ?? "unknown" }));
    if (!seats.error && Array.isArray((seats.data as { leadGroups?: unknown } | null)?.leadGroups))
      branches = ((seats.data as { leadGroups: { id: string; name: string }[] }).leadGroups).map(group => ({ id: group.id, name: group.name }));
    const payload: MobileFieldMe = { ...fieldScope(actor), member: { id: actor.memberId, displayName: actor.displayName, email: actor.email }, capabilities: actor.capabilities, ...(passing ? {} : { branches }) };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Účet sa nepodarilo načítať."); }
}
