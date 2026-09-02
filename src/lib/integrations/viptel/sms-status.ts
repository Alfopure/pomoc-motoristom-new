export type MotoristSmsStatus = "draft" | "queued" | "sent" | "delivered" | "failed" | "received";

export type ViptelSmsStatusDetail =
  | "accepted_by_gateway"
  | "sent_to_provider"
  | "delivered"
  | "undelivered"
  | "forbidden_destination"
  | "expired"
  | "provider_unavailable"
  | "unknown_provider_status";

export type NormalizedViptelSmsStatus = {
  providerStatusCode: number | null;
  status: Extract<MotoristSmsStatus, "sent" | "delivered" | "failed">;
  statusDetail: ViptelSmsStatusDetail;
  terminal: boolean;
};

export function mapViptelSmsStatusCode(value: unknown): NormalizedViptelSmsStatus {
  const providerStatusCode = normalizeProviderStatusCode(value);

  switch (providerStatusCode) {
    case 201:
      return {
        providerStatusCode,
        status: "sent",
        statusDetail: "accepted_by_gateway",
        terminal: false,
      };
    case 203:
      return {
        providerStatusCode,
        status: "sent",
        statusDetail: "sent_to_provider",
        terminal: false,
      };
    case 200:
      return {
        providerStatusCode,
        status: "delivered",
        statusDetail: "delivered",
        terminal: true,
      };
    case 207:
      return {
        providerStatusCode,
        status: "failed",
        statusDetail: "undelivered",
        terminal: true,
      };
    case 403:
      return {
        providerStatusCode,
        status: "failed",
        statusDetail: "forbidden_destination",
        terminal: true,
      };
    case 408:
      return {
        providerStatusCode,
        status: "failed",
        statusDetail: "expired",
        terminal: true,
      };
    case 503:
      return {
        providerStatusCode,
        status: "failed",
        statusDetail: "provider_unavailable",
        terminal: true,
      };
    default:
      return {
        providerStatusCode,
        status: "sent",
        statusDetail: "unknown_provider_status",
        terminal: false,
      };
  }
}

function normalizeProviderStatusCode(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) ? parsed : null;
  }

  return null;
}
