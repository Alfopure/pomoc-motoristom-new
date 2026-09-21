import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));
vi.mock("@/data/dispatch-repository", () => ({ loadDispatchNotifications: vi.fn(), mapCase: vi.fn() }));
import { caseDraftPreviewBody, loadCaseDraftPreview, publishCaseDraftPreview } from "./case-draft-preview";
import { draftPreviewGroups, MAX_DRAFT_PREVIEW_BYTES } from "@/domain/case-draft-preview";
import type { MotoristActor } from "./api-auth";

const actor = { organizationId: "server-org", profileId: "server-profile", displayName: "Server name", role: "dispatcher" } as MotoristActor;
const sessionId = "00000000-0000-4000-8000-000000000001";
const preview = { version: 1, fields: { contacts: "Jana Nováková", plate: "BA123XY" } };
const snapshot = { available: true, preview, sequence: 2, updatedAt: "2026-09-21T11:00:00Z", expiresAt: "2026-09-21T11:01:00Z", displayName: "Colleague" };
const request = (body: string) => new Request("https://example.test/api/cases/drafts/session", { method: "PUT", body });

describe("case draft preview boundary", () => {
  it("derives identities on the server and validates the returned projection", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: snapshot, error: null });
    expect(await publishCaseDraftPreview(actor, sessionId, { sequence: 2, preview }, undefined, { rpc })).toEqual(snapshot);
    expect(rpc).toHaveBeenCalledExactlyOnceWith("motorist_case_draft_preview", {
      p_organization_id: "server-org", p_actor_profile_id: "server-profile", p_session_id: sessionId,
      p_action: "publish", p_input: { sequence: 2, preview },
    });
    await loadCaseDraftPreview(actor, sessionId, undefined, { rpc });
    expect(rpc).toHaveBeenLastCalledWith("motorist_case_draft_preview", expect.objectContaining({ p_action: "read", p_input: {} }));
  });

  it.each([
    { sequence: 2, preview, organizationId: "other" },
    { sequence: 2, preview, profileId: "other" },
    { sequence: 2, preview, sessionId: "other" },
    { sequence: 2, preview: { version: 1, fields: { vehicleLookup: "proof" } } },
    { sequence: 2, preview: { version: 1, fields: { note: "a".repeat(4001) } } },
    { sequence: 0, preview }, { sequence: 1.5, preview }, { sequence: Number.MAX_SAFE_INTEGER + 1, preview },
    { sequence: "2", preview }, { sequence: 2, preview: [] },
  ])("rejects forged identity, unknown content and invalid sequence before RPC", async input => {
    const rpc = vi.fn();
    await expect(publishCaseDraftPreview(actor, sessionId, input, undefined, { rpc })).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects invalid session IDs before querying any content", async () => {
    const rpc = vi.fn();
    await expect(loadCaseDraftPreview(actor, "not-a-session", undefined, { rpc })).rejects.toMatchObject({ status: 400 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["PGRST202", "42883", "42P01"])("supports an unapplied additive migration without exposing content (%s)", async code => {
    const rpc = vi.fn().mockResolvedValue({ data: snapshot, error: { code } });
    expect(await loadCaseDraftPreview(actor, sessionId, undefined, { rpc })).toEqual({ available: false, preview: null, sequence: 0, updatedAt: null, expiresAt: "", displayName: "" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it.each([["42501", 403], ["P0002", 404], ["22023", 400], ["unexpected", 503]] as const)("maps %s without leaking database text", async (code, status) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code, message: "Sensitive server details" } });
    await expect(loadCaseDraftPreview(actor, sessionId, undefined, { rpc })).rejects.toMatchObject({ status });
  });

  it.each([
    null, { ...snapshot, preview: { version: 1, fields: { internalToken: "secret" } } },
    { ...snapshot, sequence: -1 }, { ...snapshot, expiresAt: "invalid" },
    { ...snapshot, preview: null }, { ...snapshot, updatedAt: null },
  ])("fails closed for malformed RPC content", async data => {
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    await expect(loadCaseDraftPreview(actor, sessionId, undefined, { rpc })).rejects.toMatchObject({ status: 503 });
  });

  it("discards a response if the viewer closes the request in flight", async () => {
    const controller = new AbortController();
    const rpc = vi.fn().mockImplementation(async () => { controller.abort(); return { data: snapshot, error: null }; });
    await expect(loadCaseDraftPreview(actor, sessionId, controller.signal, { rpc })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("parses UTF-8 safely and bounds the incoming request before JSON decoding", async () => {
    expect(await caseDraftPreviewBody(request(JSON.stringify({ sequence: 2, preview })))).toEqual({ sequence: 2, preview });
    await expect(caseDraftPreviewBody(request("ž".repeat(MAX_DRAFT_PREVIEW_BYTES)))).rejects.toMatchObject({ status: 413 });
    await expect(caseDraftPreviewBody(request("{"))).rejects.toMatchObject({ status: 400 });
    await expect(caseDraftPreviewBody(request("[]"))).rejects.toMatchObject({ status: 400 });
  });

  it("keeps the database field allowlist aligned with the public projection", () => {
    const sql = readFileSync(new URL("../../supabase/migrations/20261007110000_case_draft_preview.sql", import.meta.url), "utf8");
    const allowed = sql.match(/f\.key not in \(([\s\S]*?)\n\s*\)/)?.[1];
    expect(allowed).toBeDefined();
    const keys = [...allowed!.matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(keys.sort()).toEqual(draftPreviewGroups.flatMap(group => Object.keys(group.fields)).sort());
  });
});
