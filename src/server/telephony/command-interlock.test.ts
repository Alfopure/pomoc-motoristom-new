import { describe, expect, it } from "vitest";

import {
  hasBlockingExtensionCommand,
  isReadOnlyTelephonyCommand,
} from "./command-interlock";

const extensionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("telephony command interlocks", () => {
  it("never treats a read-only provider snapshot as an extension mutation", () => {
    const snapshot = {
      command_type: "provider.snapshot",
      extension_id: extensionId,
      request_payload: {
        personalExtensions: ["20", "21", "22", "23"],
      },
    };

    expect(isReadOnlyTelephonyCommand(snapshot.command_type)).toBe(true);
    expect(hasBlockingExtensionCommand([snapshot], extensionId, "20")).toBe(false);
  });

  it("continues to block every mutating or unknown command that references the extension", () => {
    expect(hasBlockingExtensionCommand([{
      command_type: "call.hangup",
      extension_id: extensionId,
      request_payload: {},
    }], extensionId, "20")).toBe(true);
    expect(hasBlockingExtensionCommand([{
      command_type: "future.mutation",
      extension_id: null,
      request_payload: { destination: { extension: "20" } },
    }], extensionId, "20")).toBe(true);
  });

  it("matches extension values exactly instead of by substring", () => {
    expect(hasBlockingExtensionCommand([{
      command_type: "call.create",
      extension_id: null,
      request_payload: { destination: "120" },
    }], extensionId, "20")).toBe(false);
  });

  it("releases only an accepted DTMF intent whose call is independently terminal", () => {
    const command = {
      call_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      command_type: "call.transfer.dtmf",
      extension_id: extensionId,
      request_payload: { destination: "20" },
      status: "accepted",
    };

    expect(hasBlockingExtensionCommand([command], extensionId, "20")).toBe(true);
    expect(hasBlockingExtensionCommand([command], extensionId, "20", {
      terminalBrowserTransferCallIds: new Set([command.call_id]),
    })).toBe(false);
    expect(hasBlockingExtensionCommand([{ ...command, status: "sent" }], extensionId, "20", {
      terminalBrowserTransferCallIds: new Set([command.call_id]),
    })).toBe(true);
  });

  it("also releases an accepted browser SIP transfer whose call is independently terminal", () => {
    const command = {
      call_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      command_type: "call.transfer.sip_refer",
      extension_id: extensionId,
      request_payload: { destination: "21" },
      status: "accepted",
    };

    expect(hasBlockingExtensionCommand([command], extensionId, "20")).toBe(true);
    expect(hasBlockingExtensionCommand([command], extensionId, "20", {
      terminalBrowserTransferCallIds: new Set([command.call_id]),
    })).toBe(false);
  });
});
