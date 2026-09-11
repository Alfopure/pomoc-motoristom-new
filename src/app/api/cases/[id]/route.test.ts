import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDispatchData } from "@/data/dispatch-repository";
import { updateCase } from "@/server/motorist-mutations";
import { commitAtomicCaseSave } from "@/server/case-atomic-save";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { GET, PATCH } from "./route";

vi.mock("@/data/dispatch-repository", () => ({
  loadDispatchData: vi.fn(),
}));

vi.mock("@/server/api-auth", () => ({
  assertSameOriginRequest: vi.fn(),
  requireDefaultMotoristOrgMember: vi.fn(),
  requireDefaultMotoristActor: vi.fn(async () => ({
    userId: "user-1",
    profileId: "profile-1",
    organizationId: "org-1",
    displayName: "Test Dispečer",
    role: "dispatcher",
  })),
}));

vi.mock("@/server/motorist-mutations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/motorist-mutations")>();

  return {
    ...actual,
    updateCase: vi.fn(),
  };
});

const mockedLoadDispatchData = vi.mocked(loadDispatchData);
const mockedUpdateCase = vi.mocked(updateCase);

describe("case update route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockedLoadDispatchData.mockReset();
    mockedUpdateCase.mockReset();
  });

  it.each(["PT409", "40001"])("returns one HTTP 409 with the draft-preserving conflict code for SQL %s", async code => {
    const rpc = vi.fn(async () => ({ data: null, error: { code, message: "Private database detail" } }));
    mockedUpdateCase.mockImplementation(async () => {
      await commitAtomicCaseSave({ rpc } as unknown as SupabaseClient<Database>, {
        organizationId: "org-1", actorId: "profile-1", caseId: "case-1", expectedUpdatedAt: "2026-09-10T11:00:00Z",
        casePatch: { priority: "urgent" }, related: [], fieldLabels: {},
      });
      throw new Error("Conflicting save must not succeed");
    });
    const response = await PATCH(new Request("https://example.test/api/cases/case-1", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: "urgent", expectedUpdatedAt: "2026-09-10T11:00:00Z" }),
    }), { params: Promise.resolve({ id: "case-1" }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "CASE_REVISION_CONFLICT",
      error: "Prípad medzitým zmenil iný používateľ. Načítajte aktuálny stav; vaše zmeny zostávajú v editore.",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(mockedUpdateCase).toHaveBeenCalledTimes(1);
    expect(mockedLoadDispatchData).not.toHaveBeenCalled();
  });

  it("returns the canonical dispatch state with the mutation acknowledgement", async () => {
    const dispatchData = { source: "supabase" };
    mockedUpdateCase.mockResolvedValue({
      caseRow: { id: "case-1" },
      warnings: [],
    } as unknown as Awaited<ReturnType<typeof updateCase>>);
    mockedLoadDispatchData.mockResolvedValue(dispatchData as Awaited<ReturnType<typeof loadDispatchData>>);

    const response = await PATCH(
      new Request("https://example.test/api/cases/case-1", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify({ licensePlate: "BA-123XY" }),
      }),
      { params: Promise.resolve({ id: "case-1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ caseId: "case-1", dispatchData, warnings: [] });
    expect(mockedLoadDispatchData).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a committed update without inviting a duplicate PATCH when refresh falls back", async () => {
    mockedUpdateCase.mockResolvedValue({
      caseRow: { id: "case-1" },
      warnings: [],
    } as unknown as Awaited<ReturnType<typeof updateCase>>);
    mockedLoadDispatchData.mockResolvedValue({
      source: "mock",
    } as Awaited<ReturnType<typeof loadDispatchData>>);

    const response = await PATCH(
      new Request("https://example.test/api/cases/case-1", {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "https://example.test",
        },
        body: JSON.stringify({ licensePlate: "BA-123XY" }),
      }),
      { params: Promise.resolve({ id: "case-1" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      caseId: "case-1",
      refreshRequired: true,
      warnings: [],
    });
    expect(mockedUpdateCase).toHaveBeenCalledTimes(1);
  });

  it("loads the current dispatch state through a separate safe read", async () => {
    const dispatchData = { source: "supabase" };
    mockedLoadDispatchData.mockResolvedValue(dispatchData as Awaited<ReturnType<typeof loadDispatchData>>);

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ dispatchData });
    expect(mockedLoadDispatchData).toHaveBeenCalledTimes(1);
    expect(mockedUpdateCase).not.toHaveBeenCalled();
  });

  it("rejects mock fallback data during save reconciliation", async () => {
    mockedLoadDispatchData.mockResolvedValue({
      source: "mock",
    } as Awaited<ReturnType<typeof loadDispatchData>>);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Aktuálny stav karty sa nepodarilo spoľahlivo načítať.",
    });
    expect(mockedLoadDispatchData).toHaveBeenCalledTimes(1);
  });
});
