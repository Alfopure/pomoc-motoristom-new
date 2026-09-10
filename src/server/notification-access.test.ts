import { describe, expect, it } from "vitest";
import { notificationAudienceFilter } from "./notification-access";
const profile = "20000000-0000-0000-0000-000000000001";
describe("service-role notification audience", () => {
  it("includes only the actual recipient and explicitly shared historical team rows", () => {
    expect(notificationAudienceFilter(profile)).toBe(`visibility.eq.team,and(visibility.eq.private,recipient_profile_id.eq.${profile})`);
  });
  it.each([undefined, null, "", "id,visibility.eq.private", "profile-a"])("fails closed without a valid authenticated profile %s", (value) => {
    expect(notificationAudienceFilter(value)).toBe("visibility.eq.team");
  });
});
