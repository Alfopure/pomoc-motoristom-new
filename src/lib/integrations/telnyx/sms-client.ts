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
import { getTelnyxConfig, type EnvRecord, type TelnyxConfig } from "@/server/telephony/telnyx/env";
import { TELNYX_MESSAGE_STATUS_MAP } from "@/server/telephony/telnyx/sms-status";

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
  preflight(input: { organizationId: string }): Promise<void>;
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

async function loadSmsSwitch(admin: AdminClient, organizationId: string) {
  const result = await admin
    .from("motorist_telephony_settings")
    .select("live_calls_enabled, sms_live_sends")
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (result.error) {
    throw new SmsWorkflowError(`Nastavenia telefónie sa nepodarilo načítať: ${result.error.message}`, 500);
  }

  return result.data ?? null;
}

export function createTelnyxSmsTransport(options: TelnyxSmsTransportOptions = {}): TelnyxSmsTransport {
  const config = options.config ?? getTelnyxConfig(options.env ?? process.env);

  async function resolveClient(organizationId: string): Promise<TelnyxClient> {
    if (!config.configured) {
      throw new SmsWorkflowError(SMS_NOT_CONFIGURED_MESSAGE, 503);
    }

    const admin = options.admin ?? createSupabaseAdminClient();
    const gate = resolveTelnyxLiveGate(config, await loadSmsSwitch(admin, organizationId));

    if (!gate.smsEnabled) {
      throw new SmsWorkflowError(SMS_SENDS_DISABLED_MESSAGE, 423);
    }

    return options.createClient
      ? options.createClient({ config, smsEnabled: gate.smsEnabled })
      : createTelnyxClient({ config, liveGate: gate, fetch: options.fetch });
  }

  return {
    /** Fails closed before the workflow writes an audit row for a blocked send. */
    async preflight(input) {
      await resolveClient(requireOrganizationId(input.organizationId));
    },

    async send(input: SmsTransportSendInput): Promise<SmsTransportSendResult> {
      const organizationId = requireOrganizationId(input.organizationId);
      const client = await resolveClient(organizationId);
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
