import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;
type DatabaseLine = Pick<
  Database["public"]["Tables"]["motorist_telephony_lines"]["Row"],
  "external_id" | "id" | "label" | "phone_number"
>;

export const UNKNOWN_VIPTEL_LINE_LABEL = "Neznáma linka";

export type ViptelLinePurpose = "neutral" | "insurer" | "reserve";

export type ViptelLineCatalogEntry = {
  configured: boolean;
  id?: string;
  label: string;
  phoneNumber: string;
  purpose: ViptelLinePurpose;
  normalizedNumbers: string[];
};

export type ViptelLineIdentity = {
  lineId?: string;
  lineLabel: string;
  phoneNumber?: string;
};

export const VIPTEL_NEUTRAL_OUTBOUND_CID = "0412289240";

export const VIPTEL_CANONICAL_LINES = [
  { phoneNumber: VIPTEL_NEUTRAL_OUTBOUND_CID, label: "Neutrálna linka", purpose: "neutral" },
  { phoneNumber: "0412289241", label: "Allianz Assistance", purpose: "insurer" },
  { phoneNumber: "0412289242", label: "Autoklub Slovakia Assistance s.r.o.", purpose: "insurer" },
  { phoneNumber: "0412289243", label: "AXA Assistance CZ s.r.o.", purpose: "insurer" },
  { phoneNumber: "0412289244", label: "Eurocross Assistance Czech Republic s.r.o.", purpose: "insurer" },
  { phoneNumber: "0412289245", label: "Europ Assistance", purpose: "insurer" },
  { phoneNumber: "0412289247", label: "LeasePlan Slovakia s.r.o.", purpose: "insurer" },
  { phoneNumber: "0412289248", label: "Rezerva 1", purpose: "reserve" },
  { phoneNumber: "0412289249", label: "Rezerva 2", purpose: "reserve" },
] as const satisfies ReadonlyArray<{ phoneNumber: string; label: string; purpose: ViptelLinePurpose }>;

/**
 * Normalizes formatting variants of one whole dialled number. Matching callers
 * must still compare the returned value for equality; suffix matching is never
 * valid for insurer identity.
 */
export function normalizeViptelPublicNumber(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;

  const input = String(value).trim();
  if (!input || !/^\+?[\d\s()./-]+$/.test(input)) return undefined;

  let digits = input.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^0\d{9}$/.test(digits)) digits = `421${digits.slice(1)}`;
  if (/^[1-9]\d{8}$/.test(digits)) digits = `421${digits}`;

  return /^421\d{9}$/.test(digits) ? digits : undefined;
}

export function buildViptelLineCatalog(lines: ReadonlyArray<Partial<DatabaseLine>>): ViptelLineCatalogEntry[] {
  const normalizedRows = lines.map((line) => ({
    line,
    normalizedNumbers: uniqueNormalizedNumbers([line.phone_number, line.external_id]),
  }));

  return VIPTEL_CANONICAL_LINES.map((definition) => {
    const canonicalNumber = normalizeViptelPublicNumber(definition.phoneNumber)!;
    const matchingRows = normalizedRows.filter((row) => row.normalizedNumbers.includes(canonicalNumber));
    const exactRow = matchingRows.length === 1 && matchingRows[0].normalizedNumbers.length === 1
      ? matchingRows[0]
      : undefined;

    return {
      configured: Boolean(exactRow),
      id: exactRow?.line.id,
      label: definition.label,
      phoneNumber: definition.phoneNumber,
      purpose: definition.purpose,
      normalizedNumbers: [canonicalNumber],
    } satisfies ViptelLineCatalogEntry;
  });
}

export function findExactViptelLine(
  catalog: ReadonlyArray<ViptelLineCatalogEntry>,
  value: unknown,
): ViptelLineCatalogEntry | undefined {
  const normalized = normalizeViptelPublicNumber(value);
  if (!normalized) return undefined;

  const matches = catalog.filter((line) => line.configured && line.normalizedNumbers.includes(normalized));
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveViptelLineIdentity({
  catalog,
  providerNumbers = [],
  storedLineId,
  storedReceivedNumber,
}: {
  catalog: ReadonlyArray<ViptelLineCatalogEntry>;
  providerNumbers?: ReadonlyArray<unknown>;
  storedLineId?: string | null;
  storedReceivedNumber?: unknown;
}): ViptelLineIdentity {
  const storedLine = storedLineId ? uniqueLineById(catalog, storedLineId) : undefined;
  const storedNumberMatch = exactLineMatch(catalog, storedReceivedNumber);
  const storedPublicNumber = normalizeViptelPublicNumber(storedReceivedNumber);

  // A line id and received DID are one identity pair. If persisted evidence
  // conflicts, fail closed instead of combining one insurer label with another
  // insurer's displayed number. A syntactically valid but unapproved public DID
  // (for example the missing 9246) is conflicting evidence too.
  if (
    storedLine &&
    storedPublicNumber &&
    !storedLine.normalizedNumbers.includes(storedPublicNumber)
  ) {
    return { lineLabel: UNKNOWN_VIPTEL_LINE_LABEL };
  }

  if (storedLine) {
    return {
      lineId: storedLine.id,
      lineLabel: storedLine.label,
      phoneNumber: storedNumberMatch?.value ?? storedLine.phoneNumber,
    };
  }

  if (storedNumberMatch) {
    return {
      lineId: storedNumberMatch.line.id,
      lineLabel: storedNumberMatch.line.label,
      phoneNumber: storedNumberMatch.value,
    };
  }

  // A persisted public number is stronger evidence than a later provider leg.
  // If that number is not in the approved catalog, never relabel it from a
  // different provider candidate.
  if (storedPublicNumber) {
    return { lineLabel: UNKNOWN_VIPTEL_LINE_LABEL };
  }

  const publicProviderEvidence = providerNumbers
    .map((value) => ({ normalized: normalizeViptelPublicNumber(value), value }))
    .filter((item): item is { normalized: string; value: string | number } =>
      Boolean(item.normalized) && (typeof item.value === "string" || typeof item.value === "number"));
  const distinctProviderNumbers = new Set(publicProviderEvidence.map((item) => item.normalized));
  const providerMatch = distinctProviderNumbers.size === 1
    ? exactLineMatch(catalog, publicProviderEvidence[0]?.value)
    : undefined;

  return {
    lineId: providerMatch?.line.id,
    lineLabel: providerMatch?.line.label ?? UNKNOWN_VIPTEL_LINE_LABEL,
    phoneNumber: providerMatch?.value,
  };
}

export async function loadViptelLineCatalog(client: AdminClient, organizationId: string) {
  const result = await client
    .from("motorist_telephony_lines")
    .select("id, external_id, phone_number, label")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .eq("active", true);

  if (result.error) {
    throw new Error(`VIPTel line catalog could not be loaded: ${result.error.message}`);
  }

  return buildViptelLineCatalog(result.data ?? []);
}

function uniqueLineById(catalog: ReadonlyArray<ViptelLineCatalogEntry>, id: string) {
  const matches = catalog.filter((line) => line.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

function exactLineMatch(catalog: ReadonlyArray<ViptelLineCatalogEntry>, value: unknown) {
  const line = findExactViptelLine(catalog, value);
  if (!line || (typeof value !== "string" && typeof value !== "number")) return undefined;
  return { line, value: String(value).trim() };
}

function uniqueNormalizedNumbers(values: ReadonlyArray<unknown>) {
  return [...new Set(values.map(normalizeViptelPublicNumber).filter((value): value is string => Boolean(value)))];
}
