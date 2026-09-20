import "server-only";

import { normalizeE164 } from "@/lib/telephony/normalize-e164";

import type { AiDemoDeps } from "./orchestrator";

/**
 * What the assistant may know about the person on the line.
 *
 * Two rules shape this file and neither lives in a prompt.
 *
 * The first: **there is no parameter for whose case to fetch.** The number
 * comes from the call record, so the model has no way to ask about a stranger.
 * Adding an argument here would move the protection into the wording of the
 * instructions, and wording can be talked around.
 *
 * The second: **what comes back is split in two.** `before` is what she may
 * say to an unverified voice — that a case exists and roughly where it stands.
 * `after` is everything else, and the caller only earns it by saying the plate.
 * Splitting it here rather than at the point of use means a caller who never
 * verifies cannot be handed the second half by a coding mistake somewhere else.
 */

export type CallerCaseBefore = {
  caseId: string;
  caseNumber: string;
  status: string;
  openedOn: string;
};

export type CallerCaseAfter = {
  contactName: string | null;
  vehicle: string | null;
  summary: string | null;
  mainNote: string | null;
};

export type CallerCase = {
  before: CallerCaseBefore;
  /** Never sent anywhere. Compared against what the caller says, nothing else. */
  plateOnFile: string | null;
  after: CallerCaseAfter;
};

export type CallerLookup =
  | { outcome: "no_number" }
  | { outcome: "not_found" }
  | { outcome: "several"; count: number }
  | { outcome: "found"; caseFound: CallerCase };

/**
 * Full disclosure is off unless something says otherwise, in those words.
 *
 * Deliberately not derived from `VERCEL_ENV`: that describes the deployment,
 * not the data, and it defaults to "development" when unset — so a runtime
 * that simply lacks the variable would unlock everything. This one locks.
 */
export function fullDisclosureEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AI_DEMO_FULL_DISCLOSURE?.trim().toLowerCase() === "true";
}

const OPEN_STATUSES = ["new", "triage", "open", "waiting_for_client", "scheduled", "assigned", "dispatched", "in_progress", "waiting_for_docs"] as const;

/**
 * Finds the caller's open case.
 *
 * `phoneNumber` is supplied by the caller's own call record, never by the
 * model. Several open cases on one number is not an error and not a list to
 * read out — she asks which one it is about, so the answer says only how many.
 */
export async function lookupCallerCase(deps: AiDemoDeps, phoneNumber: string | null): Promise<CallerLookup> {
  const normalized = normalizeE164(phoneNumber);
  if (!normalized) return { outcome: "no_number" };

  const contacts = await deps.admin
    .from("motorist_contacts")
    .select("id, name")
    .eq("organization_id", deps.organizationId)
    .eq("phone", normalized);
  const contactRows = contacts.data ?? [];
  if (contactRows.length === 0) return { outcome: "not_found" };

  const cases = await deps.admin
    .from("motorist_cases")
    .select("id, case_number, status, created_at, summary, main_note, contact_id, vehicle_id")
    .eq("organization_id", deps.organizationId)
    .in("contact_id", contactRows.map((row) => row.id))
    .in("status", OPEN_STATUSES)
    .order("created_at", { ascending: false });
  const caseRows = cases.data ?? [];
  if (caseRows.length === 0) return { outcome: "not_found" };
  if (caseRows.length > 1) return { outcome: "several", count: caseRows.length };

  const row = caseRows[0];
  const contact = contactRows.find((entry) => entry.id === row.contact_id) ?? null;

  let plate: string | null = null;
  let vehicle: string | null = null;
  if (row.vehicle_id) {
    const vehicles = await deps.admin
      .from("motorist_vehicles")
      .select("license_plate, make, model")
      .eq("organization_id", deps.organizationId)
      .eq("id", row.vehicle_id)
      .maybeSingle();
    if (vehicles.data) {
      plate = vehicles.data.license_plate ?? null;
      vehicle = [vehicles.data.make, vehicles.data.model].filter(Boolean).join(" ") || null;
    }
  }

  return {
    outcome: "found",
    caseFound: {
      before: {
        caseId: row.id,
        caseNumber: row.case_number,
        status: row.status,
        openedOn: String(row.created_at).slice(0, 10),
      },
      plateOnFile: plate,
      after: {
        contactName: contact?.name ?? null,
        vehicle,
        summary: row.summary ?? null,
        mainNote: row.main_note ?? null,
      },
    },
  };
}

/**
 * The sentence she is allowed to say once the plate checks out.
 *
 * With full disclosure off this stays on the near side of the line: the case
 * exists and where it stands, nothing about the person or the car. The caller
 * is told a colleague will ring back rather than being stonewalled.
 */
export function describeAfterVerification(found: CallerCase, full: boolean): string {
  const { before, after } = found;
  const head = `Prípad ${before.caseNumber} z ${before.openedOn}, stav ${before.status}.`;
  if (!full) {
    return `${head} Ďalšie podrobnosti k prípadu po telefóne neposkytuj — povedz, že sa ozve kolega.`;
  }
  const extras = [
    after.contactName ? `Meno: ${after.contactName}.` : null,
    after.vehicle ? `Vozidlo: ${after.vehicle}.` : null,
    after.summary ? `Zhrnutie: ${after.summary}` : null,
    after.mainNote ? `Poznámka: ${after.mainNote}` : null,
  ].filter(Boolean);
  return [head, ...extras].join(" ");
}

/** What she may say before the caller has proved anything. */
export function describeBeforeVerification(lookup: CallerLookup): string | null {
  switch (lookup.outcome) {
    case "found":
      // Deliberately not "I can see your case from the 12th" — that would
      // confirm a case exists, and when it was opened, to a voice that has
      // proved nothing. She waits to be asked.
      return "Volajúci má u nás otvorený prípad. Nehovor o ňom sám od seba ani nenaznačuj, že ho vidíš. Keď sa na svoj prípad spýta, požiadaj ho najprv o evidenčné číslo vozidla.";
    case "several":
      return "Volajúci má u nás viac otvorených prípadov. Nevymenúvaj ich. Keď sa spýta, nechaj ho povedať, o ktorý ide, a požiadaj o evidenčné číslo vozidla.";
    case "not_found":
    case "no_number":
    default:
      return null;
  }
}
