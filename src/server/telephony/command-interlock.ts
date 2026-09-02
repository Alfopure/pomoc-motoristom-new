import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, Json } from "@/lib/supabase/database.types";
import { MutationError } from "@/server/motorist-mutations";

export const READ_ONLY_TELEPHONY_COMMAND_TYPES = ["provider.snapshot"] as const;

type ExtensionCommandReference = {
  call_id?: string | null;
  command_type?: string | null;
  extension_id?: string | null;
  request_payload?: Json;
  status?: string | null;
};

type ExtensionCommandInterlockOptions = {
  terminalBrowserTransferCallIds?: ReadonlySet<string>;
};

export function isReadOnlyTelephonyCommand(commandType: string | null | undefined) {
  return (READ_ONLY_TELEPHONY_COMMAND_TYPES as readonly string[]).includes(commandType ?? "");
}

export function hasBlockingExtensionCommand(
  commands: ExtensionCommandReference[],
  extensionId: string,
  extension: string,
  options: ExtensionCommandInterlockOptions = {},
) {
  return commands.some((command) =>
    !isReadOnlyTelephonyCommand(command.command_type) &&
    !isTerminalAcceptedBrowserTransferCommand(command, options.terminalBrowserTransferCallIds) &&
    (command.extension_id === extensionId || jsonContainsExactString(command.request_payload, extension)),
  );
}

export async function loadTerminalAcceptedBrowserTransferCallIds(
  client: SupabaseClient<Database>,
  organizationId: string,
  commands: ExtensionCommandReference[],
) {
  const callIds = [...new Set(commands
    .filter((command) => ["call.transfer.dtmf", "call.transfer.sip_refer"].includes(command.command_type ?? "") && command.status === "accepted")
    .map((command) => command.call_id)
    .filter((value): value is string => Boolean(value)))];
  if (callIds.length === 0) return new Set<string>();
  const result = await client
    .from("motorist_calls")
    .select("id, status")
    .eq("organization_id", organizationId)
    .eq("provider", "viptel")
    .in("id", callIds)
    .in("status", ["ended", "failed", "missed", "abandoned_queue"]);
  if (result.error) {
    throw new MutationError("Ukončenie staršieho prepojenia v prehliadači sa nepodarilo bezpečne overiť.", 500);
  }
  return new Set((result.data ?? []).map((call) => call.id));
}

function isTerminalAcceptedBrowserTransferCommand(
  command: ExtensionCommandReference,
  terminalCallIds: ReadonlySet<string> | undefined,
) {
  return ["call.transfer.dtmf", "call.transfer.sip_refer"].includes(command.command_type ?? "") &&
    command.status === "accepted" &&
    Boolean(command.call_id && terminalCallIds?.has(command.call_id));
}

function jsonContainsExactString(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value.trim() === expected;
  if (Array.isArray(value)) return value.some((item) => jsonContainsExactString(item, expected));
  if (!value || typeof value !== "object") return false;
  return Object.values(value).some((item) => jsonContainsExactString(item, expected));
}
