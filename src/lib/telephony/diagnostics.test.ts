import { describe, expect, it } from "vitest";
import { telephonyRequestDiagnostic, webphoneDiagnostic } from "./diagnostics";

const session = "00000000-0000-4000-8000-000000000001";
describe("phone diagnostics boundary", () => {
  it("discards provider payloads and unverified identifiers", () => {
    expect(webphoneDiagnostic({ event: "disconnect", reason: "component_unmount", callSessionId: session,
      deviceSessionId: "not-a-uuid", token: "secret", phone: "+421900111222", message: "private", sdp: "private" })).toEqual({
      type: "phone_lifecycle", module: "telephony", outcome: "ok", reason: "component_unmount", callSessionId: session,
    });
    expect(webphoneDiagnostic({ message: "private", event: "sdk_payload" })).toBeNull();
  });

  it("measures explicit controls but never the existing snapshot/heartbeat polling", () => {
    expect(telephonyRequestDiagnostic(`/api/telephony/calls/${session}/pickup`, "POST")).toEqual({ operation: "call.pickup", callSessionId: session });
    expect(telephonyRequestDiagnostic(`/api/telephony/calls/${session}/hangup`, "POST")?.operation).toBe("call.hangup");
    expect(telephonyRequestDiagnostic("/api/telephony/calls/active")).toBeNull();
    expect(telephonyRequestDiagnostic("/api/telephony/webphone/heartbeat", "POST")).toBeNull();
    expect(telephonyRequestDiagnostic(`/api/telephony/calls/${session}/reconcile`, "POST")).toBeNull();
  });
});
