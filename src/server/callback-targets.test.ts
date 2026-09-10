import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { approveCallbackTarget, resolveCallbackTarget, saveCallbackPolicy } from "./callback-targets";
import type { MotoristActor } from "./api-auth";
const org = "10000000-0000-0000-0000-000000000001";
const contact = "30000000-0000-0000-0000-000000000001";
const target = "30000000-0000-0000-0000-000000000002";
const actor = { profileId: "20000000-0000-0000-0000-000000000001", organizationId: org, role: "admin" } as MotoristActor;
describe("callback target service", () => {
  it("preserves outgoing calls only when the resolver migration is absent", async () => {
    const { admin, db } = createFakeSupabase();
    expect(await resolveCallbackTarget(admin, org, "0900 123 456")).toMatchObject({ status: "original", dialNumber: "0900 123 456" });
    for (const code of ["42501", "PGRST000", "XX000", "42883"]) {
      db.registerRpc("motorist_resolve_callback_target", () => { throw { code, message: "failure" }; });
      await expect(resolveCallbackTarget(admin, org, "0900 123 456")).rejects.toMatchObject({ status: code === "42501" ? 403 : 503 });
    }
    // Function cache miss with an existing policy table is never a safe fallback.
    db.registerRpc("motorist_resolve_callback_target", () => { throw { code: "PGRST202", message: "cache lag" }; });
    await expect(resolveCallbackTarget(admin, org, "0900 123 456")).rejects.toMatchObject({ status: 503 });
    db.registerRpc("motorist_resolve_callback_target", () => null);
    await expect(resolveCallbackTarget(admin, org, "0900 123 456")).rejects.toMatchObject({ status: 503 });
  });
  it("requires manager/admin explicit verification and exact revision, using authenticated actor", async () => {
    const { admin, db } = createFakeSupabase();
    db.registerRpc("motorist_contact_callback_policy", args => args);
    const input = { nonCallback: true, targetContactId: target, verified: true, expectedRevision: 2 };
    await expect(saveCallbackPolicy(admin, { ...actor, role: "dispatcher" }, contact, input)).rejects.toMatchObject({ status: 403 });
    await expect(saveCallbackPolicy(admin, actor, contact, { ...input, verified: false })).rejects.toMatchObject({ status: 400 });
    await expect(saveCallbackPolicy(admin, actor, contact, { ...input, actorId: "forged" })).rejects.toMatchObject({ status: 400 });
    expect(await saveCallbackPolicy(admin, actor, contact, input)).toMatchObject({ p_actor_id: actor.profileId, p_organization_id: org, p_expected_revision: 2, p_verified: true });
    await expect(approveCallbackTarget(admin, org, actor.profileId, contact, "infer-it")).rejects.toMatchObject({ status: 400 });
  });
});
