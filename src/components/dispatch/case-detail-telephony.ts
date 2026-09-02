import type { WorkplaceWebphoneSessionFence } from "@/lib/telephony/webphone-client";

export function buildCaseCustomerCallBody(input: {
  caseId: string;
  toNumber: string;
  workplaceFence?: WorkplaceWebphoneSessionFence;
}) {
  return {
    mode: "extension_callback" as const,
    toNumber: input.toNumber,
    caseId: input.caseId,
    ...input.workplaceFence,
  };
}
