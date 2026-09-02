import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDispatchData } from "@/data/dispatch-repository";
import { updateCase } from "@/server/motorist-mutations";
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
