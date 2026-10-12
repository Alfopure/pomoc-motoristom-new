import { beforeEach, describe, expect, it } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { clearCallContactNameCache, loadCallContactNames, contactNamesFromEntries } from "./contact-names";
beforeEach(() => clearCallContactNameCache());
describe("directory phone identities", () => {
  it("matches local, international and spaced numbers without matching a suffix", () => {
    const names = contactNamesFromEntries([{ name: "AWP Allianz", phone: "02 / 3240 8718" }, { name: "Jana", phone: "00421 910 123 456" }, { name: "Unrelated", phone: "+420910123456" }], ["+421232408718", "0910123456", "910123456"]);
    expect([...names]).toEqual([["421232408718", "AWP Allianz"], ["421910123456", "Jana"]]);
    expect(names.has("910123456")).toBe(false);
  });
});

it("uses one organization-scoped read and accepts only requested normalized identities", async () => {
  const { client, db } = createFakeSupabase();
  db.registerRpc("motorist_resolve_call_contacts", args => {
    expect(args.p_organization_id).toBe("ours");
    expect(args.p_numbers).toEqual(["421232408718", "421910123456"]);
    return [{ number: "421910123456", name: "Jana" }, { number: "421232408718", name: "AWP Allianz" }, { number: "420910123456", name: "Unrelated" }];
  });
  const names = await loadCallContactNames(client as unknown as Parameters<typeof loadCallContactNames>[0], "ours", ["+421910123456", "+421232408718"]);
  expect([...names]).toEqual([["421910123456", "Jana"], ["421232408718", "AWP Allianz"]]);
});
