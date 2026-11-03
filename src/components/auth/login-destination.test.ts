import { describe, expect, it } from "vitest";
import { loginDestination } from "./login-destination";

describe("loginDestination", () => {
  it("accepts only the two explicit towing entries", () => {
    expect(loginDestination("https://app.example/vodic", "/vodic")).toBe("/vodic");
    expect(loginDestination("https://app.example/zakazky", "/zakazky")).toBe("/zakazky");
    expect(loginDestination("https://app.example/", "/vodic?next=https://other.example")).toBe("/");
  });
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

it('preserves validated case deep links and explicit partner workspace only',()=>{
 expect(loginDestination('https://app.example/?case=10000000-0000-4000-8000-000000000001')).toBe('/?case=10000000-0000-4000-8000-000000000001');
 expect(loginDestination('https://app.example/?case=//outside.example')).toBe('/');
 expect(loginDestination('https://app.example/partner','/partner')).toBe('/partner');
 expect(loginDestination('https://app.example/','/partner?org=other')).toBe('/');
});
