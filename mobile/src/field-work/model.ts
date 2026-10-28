import type {
  MobileOperation, MobileOperationAction, MobileOperationEvidence, MobileOperationEvidenceInput, MobileOperationKind, MobileOperationStatus,
  MobileTowingAttachment, MobileTowingFields, MobileTowingOrder, MobileTowingStatus,
} from "../../../src/lib/mobile-api";
import type { TagTone } from "../design/detail";
import type { FieldWorkList } from "./api";

/** Moja práca without any screen: labels, order of the list, the next step and what
 * a doklad or a submitted odťah still needs. The server re-checks all of it. */
export const operationKindLabels: Record<MobileOperationKind, string> = { delivery: "Pristavenie", collection: "Odvoz vozidla", transfer: "Presun vozidla" };
export const operationStatusLabels: Record<MobileOperationStatus, string> = {
  assigned: "Pridelené", accepted: "Prijaté", en_route: "Na ceste", arrived: "Na mieste", collected: "Vozidlo prevzaté", completed: "Dokončené", cancelled: "Zrušené",
};
export const operationStatusTones: Record<MobileOperationStatus, TagTone> = {
  assigned: "orange", accepted: "blue", en_route: "blue", arrived: "green", collected: "green", completed: "gray", cancelled: "gray",
};
export const towingStatusLabels: Record<MobileTowingStatus, string> = { assigned: "Pridelené", in_progress: "Prebieha", needs_changes: "Na doplnenie" };
export const towingStatusTones: Record<MobileTowingStatus, TagTone> = { assigned: "orange", in_progress: "blue", needs_changes: "red" };
export const serviceLabels: Record<MobileTowingFields["serviceType"], string> = { tow: "Odťah", repair: "Oprava na mieste", transport: "Prevoz", storage: "Uskladnenie", relocation: "Preparkovanie" };
export const stageLabels: Record<MobileOperationEvidence["stage"], string> = { pickup: "Prevzatie", handover: "Odovzdanie", inspection: "Kontrola", damage: "Poškodenie" };
export const sourceLabels: Record<MobileOperationEvidence["source"], string> = { observed: "Osobne zistené", reported: "Nahlásené inou osobou", exception: "Výnimka s odôvodnením" };
export const attachmentKindLabels: Record<MobileTowingAttachment["kind"], string> = { work: "Fotka práce", handover: "Fotka odovzdania", scan: "Sken papiera" };

export type WorkItem = { key: string; at: string | null; updatedAt: string } & ({ kind: "operation"; operation: MobileOperation } | { kind: "towing"; order: MobileTowingOrder });
/** Earliest term first; work without a term after it, the most recently changed first. */
export function workItems(list: FieldWorkList | undefined | null): WorkItem[] {
  const items: WorkItem[] = [
    ...(list?.operations ?? []).map(operation => ({ key: "operation:" + operation.id, kind: "operation" as const, operation, at: operation.scheduledAt, updatedAt: operation.updatedAt })),
    ...(list?.towing ?? []).map(order => ({ key: "towing:" + order.id, kind: "towing" as const, order, at: order.fields.plannedAt, updatedAt: order.updatedAt })),
  ];
  const time = (value: string | null) => value === null ? Number.POSITIVE_INFINITY : Date.parse(value);
  return items.sort((a, b) => time(a.at) - time(b.at) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.key.localeCompare(b.key));
}
export function isOpenOperation(operation: Pick<MobileOperation, "status">): boolean {
  return operation.status !== "completed" && operation.status !== "cancelled";
}

export type OperationStep = { action: Exclude<MobileOperationAction, "evidence">; label: string; confirm: string | null };
/** One main step at a time: Prijať → Začať → Som na mieste → (Vozidlo prevzaté) → Dokončiť. */
export function nextOperationStep(operation: Pick<MobileOperation, "status" | "kind">): OperationStep | null {
  switch (operation.status) {
    case "assigned": return { action: "accept", label: "Prijať jazdu", confirm: null };
    case "accepted": return { action: "start", label: "Začať jazdu", confirm: null };
    case "en_route": return { action: "arrive", label: "Som na mieste", confirm: null };
    case "arrived": return operation.kind === "collection" ? { action: "collect", label: "Vozidlo prevzaté", confirm: null }
      : { action: "complete", label: "Dokončiť jazdu", confirm: "Potvrdiť, že je jazda dokončená? Doklady môžete doplniť ešte pred týmto krokom." };
    case "collected": return { action: "complete", label: "Dokončiť jazdu", confirm: "Potvrdiť, že je vozidlo odovzdané a jazda dokončená?" };
    default: return null;
  }
}
export const operationStepLabels: Record<MobileOperationAction, string> = {
  accept: "Prijať jazdu", start: "Začať jazdu", arrive: "Som na mieste", collect: "Vozidlo prevzaté", complete: "Dokončiť jazdu", evidence: "Doklad",
};
/** Position goes to dispatch from the executor's acceptance until the work ends. */
export function sharesOperationPosition(operation: Pick<MobileOperation, "status">): boolean {
  return ["accepted", "en_route", "arrived", "collected"].includes(operation.status);
}
/** The one operation the phone follows: the earliest accepted open work. */
export function trackedOperation(list: FieldWorkList | undefined | null): string | null {
  return workItems(list).find(item => item.kind === "operation" && sharesOperationPosition(item.operation))?.key.slice("operation:".length) ?? null;
}

