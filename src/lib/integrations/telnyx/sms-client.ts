import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { SMS_NOT_CONFIGURED_MESSAGE } from "@/lib/telephony/not-configured";
import { SmsWorkflowError, type SmsTransport, type SmsTransportSendInput, type SmsTransportSendResult } from "@/server/sms-workflow";
import {
  createTelnyxClient,
  resolveTelnyxLiveGate,
  SMS_SENDS_DISABLED_MESSAGE,
  TelnyxCommandError,
  type TelnyxClient,
} from "@/server/telephony/telnyx/client";
import { isDestinationAllowed } from "@/server/telephony/call-actions";
import { getTelnyxConfig, type EnvRecord, type TelnyxConfig } from "@/server/telephony/telnyx/env";
import { TELNYX_MESSAGE_STATUS_MAP } from "@/server/telephony/telnyx/sms-status";
import { addTelephonyUsage } from "@/server/telephony/usage";

/**
 * Telnyx implementation of the provider-neutral `SmsTransport`.
 *
 * `POST /v2/messages` with the alphanumeric sender (`TELNYX_SMS_ALPHA_SENDER`,
 * default `PomocMotor`) and the messaging profile from the environment. The
 * sender is send-only: Slovak alphanumeric senders cannot receive replies, so
 * there is no inbound SMS path (see `.context/telnyx-design.md` §1 non-goals).
 *
 * Two switches must both be on before a message leaves the process: the
 * environment switch `TELNYX_SMS_LIVE_SENDS` and the per-organisation row
 * `motorist_telephony_settings.sms_live_sends`. A missing settings row fails
 * closed. `preflight()` runs that check before the workflow writes any audit
 * row, `send()` re-checks it inside the Telnyx client itself.
 */

type AdminClient = SupabaseClient<Database>;

export type TelnyxSmsTransportOptions = {
  admin?: AdminClient;
  config?: TelnyxConfig;
  env?: EnvRecord;
  /** Test seam; defaults to `createTelnyxClient` with the resolved live gate. */
  createClient?: (options: { config: TelnyxConfig; smsEnabled: boolean }) => TelnyxClient;
  fetch?: typeof fetch;
};

export type TelnyxSmsTransport = SmsTransport & {
  preflight(input: { organizationId: string; to?: string }): Promise<void>;
};

/** Telnyx recipient status -> the three states the workflow persists. */
export function mapTelnyxSendStatus(providerStatus: string | null): SmsTransportSendResult["status"] {
  const mapped = providerStatus ? TELNYX_MESSAGE_STATUS_MAP[providerStatus] : undefined;
  if (mapped === "failed") return "failed";
  if (mapped === "sent" || mapped === "delivered") return "sent";
  return "queued";
}

/** Telnyx command failures become workflow errors with a Slovak message. */
export function smsErrorFromTelnyx(error: unknown): SmsWorkflowError {
  if (error instanceof SmsWorkflowError) return error;

  if (error instanceof TelnyxCommandError) {
    if (error.code === "sms_disabled") return new SmsWorkflowError(SMS_SENDS_DISABLED_MESSAGE, 423);
    const detail = error.detail ?? error.title ?? error.code;
    if (error.status === 429) return new SmsWorkflowError(`SMS sa nepodarilo odoslať (limit poskytovateľa): ${detail}`, 429);
    if (error.status === 400 || error.status === 404 || error.status === 422) {
      return new SmsWorkflowError(`SMS poskytovateľ odmietol správu: ${detail}`, 400);
    }
    return new SmsWorkflowError(`SMS sa nepodarilo odoslať: ${detail}`, 502);
  }

  return new SmsWorkflowError(error instanceof Error ? error.message : "SMS odoslanie zlyhalo.", 502);
}

async function loadSmsSettings(admin: AdminClient, organizationId: string) {
  const result = await admin
    .from("motorist_telephony_settings")
    .select("live_calls_enabled, sms_live_sends, destination_allowlist")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (result.error) {
    throw new SmsWorkflowError(`Nastavenia telefónie sa nepodarilo načítať: ${result.error.message}`, 500);
  }

  return result.data ?? null;
}

/** Per-organisation send ceiling; the in-memory bucket is per lambda, the usage row is shared. */
export const SMS_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;
const smsBuckets = new Map<string, { count: number; resetAt: number }>();

