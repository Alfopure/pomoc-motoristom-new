import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  assertWorkplaceAdminTakeoverEnabled,
  assertTelephonyLiveMutationEnabled,
  telephonyLiveMutationGateStatus,
  workplaceAdminTakeoverGateStatus,
} from "./live-mutation-gate";

const authority = "a".repeat(32);

describe("telephony live-mutation gate", () => {
  it("is disabled by default", () => {
    expect(telephonyLiveMutationGateStatus({})).toEqual({
      enabled: false,
      reason: "flag_disabled",
    });
    expect(() => assertTelephonyLiveMutationEnabled("queue.add", {})).toThrow(
      "Telekomunikačné zásahy nie sú pre toto prostredie výslovne povolené.",
    );
  });

  it("requires both the explicit flag and an authority token", () => {
    expect(telephonyLiveMutationGateStatus({ VIPTEL_LIVE_MUTATIONS_ENABLED: "true" })).toEqual({
      enabled: false,
      reason: "authority_missing",
    });
    expect(telephonyLiveMutationGateStatus({
      VIPTEL_LIVE_MUTATIONS_ENABLED: "true",
      VIPTEL_LIVE_MUTATION_TOKEN: "a".repeat(31),
    })).toEqual({ enabled: false, reason: "authority_missing" });
    expect(telephonyLiveMutationGateStatus({
      VIPTEL_LIVE_MUTATIONS_ENABLED: "true",
      VIPTEL_LIVE_MUTATION_TOKEN: "replace-me",
    })).toEqual({ enabled: false, reason: "authority_missing" });
    expect(telephonyLiveMutationGateStatus({
      VIPTEL_LIVE_MUTATIONS_ENABLED: "true",
      VIPTEL_LIVE_MUTATION_TOKEN: authority,
    })).toEqual({ enabled: true, reason: "enabled" });
  });

  it("always blocks Vercel Preview even if production authority was copied there", () => {
    const env = {
      VERCEL_ENV: "preview",
      VIPTEL_LIVE_MUTATIONS_ENABLED: "true",
      VIPTEL_LIVE_MUTATION_TOKEN: authority,
    };
    expect(telephonyLiveMutationGateStatus(env)).toEqual({
      enabled: false,
      reason: "preview_blocked",
    });
    expect(() => assertTelephonyLiveMutationEnabled("presence.sync", env)).toThrow(
      "Preview používa produkčné dáta",
    );
  });

  it("is not bypassed by the isolated development auth bypass", () => {
    expect(telephonyLiveMutationGateStatus({
      MOTORIST_DEV_AUTH_BYPASS: "true",
      NODE_ENV: "development",
    })).toEqual({ enabled: false, reason: "flag_disabled" });
  });

  it("keeps administrative workplace takeover behind an independent default-off flag", () => {
    const live = {
      VIPTEL_LIVE_MUTATIONS_ENABLED: "true",
      VIPTEL_LIVE_MUTATION_TOKEN: authority,
    };
    expect(workplaceAdminTakeoverGateStatus(live)).toEqual({
      enabled: false,
      reason: "takeover_flag_disabled",
    });
    expect(() => assertWorkplaceAdminTakeoverEnabled("workplace.takeover", live)).toThrow("zatiaľ nie je");
    expect(workplaceAdminTakeoverGateStatus({
      ...live,
      VIPTEL_WORKPLACE_ADMIN_TAKEOVER_ENABLED: "true",
    })).toEqual({ enabled: true, reason: "enabled" });
  });
});
