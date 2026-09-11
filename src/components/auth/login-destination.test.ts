import { describe, expect, it } from "vitest";
import { loginDestination } from "./login-destination";

describe("loginDestination", () => {
  it("preserves a server-selected guide chapter and its step after sign-in", () => {
    expect(loginDestination("https://copy.example/navod/plany-zvonenia#poradie", "/navod/plany-zvonenia")).toBe("/navod/plany-zvonenia#poradie");
  });
  it("preserves existing task links and ignores arbitrary redirect input", () => {
    expect(loginDestination("https://copy.example/?task=task-1&redirect=https://other.example")).toBe("/?task=task-1");
    for (const invalid of ["https://other.example", "//other.example", "/navod/../api", "/navod?redirect=x", "/navod/\\other.example"]) {
      expect(loginDestination("https://copy.example/", invalid)).toBe("/");
    }
  });
});