/** Read-only view of the bucket: `preflight` must not consume an attempt. */
function smsRateLimitAvailable(organizationId: string, now: number): boolean {
  const bucket = smsBuckets.get(organizationId);
  return !bucket || bucket.resetAt <= now || bucket.count < SMS_RATE_LIMIT.limit;
}

function hitSmsRateLimit(organizationId: string, now: number): boolean {
  const bucket = smsBuckets.get(organizationId);
  if (!bucket || bucket.resetAt <= now) {
    smsBuckets.set(organizationId, { count: 1, resetAt: now + SMS_RATE_LIMIT.windowMs });
    return true;
  }
  if (bucket.count >= SMS_RATE_LIMIT.limit) return false;
  bucket.count += 1;
  return true;
}

/** Test seam: the bucket is module state. */
export function resetSmsRateLimit(): void {
  smsBuckets.clear();
}

export function createTelnyxSmsTransport(options: TelnyxSmsTransportOptions = {}): TelnyxSmsTransport {
  const config = options.config ?? getTelnyxConfig(options.env ?? process.env);

  async function resolveClient(organizationId: string): Promise<{ client: TelnyxClient; admin: AdminClient; allowlist: string[] | null }> {
    if (!config.configured) {
      throw new SmsWorkflowError(SMS_NOT_CONFIGURED_MESSAGE, 503);
    }

    const admin = options.admin ?? createSupabaseAdminClient();
    const settings = await loadSmsSettings(admin, organizationId);
    const gate = resolveTelnyxLiveGate(config, settings);

    if (!gate.smsEnabled) {
      throw new SmsWorkflowError(SMS_SENDS_DISABLED_MESSAGE, 423);
    }

    const client = options.createClient ? options.createClient({ config, smsEnabled: gate.smsEnabled }) : createTelnyxClient({ config, liveGate: gate, fetch: options.fetch });
    return { client, admin, allowlist: settings?.destination_allowlist ?? null };
  }

  return {
    /**
     * Fails closed before the workflow writes an audit row for a blocked send:
     * kill switches, the destination allowlist and the rate limit (peeked, not
     * consumed — `send` counts the message). `send` re-checks all three.
     */
    async preflight(input) {
      const organizationId = requireOrganizationId(input.organizationId);
      const { allowlist } = await resolveClient(organizationId);
      if (input.to && !isDestinationAllowed(input.to, allowlist)) {
        throw new SmsWorkflowError("Cieľové číslo nie je povolené (allowlist).", 403);
      }
      if (!smsRateLimitAvailable(organizationId, Date.now())) {
        throw new SmsWorkflowError("Príliš veľa SMS za minútu.", 429);
      }
    },

    async send(input: SmsTransportSendInput): Promise<SmsTransportSendResult> {
      const organizationId = requireOrganizationId(input.organizationId);
      const { client, admin, allowlist } = await resolveClient(organizationId);
      // The same allowlist that guards voice: a mistyped international recipient
      // is premium-rate traffic with no ceiling otherwise.
      if (!isDestinationAllowed(input.to, allowlist)) {
        throw new SmsWorkflowError("Cieľové číslo nie je povolené (allowlist).", 403);
      }
      if (!hitSmsRateLimit(organizationId, Date.now())) {
        throw new SmsWorkflowError("Príliš veľa SMS za minútu.", 429);
      }
      const from = client.config.smsAlphaSender;
      const messagingProfileId = client.config.messagingProfileId;

      try {
        const message = await client.sendMessage({
          to: input.to,
          text: input.body,
          from,
          messagingProfileId: messagingProfileId ?? undefined,
          idempotencyKey: input.idempotencyKey,
        });

        await addTelephonyUsage(admin, { organizationId, sms: 1 });

        return {
          providerMessageId: message.id,
          status: mapTelnyxSendStatus(message.status),
          providerStatus: message.status,
          fromSender: from,
          messagingProfileId,
        };
      } catch (error) {
        throw smsErrorFromTelnyx(error);
      }
    },
  };
}

function requireOrganizationId(organizationId: string | undefined | null): string {
  const value = organizationId?.trim();
  if (!value) {
    throw new SmsWorkflowError("Odosielateľa SMS sa nepodarilo priradiť k organizácii.", 500);
  }
  return value;
}
