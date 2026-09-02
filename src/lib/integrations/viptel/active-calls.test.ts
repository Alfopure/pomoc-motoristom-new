import { describe, expect, it } from "vitest";

import { extractActiveCalls } from "./client";

describe("VIPTel active call fixtures", () => {
  it("maps the documented caller and callee fields without swapping the destination", () => {
    const calls = extractActiveCalls({
      calls_active: "1",
      calls: [
        {
          caller: "3",
          caller_name: "Jan Novak",
          callee: "15",
          duration: "10",
          from_queue_unique_id: "1453373460.280",
          unique_id: "1453373466.289",
          status: "answered",
        },
      ],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      callerNumber: "3",
      callerName: "Jan Novak",
      calledNumber: "15",
      durationSeconds: 10,
      fromQueueUniqueId: "1453373460.280",
      status: "answered",
      viptelUniqueId: "1453373466.289",
    });
  });

  it("keeps composite queue-active states in the waiting lifecycle", () => {
    const [call] = extractActiveCalls({
      calls_active: "1",
      calls: [{ unique_id: "queue-1", caller: "0904123456", callee: "601", status: "queue_active" }],
    });

    expect(call?.status).toBe("ringing_agent");
  });
});
