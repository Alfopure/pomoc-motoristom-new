import { beforeEach, expect, it, vi } from "vitest";
import { MutationError } from "@/server/mutation-error";
const mocks = vi.hoisted(() => ({ actor: vi.fn(), snapshot: vi.fn(), generate: vi.fn() }));
vi.mock("@/server/api-auth", () => ({ requireDefaultMotoristActor: mocks.actor }));
vi.mock("@/server/case-pdf", () => ({ loadCasePdfSnapshot: mocks.snapshot, generateCasePdf: mocks.generate }));
import { GET } from "./route";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ organizationId: "org", profileId: "actor" });
  mocks.snapshot.mockResolvedValue({ case: { case_number: 'PM\r\n"001' } });
  mocks.generate.mockResolvedValue(Buffer.from("%PDF-test"));
});
it("authorizes before export and returns private downloadable PDF with safe filename", async () => {
  const response = await GET(new Request("https://copy.test/api/cases/c/pdf"), { params: Promise.resolve({ id: "c" }) });
  expect(response.status).toBe(200);
  expect(mocks.snapshot).toHaveBeenCalledWith({ organizationId: "org", profileId: "actor" }, "c");
  expect(response.headers.get("Content-Type")).toBe("application/pdf");
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="PM___001.pdf"');
});
it("rejects anonymous requests before snapshot/browser work", async () => {
  mocks.actor.mockRejectedValue(new MutationError("Prihláste sa.", 401));
  const response = await GET(new Request("https://copy.test"), { params: Promise.resolve({ id: "c" }) });
  expect(response.status).toBe(401);
  expect(mocks.snapshot).not.toHaveBeenCalled();
  expect(mocks.generate).not.toHaveBeenCalled();
});
it("returns a generic no-store failure without source text or service errors", async () => {
  mocks.generate.mockRejectedValue(new Error("PRIVATE BODY"));
  const response = await GET(new Request("https://copy.test"), { params: Promise.resolve({ id: "c" }) });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("PRIVATE BODY");
  expect(response.headers.get("Cache-Control")).toContain("no-store");
});
