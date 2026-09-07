import "server-only";
import { getTelnyxConfig, TELNYX_DEFAULT_ALPHA_SENDER, type EnvRecord, type TelnyxConfig } from "@/server/telephony/telnyx/env";

export type SmsChannel = {
  organizationId: string;
  number: string;
  messagingProfileId: string;
  verified: boolean;
  testRecipient: string | null;
};

/** The receiving number is bound to one organization and one environment's profile. */
export function getSmsChannel(env: EnvRecord = process.env, config: TelnyxConfig = getTelnyxConfig(env)): SmsChannel | null {
  const organizationId = env.TELNYX_SMS_ORGANIZATION_ID?.trim() ?? "";
  const number = env.TELNYX_SMS_FROM_NUMBER?.trim() ?? "";
  const testRecipient = env.TELNYX_SMS_TEST_RECIPIENT?.trim() ?? "";
  if (!config.configured || !config.messagingProfileId || !config.publicKey
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)
    || !/^\+[1-9]\d{6,14}$/.test(number)) return null;
  return {
    organizationId, number, messagingProfileId: config.messagingProfileId,
    verified: env.TELNYX_SMS_REPLIES_VERIFIED?.trim().toLowerCase() === "true",
    testRecipient: /^\+[1-9]\d{6,14}$/.test(testRecipient) ? testRecipient : null,
  };
}

export function smsSender(organizationId: string, to: string | null, env: EnvRecord = process.env, config = getTelnyxConfig(env)) {
  const channel = getSmsChannel(env, config);
  const useNumber = channel?.organizationId === organizationId && (channel.verified || (to != null && channel.testRecipient === to));
  return {
    sender: useNumber ? channel.number : config.configured ? config.smsAlphaSender : TELNYX_DEFAULT_ALPHA_SENDER,
    repliesEnabled: Boolean(useNumber && channel.verified),
    repliesPendingVerification: Boolean(useNumber && !channel.verified),
  };
}

export function canReplyToSms(channel: SmsChannel | null, organizationId: string, local: string, remote: string, profile: string | null) {
  return Boolean(channel && channel.organizationId === organizationId && channel.number === local
    && channel.messagingProfileId === profile && (channel.verified || channel.testRecipient === remote));
}
