import { describe, expect, it } from "vitest";
import { directionsUrl } from "./maps";
describe("explicit case navigation", () => {
  it("encodes Slovak addresses into the fixed HTTPS directions URL", () => {
    const url = new URL(directionsUrl("  Bratislava, Námestie SNP 1  "));
    expect(url.origin).toBe("https://www.google.com"); expect(url.pathname).toBe("/maps/dir/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ api: "1", destination: "Bratislava, Námestie SNP 1", travelmode: "driving", dir_action: "navigate" });
  });
  it("never treats an address as URL scheme or query injection", () => {
    const address = "javascript:alert(1)&destination=https://evil.example/#x";
    const url = new URL(directionsUrl(address)); expect(url.origin).toBe("https://www.google.com"); expect(url.searchParams.get("destination")).toBe(address); expect(url.hash).toBe("");
  });
  it.each(["", "  ", "Bad\\nAddress", "á".repeat(500)])("rejects empty/control/oversized destinations %j", address => {
    expect(() => directionsUrl(address.replace("\\n", "\n"))).toThrow();
  });
});
