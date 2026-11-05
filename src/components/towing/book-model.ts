import type { TowingOrder } from "@/domain/towing/types";
import { calculateTowingLine } from "@/domain/towing/money";

export const stageLabels = { draft: "Nepridelené", active: "V realizácii", review: "Na kontrolu", ready: "Na fakturáciu", invoiced: "Vyfakturované", paid: "Zaplatené", cancelled: "Stornované", needs_changes: "Na doplnenie" };
export { towingBookStage as bookStage } from "@/domain/towing/book-query";
export function bookNet(order: Pick<TowingOrder, "lines">): number | null {
  if (!order.lines?.length) return null;
  try { return order.lines.reduce((sum, line) => sum + (line.netCents ?? calculateTowingLine(line).netCents), 0); } catch { return null; }
}
export function bookRequester(order: Pick<TowingOrder, "fields">) {
  return order.fields.assistancePartnerName || order.fields.requester?.name || "Neurčený objednávateľ";
}
