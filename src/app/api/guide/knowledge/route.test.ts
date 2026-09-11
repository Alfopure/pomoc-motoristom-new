import { beforeEach, describe, expect, it, vi } from "vitest";
const io = vi.hoisted(() => ({ guard: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ motoristAccessGuard: io.guard }));
import { GET } from "./route";

beforeEach(() => io.guard.mockReset());
describe("guide knowledge export", () => {
  it("does not disclose documentation to an unauthenticated reader", async () => {
    io.guard.mockResolvedValue(new Response("Prihláste sa", { status: 401 }));
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Prihláste sa");
  });
  it("exports versioned citation records without claiming live configuration", async () => {
    io.guard.mockResolvedValue(null);
    const response = await GET();
    const result = await response.json();
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(result.dataKind).toBe("documentation");
    expect(result.verification.liveTelephonyVerified).toBe(false);
    expect(result.records.length).toBeGreaterThan(23);
    expect(result.records.every((record: { url: string; text: string }) => record.url.startsWith("/navod/") && record.text.length > 0)).toBe(true);
  });
});
