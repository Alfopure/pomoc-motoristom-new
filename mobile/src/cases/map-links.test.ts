import { describe, expect, it, vi } from "vitest";
import { attributionUrl, confirmAttribution } from "./map-links";
describe("explicit Google attribution navigation", () => {
  it.each(["https://maps.google.com/maps?ll=0,0&z=12", "https://www.google.com/intl/sk/help/terms_maps.html", "https://policies.google.com/privacy?hl=sk", "https://policies.google.com/terms"])("allows known HTTPS link %s", value => { expect(attributionUrl(value)).not.toBeNull(); });
  it.each(["http://www.google.com/maps", "https://www.google.com.attacker.invalid/maps", "https://user:secret@www.google.com/maps", "https://www.google.com:444/maps", "https://www.google.com/url?url=https://foreign.invalid", "https://www.google.com/maps?redirect=https://foreign.invalid", "https://policies.google.com/privacy?token=private", "https://policies.google.com/%70rivacy", "javascript:alert(1)"])("denies untrusted link without prompting %s", value => {
    const confirm = vi.fn(); expect(confirmAttribution(value, { current: () => true, confirm, open: vi.fn(), failed: vi.fn() })).toBe(false); expect(confirm).not.toHaveBeenCalled();
  });
  it("does not open before confirmation, after cancel or after scope disposal", async () => {
    let proceed!: () => void, current = true; const open = vi.fn(async () => {}), confirm = vi.fn(callback => { proceed = callback; });
    confirmAttribution("https://policies.google.com/privacy", { current: () => current, confirm, open, failed: vi.fn() });
    expect(open).not.toHaveBeenCalled(); current = false; proceed(); expect(open).not.toHaveBeenCalled();
    current = true; confirmAttribution("https://policies.google.com/privacy", { current: () => current, confirm, open, failed: vi.fn() }); proceed();
    expect(open).toHaveBeenCalledExactlyOnceWith("https://policies.google.com/privacy");
  });
});
