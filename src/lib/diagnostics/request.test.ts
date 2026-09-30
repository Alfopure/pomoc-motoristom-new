import { afterEach, describe, expect, it, vi } from "vitest";
const finish = vi.hoisted(() => vi.fn());
vi.mock("./client", () => ({ beginDiagnosticOperation: () => finish }));
import { diagnosticJson } from "./request";

afterEach(() => { vi.unstubAllGlobals(); finish.mockClear(); });
describe("explicit operation response validation", () => {
  it("preserves malformed business responses and marks an unconfirmed write as unknown", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetch);
    const result = await diagnosticJson<{ committed?: boolean }>("case.create", "cases", "/api/cases", { method: "POST" }, {}, body => body.committed === true);
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({});
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("keeps confirmed write/refresh failure distinct from an absent response field", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ refreshRequired: true }));
    await diagnosticJson<{ detail?: object }>("case.save", "cases", "/api/cases/fixture", { method: "PATCH" }, {}, body => !!body.detail);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "committed_refresh_failed" }));
  });
  it("does not let a diagnostic validator throw into the business caller", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ value: "preserved" }));
    const result = await diagnosticJson("case.open", "cases", "/api/cases/fixture", undefined, {}, () => { throw new Error("observer failed"); });
    expect(result.body).toEqual({ value: "preserved" });
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ outcome: "unknown" }));
  });
});
