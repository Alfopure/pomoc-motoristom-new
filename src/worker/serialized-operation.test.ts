import { describe, expect, it } from "vitest";

import { SerializedOperation } from "./serialized-operation";

describe("SerializedOperation", () => {
  it("commits a terminal operation only after the in-flight operation", async () => {
    const queue = new SerializedOperation();
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(async () => {
      await firstGate;
      writes.push("running");
    });
    const terminal = queue.run(async () => {
      writes.push("disabled");
    });

    await Promise.resolve();
    expect(writes).toEqual([]);
    releaseFirst();
    await Promise.all([first, terminal]);
    expect(writes).toEqual(["running", "disabled"]);
  });

  it("continues after an earlier operation fails", async () => {
    const queue = new SerializedOperation();
    const failed = queue.run(async () => {
      throw new Error("heartbeat failed");
    });
    const recovered = queue.run(async () => "disabled");

    await expect(failed).rejects.toThrow("heartbeat failed");
    await expect(recovered).resolves.toBe("disabled");
  });
});
