import { describe, expect, it } from "vitest";
import { canReplyToSms, getSmsChannel, smsSender } from "./sms-channel";
const org = "11111111-1111-4111-8111-111111111111";
const env = { TELNYX_API_KEY: "test", TELNYX_PUBLIC_KEY: "test-public-key", TELNYX_MESSAGING_PROFILE_ID: "profile", TELNYX_SMS_FROM_NUMBER: "+12025550123", TELNYX_SMS_ORGANIZATION_ID: org };
describe("numeric SMS channel activation", () => {
  it("requires an explicit number, organization and messaging profile", () => {
    expect(getSmsChannel({ TELNYX_API_KEY: "key" })).toBeNull();
    expect(getSmsChannel({ ...env, TELNYX_SMS_FROM_NUMBER: "PomocMotor" })).toBeNull();
    expect(getSmsChannel({ ...env, TELNYX_SMS_ORGANIZATION_ID: "" })).toBeNull();
    expect(getSmsChannel({ ...env, TELNYX_PUBLIC_KEY: "" })).toBeNull();
  });
  it("keeps ordinary traffic one-way while one designated recipient verifies the number", () => {
    const pilot = { ...env, TELNYX_SMS_TEST_RECIPIENT: "+421905123456" };
    expect(smsSender(org, "+421905123456", pilot)).toEqual({ sender: "+12025550123", repliesEnabled: false, repliesPendingVerification: true });
    expect(smsSender(org, "+421905999999", pilot).sender).toBe("PomocMotor");
    expect(smsSender("another-org", "+421905123456", pilot).sender).toBe("PomocMotor");
    expect(smsSender(org, null, pilot).repliesEnabled).toBe(false);
  });
  it("enables the same-number reply only for this organization, profile and tested channel", () => {
    const config = { ...env, TELNYX_SMS_REPLIES_VERIFIED: "true" };
    const channel = getSmsChannel(config);
    expect(smsSender(org, "+421905123456", config).repliesEnabled).toBe(true);
    expect(canReplyToSms(channel, org, "+12025550123", "+421905123456", "profile")).toBe(true);
    expect(canReplyToSms(channel, org, "+12025550124", "+421905123456", "profile")).toBe(false);
    expect(canReplyToSms(channel, org, "+12025550123", "+421905123456", "other-profile")).toBe(false);
    expect(canReplyToSms(getSmsChannel(env), org, "+12025550123", "+421905123456", "profile")).toBe(false);
  });
});