export type TowingStep = { type: "start" | "submit"; label: string; confirm: string | null };
export function nextTowingStep(order: Pick<MobileTowingOrder, "workStatus">): TowingStep {
  return order.workStatus === "assigned" ? { type: "start", label: "Začať prácu", confirm: null }
    : { type: "submit", label: "Odovzdať na kontrolu", confirm: "Odovzdať zákazku kancelárii? Potom ju už v aplikácii neupravíte." };
}
const needsDestination = (order: MobileTowingOrder) => ["tow", "transport", "relocation"].includes(order.fields.serviceType);
/** What the server will refuse on Odovzdať, said before sending. */
export function towingMissing(order: MobileTowingOrder): string[] {
  const ready = order.attachments.filter(item => item.status === "ready" && item.mimeType.startsWith("image/"));
  const missing: string[] = [];
  if (!order.fields.startedAt || order.fields.startSource === "assignment") missing.push("skutočný začiatok práce");
  if (!order.fields.finishedAt) missing.push("koniec práce");
  if (needsDestination(order) && !order.fields.destination?.trim()) missing.push("cieľ");
  if (!order.fields.photoException?.trim()) {
    if (!ready.some(item => item.kind === "work")) missing.push("fotka práce");
    if (needsDestination(order) && !ready.some(item => item.kind === "handover")) missing.push("fotka odovzdania");
  }
  if (order.attachments.some(item => item.status === "pending")) missing.push("dokončenie nahrávania príloh");
  return missing;
}

export type EvidenceDraft = {
  stage: MobileOperationEvidenceInput["stage"]; source: MobileOperationEvidenceInput["source"];
  person: string; odometer: string; fuel: string; note: string; missingReason: string; damageResolver: string;
};
export const emptyEvidence = (stage: EvidenceDraft["stage"] = "pickup"): EvidenceDraft => ({ stage, source: "observed", person: "", odometer: "", fuel: "", note: "", missingReason: "", damageResolver: "" });
export function parseOdometer(value: string): number | null {
  const trimmed = value.replace(/\s/g, "").replace(",", ".");
  if (!trimmed) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) && number >= 0 && number <= 10_000_000 ? number : Number.NaN;
}
/** The same rules as the server: each missing fact has its reason. */
export function evidenceProblem(draft: EvidenceDraft, photo: boolean, vehicleConfirmed: boolean): string | null {
  const reason = draft.missingReason.trim(), odometer = parseOdometer(draft.odometer);
  if (Number.isNaN(odometer)) return "Stav kilometrov zadajte číslom.";
  if (draft.stage === "damage" && !vehicleConfirmed) return "Poškodenie možno nahlásiť až pri potvrdenom vozidle. Kontaktujte dispečera.";
  if (draft.source === "exception" && !reason) return "Pri výnimke napíšte, prečo údaje chýbajú.";
  if (draft.stage !== "damage" && !draft.person.trim() && !reason) return "Uveďte, kto vozidlo odovzdal alebo prevzal, alebo prečo to nejde.";
  if ((odometer === null || !draft.fuel.trim()) && !reason) return "Doplňte kilometre a palivo, alebo napíšte, prečo chýbajú.";
  if (!photo && !reason) return "Pridajte fotografiu alebo napíšte, prečo chýba.";
  if (draft.stage === "damage" && (!draft.note.trim() || !draft.damageResolver.trim())) return "Pri poškodení opíšte, čo sa stalo, a uveďte, kto ho vyrieši.";
  return null;
}
export function evidencePayload(draft: EvidenceDraft, observedAt: string, photoReference: string | null): MobileOperationEvidenceInput {
  const optional = (value: string) => value.trim() || null;
  const odometer = parseOdometer(draft.odometer);
  return { stage: draft.stage, source: draft.source, observedAt, person: optional(draft.person), note: draft.note.trim(), photoReference,
    odometer: odometer === null || Number.isNaN(odometer) ? null : odometer, fuel: optional(draft.fuel), missingReason: optional(draft.missingReason),
    ...(draft.stage === "damage" ? { damageResolver: draft.damageResolver.trim() } : {}) };
}

/** The towing attachment form the server parses (one file plus its replay-safe ids). */
export function towingMultipart(fields: { attachmentId: string; commandId: string; kind: MobileTowingAttachment["kind"]; expectedRevision: number; assignmentGeneration: number },
  file: { bytes: Uint8Array; mimeType: string; name: string }, boundary: string): { bytes: Uint8Array; contentType: string } {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(boundary)) throw new Error("Neplatná požiadavka prílohy.");
  const encoder = new TextEncoder();
  const name = file.name.replace(/["\r\n\\/]/g, "_").slice(0, 120) || "priloha";
  const part = (key: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  const head = encoder.encode(part("attachmentId", fields.attachmentId) + part("commandId", fields.commandId) + part("kind", fields.kind)
    + part("expectedRevision", String(fields.expectedRevision)) + part("assignmentGeneration", String(fields.assignmentGeneration))
    + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`);
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`), bytes = new Uint8Array(head.length + file.bytes.length + tail.length);
  bytes.set(head); bytes.set(file.bytes, head.length); bytes.set(tail, head.length + file.bytes.length);
  return { bytes, contentType: "multipart/form-data; boundary=" + boundary };
}

/** "28. 10. 14:30" in Bratislava time; "Bez termínu" when nothing was agreed. */
export function termLabel(value: string | null): string {
  if (!value) return "Bez termínu";
  return new Intl.DateTimeFormat("sk-SK", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Bratislava" }).format(new Date(value));
}
export function isLate(value: string | null, now = Date.now()): boolean {
  return value !== null && Date.parse(value) < now;
}
