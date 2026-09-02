import { describe, expect, it } from "vitest";

import type { TelephonyOperatorPresence } from "@/lib/telephony/presence";
import { getQueueCoverage } from "./queue-coverage";

describe("queue coverage", () => {
  it("counts available operators across the complete dispatch plan", () => {
    const presences = [
      presence("one", ["500"], ["500"], true),
      presence("two", ["500"], [], false),
      presence("three", ["600"], ["600"], true),
    ];

    expect(
      getQueueCoverage(
        [
          {
            queue: "500",
            waitingCalls: 1,
            members: [
              { extension: "12", paused: false, inUse: false, dynamic: true, callsTaken: 0 },
              { extension: "13", paused: false, inUse: false, dynamic: true, callsTaken: 0 },
            ],
          },
          {
            queue: "600",
            waitingCalls: 0,
            members: [
              { extension: "14", paused: false, inUse: false, dynamic: true, callsTaken: 0 },
            ],
          },
        ],
        presences,
      ),
    ).toEqual({ available: 2, total: 3, waiting: 1, needsOperator: false });
  });

  it("does not count one extension twice when provider queues overlap", () => {
    expect(getQueueCoverage([
      {
        queue: "601",
        waitingCalls: 1,
        members: [{ extension: "20", paused: false, inUse: false, dynamic: true, callsTaken: 0 }],
      },
      {
        queue: "602",
        waitingCalls: 2,
        members: [{ extension: "20", paused: true, inUse: false, dynamic: true, callsTaken: 0 }],
      },
    ])).toEqual({ available: 1, total: 1, waiting: 3, needsOperator: false });
  });
});

function presence(
  profileId: string,
  queueNumbers: string[],
  availableQueues: string[],
  available: boolean,
): TelephonyOperatorPresence {
  return {
    profileId,
    operatorName: profileId,
    extensions: [],
    state: available ? "available" : "unregistered",
    available,
    queueMember: queueNumbers.length > 0,
    queueNumbers,
    availableQueues,
    paused: false,
    inUse: false,
    registered: available,
    detail: "",
  };
}
