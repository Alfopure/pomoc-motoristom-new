import { describe, expect, it } from "vitest";

import { transcriptTurns } from "./transcript";

describe("transcriptTurns", () => {
  it("joins consecutive fragments from the same speaker", () => {
    const turns = transcriptTurns([
      { ms: 900, dir: "out", text: "Dobrý deň," },
      { ms: 1_100, dir: "out", text: " tu je Veronika." },
      { ms: 2_400, dir: "in", text: "áno" },
    ]);
    expect(turns).toEqual([
      { ms: 900, dir: "out", text: "Dobrý deň, tu je Veronika." },
      { ms: 2_400, dir: "in", text: "áno" },
    ]);
  });

  it("ignores anything that is not a usable fragment", () => {
    expect(transcriptTurns([{ ms: 1, dir: "sideways", text: "x" }, { ms: 2, dir: "in" }, null, "text"])).toEqual([]);
    expect(transcriptTurns(null)).toEqual([]);
    expect(transcriptTurns("not an array")).toEqual([]);
  });

  it("drops a turn that is only whitespace", () => {
    expect(transcriptTurns([{ ms: 1, dir: "out", text: "   " }])).toEqual([]);
  });
});
