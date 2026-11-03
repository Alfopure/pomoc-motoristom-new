import "server-only";
import { isUuid } from "@/lib/telephony/uuid";
import { MutationError } from "./mutation-error";
import type { HandoffContext, HandoffDeliveryReceipt, HandoffReceipt } from "@/domain/case-handoff";
import { executeCaseHandoffCommand, getCaseHandoffContext, handoffSession, prepareCaseHandoffCommand, readHandoffBody } from "./case-handoff";
import { getHandoffDeliveryContext, parseMobileHandoffInput, sendHandoffToApp } from "./mobile/case-handoff";
import { deliveryUnavailable, mobileDeliveryEnabled } from "./mobile/field-auth";

/** Cookie authentication is resolved before any optional field-member reads. */
export async function getWebCaseHandoffContext(caseId: string): Promise<HandoffContext> {
  const session = await handoffSession();
  const context = await getCaseHandoffContext(caseId, session);
  if (!mobileDeliveryEnabled()) return context;
  const delivery = await getHandoffDeliveryContext(session, caseId, true);
  if (!delivery) throw new MutationError("Údaje o pristavovačoch sa nepodarilo načítať. Skúste to znova.", 503, "delivery_read_unavailable");
  return { ...context, delivery: { members: delivery.members },
    handoffs: context.handoffs.map(handoff => ({ ...handoff, app: delivery.app.get(handoff.id) ?? null })) };
}

export async function commandWebCaseHandoff(request: Request, caseId: string): Promise<HandoffReceipt | HandoffDeliveryReceipt> {
  // Use the web's strict Origin and JSON boundary, never the mobile bearer path.
  const input = await readHandoffBody(request);
  const session = await handoffSession();
  const command = parseMobileHandoffInput(input);
  const memberId = "recipientMemberId" in command ? command.recipientMemberId : undefined;
  if (memberId && !mobileDeliveryEnabled()) throw deliveryUnavailable();
  if (command.action === "deliver") {
    if (!isUuid(caseId)) throw new MutationError("Neplatná referencia prípadu.", 400);
    const sent = await sendHandoffToApp(session, caseId, command.handoffId, command.recipientMemberId, command.commandId, command.expectedRevision);
    return { commandId: command.commandId, handoffId: command.handoffId, memberId: command.recipientMemberId, sent: true, currentRevision: sent.currentRevision };
  }
  if (command.action !== "issue" || !memberId) return executeCaseHandoffCommand(request, caseId, command, session);

  const { receipt, resolveLink } = await prepareCaseHandoffCommand(request, caseId, command, session);
  let confirmed = receipt;
  if (resolveLink) {
    try { const recovered = await resolveLink(); confirmed = { ...receipt, handoff: recovered.handoff, url: recovered.url }; }
    catch { confirmed = { ...receipt, linkWarning: "link_unavailable" }; }
  }
  try {
    await sendHandoffToApp(session, caseId, receipt.handoff.id, memberId, command.commandId, Number(receipt.committedRevision));
    return { ...confirmed, delivery: { status: "sent", memberId } };
  } catch {
    // Retain the same handoff/command identity for a retry after uncertain assignment.
    return { ...confirmed, delivery: { status: "failed", memberId } };
  }
}
