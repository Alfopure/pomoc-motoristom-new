import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MotoristActor } from "@/server/api-auth";

type QueryCall = { method: string; args: unknown[] };

const adminMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/admin", () => ({
  createSupabaseAdminClient: adminMock,
}));

import {
  addTelephonyFavorite,
  createTelephonyFavorite,
  listTelephonyDirectory,
  listTelephonyFavorites,
  removeTelephonyFavorite,
  searchTelephonyDirectory,
} from "./telephony-directory";

const actor: MotoristActor = {
  userId: "user-1",
  profileId: "profile-1",
  organizationId: "org-1",
  displayName: "Operátor",
  role: "dispatcher",
};

const contact = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Ján Novák",
  phone: "+421 900 111 222",
  email: "jan@example.test",
  role: "client" as const,
};

describe("telephony directory", () => {
  beforeEach(() => {
    adminMock.mockReset();
  });

  it("searches inside the actor organization and marks personal favorites", async () => {
    const favoritesQuery = makeQuery({ data: [{ contact_id: contact.id }], error: null });
    const rpc = vi.fn().mockResolvedValue({ data: [contact], error: null });
    const from = vi.fn(() => favoritesQuery.query);
    adminMock.mockReturnValue({ from, rpc });

    const result = await searchTelephonyDirectory(actor, "  Ján   ");

    expect(rpc).toHaveBeenCalledWith("motorist_search_contacts", {
      p_organization_id: actor.organizationId,
      p_query: "Ján",
      p_limit: 12,
    });
    expect(favoritesQuery.calls).toContainEqual({ method: "eq", args: ["organization_id", actor.organizationId] });
    expect(favoritesQuery.calls).toContainEqual({ method: "eq", args: ["profile_id", actor.profileId] });
    expect(result).toEqual([{ ...contact, isFavorite: true }]);
  });

  it("lists callable contacts alphabetically and keeps favorites personal", async () => {
    const contactsQuery = makeQuery({ data: [contact, { ...contact, id: "33333333-3333-4333-8333-333333333333", phone: "  " }], error: null });
    const favoritesQuery = makeQuery({ data: [{ contact_id: contact.id }], error: null });
    const from = vi.fn((table: string) => (table === "motorist_contacts" ? contactsQuery.query : favoritesQuery.query));
    adminMock.mockReturnValue({ from, rpc: vi.fn() });

    const result = await listTelephonyDirectory(actor);

    expect(contactsQuery.calls).toContainEqual({ method: "eq", args: ["organization_id", actor.organizationId] });
    expect(contactsQuery.calls).toContainEqual({ method: "order", args: ["name", { ascending: true }] });
    expect(contactsQuery.calls).toContainEqual({ method: "limit", args: [100] });
    expect(result).toEqual([{ ...contact, isFavorite: true }]);
  });

  it("returns favorites in the user's saved order", async () => {
    const secondContact = {
      ...contact,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Eva Horváthová",
      phone: "+421 900 333 444",
    };
    const favoritesQuery = makeQuery({
      data: [{ contact_id: secondContact.id }, { contact_id: contact.id }],
      error: null,
    });
    const contactsQuery = makeQuery({ data: [contact, secondContact], error: null });
    const from = vi.fn((table: string) => (table === "motorist_contact_favorites" ? favoritesQuery.query : contactsQuery.query));
    adminMock.mockReturnValue({ from, rpc: vi.fn() });

    const result = await listTelephonyFavorites(actor);

    expect(result.map((item) => item.id)).toEqual([secondContact.id, contact.id]);
    expect(result.every((item) => item.isFavorite)).toBe(true);
    expect(contactsQuery.calls).toContainEqual({ method: "eq", args: ["organization_id", actor.organizationId] });
  });

  it("adds a favorite only after finding the contact in the actor organization", async () => {
    const contactQuery = makeQuery({ data: contact, error: null });
    const favoriteQuery = makeQuery({ data: null, error: null });
    const from = vi.fn((table: string) => (table === "motorist_contacts" ? contactQuery.query : favoriteQuery.query));
    adminMock.mockReturnValue({ from, rpc: vi.fn() });

    const result = await addTelephonyFavorite(actor, contact.id);

    expect(contactQuery.calls).toContainEqual({ method: "eq", args: ["organization_id", actor.organizationId] });
    expect(favoriteQuery.calls).toContainEqual({
      method: "upsert",
      args: [
        { organization_id: actor.organizationId, profile_id: actor.profileId, contact_id: contact.id },
        { onConflict: "profile_id,contact_id", ignoreDuplicates: true },
      ],
    });
    expect(result).toEqual({ ...contact, isFavorite: true });
  });

  it("removes favorites with both organization and profile scope", async () => {
    const favoriteQuery = makeQuery({ data: null, error: null });
    adminMock.mockReturnValue({ from: vi.fn(() => favoriteQuery.query), rpc: vi.fn() });

    await expect(removeTelephonyFavorite(actor, contact.id)).resolves.toBe(contact.id);
    expect(favoriteQuery.calls).toContainEqual({ method: "eq", args: ["organization_id", actor.organizationId] });
    expect(favoriteQuery.calls).toContainEqual({ method: "eq", args: ["profile_id", actor.profileId] });
    expect(favoriteQuery.calls).toContainEqual({ method: "eq", args: ["contact_id", contact.id] });
  });

  it("creates a manual callable contact and favorites it for the current operator", async () => {
    const searchFavoritesQuery = makeQuery({ data: [], error: null });
    adminMock.mockReturnValueOnce({
      from: vi.fn(() => searchFavoritesQuery.query),
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    });

    const createdContact = { ...contact, name: "Nový kontakt", phone: "+421 900 555 666" };
    const contactInsertQuery = makeQuery({ data: createdContact, error: null });
    const favoriteInsertQuery = makeQuery({ data: null, error: null });
    adminMock.mockReturnValueOnce({
      from: vi.fn((table: string) => table === "motorist_contacts" ? contactInsertQuery.query : favoriteInsertQuery.query),
      rpc: vi.fn(),
    });

    const result = await createTelephonyFavorite(actor, { name: "  Nový   kontakt ", phone: "+421 900 555 666" });

    expect(contactInsertQuery.calls).toContainEqual({
      method: "insert",
      args: [{
        organization_id: actor.organizationId,
        name: "Nový kontakt",
        phone: "+421 900 555 666",
        email: null,
        role: "client",
        notes: "Ručne pridaný z telefónneho zoznamu",
      }],
    });
    expect(favoriteInsertQuery.calls).toContainEqual({
      method: "insert",
      args: [{ organization_id: actor.organizationId, profile_id: actor.profileId, contact_id: contact.id }],
    });
    expect(result).toEqual({ contact: { ...createdContact, isFavorite: true }, created: true });
  });

  it("rejects malformed contact identifiers before accessing the database", async () => {
    await expect(addTelephonyFavorite(actor, "not-a-contact-id")).rejects.toMatchObject({ status: 400 });
    expect(adminMock).not.toHaveBeenCalled();
  });
});

function makeQuery(result: { data: unknown; error: unknown }) {
  const calls: QueryCall[] = [];
  const query = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === "then") {
          return (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve(result).then(resolve, reject);
        }

        return (...args: unknown[]) => {
          calls.push({ method: String(property), args });
          return query;
        };
      },
    },
  );

  return { calls, query };
}
