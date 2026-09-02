import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { TelephonyDirectoryContact, TelephonyDirectoryContactRole } from "@/lib/telephony/directory";
import type { MotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { cleanPhoneInput, sameDialNumber, TelephonyPhoneInputError } from "@/lib/telephony/phone";

type FavoriteRow = {
  organization_id: string;
  profile_id: string;
  contact_id: string;
  created_at: string;
};

type SearchContactRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  role: TelephonyDirectoryContactRole;
};

type TelephonyDatabase = {
  public: {
    Tables: Database["public"]["Tables"] & {
      motorist_contact_favorites: {
        Row: FavoriteRow;
        Insert: Omit<FavoriteRow, "created_at"> & { created_at?: string };
        Update: Partial<FavoriteRow>;
        Relationships: [];
      };
    };
    Views: Database["public"]["Views"];
    Functions: Database["public"]["Functions"] & {
      motorist_search_contacts: {
        Args: {
          p_organization_id: string;
          p_query: string;
          p_limit?: number;
        };
        Returns: SearchContactRow[];
      };
    };
    Enums: Database["public"]["Enums"];
    CompositeTypes: Database["public"]["CompositeTypes"];
  };
};

const DIRECTORY_LIMIT = 12;
const DIRECTORY_LIST_LIMIT = 100;
const QUERY_MAX_LENGTH = 80;
const CONTACT_NAME_MAX_LENGTH = 80;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const TELEPHONY_DIRECTORY_ROLES: MotoristActor["role"][] = ["dispatcher", "senior_dispatcher", "manager", "admin"];

export async function listTelephonyDirectory(actor: MotoristActor): Promise<TelephonyDirectoryContact[]> {
  const supabase = directoryClient();
  const [{ data, error }, favoriteIds] = await Promise.all([
    supabase
      .from("motorist_contacts")
      .select("id, name, phone, email, role")
      .eq("organization_id", actor.organizationId)
      .not("phone", "is", null)
      .order("name", { ascending: true })
      .limit(DIRECTORY_LIST_LIMIT),
    loadFavoriteIds(supabase, actor),
  ]);

  if (error) {
    throw new MutationError("Telefónny zoznam sa nepodarilo načítať.", 500);
  }

  return (data ?? []).flatMap((row) => {
    const contact = toDirectoryContact(row, favoriteIds.has(row.id));
    return contact ? [contact] : [];
  });
}

export async function searchTelephonyDirectory(actor: MotoristActor, rawQuery: string): Promise<TelephonyDirectoryContact[]> {
  const query = normalizeDirectoryQuery(rawQuery);

  if (!query) {
    return [];
  }

  const supabase = directoryClient();
  const [{ data, error }, favoriteIds] = await Promise.all([
    supabase.rpc("motorist_search_contacts", {
      p_organization_id: actor.organizationId,
      p_query: query,
      p_limit: DIRECTORY_LIMIT,
    }),
    loadFavoriteIds(supabase, actor),
  ]);

  if (error) {
    throw new MutationError("Telefónny zoznam sa nepodarilo prehľadať.", 500);
  }

  return (data ?? []).flatMap((row) => {
    const contact = toDirectoryContact(row, favoriteIds.has(row.id));
    return contact ? [contact] : [];
  });
}

export async function listTelephonyFavorites(actor: MotoristActor): Promise<TelephonyDirectoryContact[]> {
  const supabase = directoryClient();
  const { data: favorites, error: favoriteError } = await supabase
    .from("motorist_contact_favorites")
    .select("contact_id, created_at")
    .eq("organization_id", actor.organizationId)
    .eq("profile_id", actor.profileId)
    .order("created_at", { ascending: false });

  if (favoriteError) {
    throw new MutationError("Obľúbené kontakty sa nepodarilo načítať.", 500);
  }

  const favoriteIds = (favorites ?? []).map((favorite) => favorite.contact_id);

  if (favoriteIds.length === 0) {
    return [];
  }

  const { data: contacts, error: contactError } = await supabase
    .from("motorist_contacts")
    .select("id, name, phone, email, role")
    .eq("organization_id", actor.organizationId)
    .in("id", favoriteIds);

  if (contactError) {
    throw new MutationError("Obľúbené kontakty sa nepodarilo načítať.", 500);
  }

  const contactsById = new Map(
    (contacts ?? []).map((row) => {
      const contact = toDirectoryContact(row, true);
      return [row.id, contact] as const;
    }),
  );

  return favoriteIds.flatMap((id) => {
    const contact = contactsById.get(id);
    return contact ? [contact] : [];
  });
}

export async function addTelephonyFavorite(actor: MotoristActor, rawContactId: string): Promise<TelephonyDirectoryContact> {
  const contactId = requireContactId(rawContactId);
  const supabase = directoryClient();
  const contact = await findCallableContact(supabase, actor, contactId);
  const { error } = await supabase.from("motorist_contact_favorites").upsert(
    {
      organization_id: actor.organizationId,
      profile_id: actor.profileId,
      contact_id: contactId,
    },
    { onConflict: "profile_id,contact_id", ignoreDuplicates: true },
  );

  if (error) {
    throw new MutationError("Kontakt sa nepodarilo pridať medzi obľúbené.", 500);
  }

  return { ...contact, isFavorite: true };
}

export async function createTelephonyFavorite(
  actor: MotoristActor,
  input: { name: unknown; phone: unknown },
): Promise<{ contact: TelephonyDirectoryContact; created: boolean }> {
  const name = String(input.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new MutationError("Zadaj meno kontaktu.", 400);
  if (name.length > CONTACT_NAME_MAX_LENGTH) {
    throw new MutationError(`Meno môže mať najviac ${CONTACT_NAME_MAX_LENGTH} znakov.`, 400);
  }

  let phone: string;
  try {
    phone = cleanPhoneInput(input.phone, "Telefónne číslo").input;
  } catch (error) {
    if (error instanceof TelephonyPhoneInputError) {
      throw new MutationError("Zadaj platné telefónne číslo alebo internú klapku.", 400);
    }
    throw error;
  }

  const existing = (await searchTelephonyDirectory(actor, phone)).find((contact) => sameDialNumber(contact.phone, phone));
  if (existing) {
    return { contact: await addTelephonyFavorite(actor, existing.id), created: false };
  }

  const supabase = directoryClient();
  const result = await supabase
    .from("motorist_contacts")
    .insert({
      organization_id: actor.organizationId,
      name,
      phone,
      email: null,
      role: "client",
      notes: "Ručne pridaný z telefónneho zoznamu",
    })
    .select("id, name, phone, email, role")
    .single();

  if (result.error || !result.data) {
    throw new MutationError("Kontakt sa nepodarilo uložiť.", 500);
  }

  const favoriteResult = await supabase.from("motorist_contact_favorites").insert({
    organization_id: actor.organizationId,
    profile_id: actor.profileId,
    contact_id: result.data.id,
  });

  if (favoriteResult.error) {
    throw new MutationError("Kontakt je uložený, ale nepodarilo sa ho pridať medzi obľúbené.", 500);
  }

  const contact = toDirectoryContact(result.data, true);
  if (!contact) throw new MutationError("Kontakt nemá platné telefónne číslo.", 500);

  return { contact, created: true };
}

export async function removeTelephonyFavorite(actor: MotoristActor, rawContactId: string): Promise<string> {
  const contactId = requireContactId(rawContactId);
  const supabase = directoryClient();
  const { error } = await supabase
    .from("motorist_contact_favorites")
    .delete()
    .eq("organization_id", actor.organizationId)
    .eq("profile_id", actor.profileId)
    .eq("contact_id", contactId);

  if (error) {
    throw new MutationError("Kontakt sa nepodarilo odstrániť z obľúbených.", 500);
  }

  return contactId;
}

export function telephonyDirectoryErrorResponse(error: unknown, fallback: string) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error(fallback, error);
  return Response.json({ error: fallback }, { status: 500 });
}

function directoryClient() {
  return createSupabaseAdminClient() as unknown as SupabaseClient<TelephonyDatabase>;
}

async function loadFavoriteIds(supabase: SupabaseClient<TelephonyDatabase>, actor: MotoristActor) {
  const { data, error } = await supabase
    .from("motorist_contact_favorites")
    .select("contact_id")
    .eq("organization_id", actor.organizationId)
    .eq("profile_id", actor.profileId);

  if (error) {
    throw new MutationError("Obľúbené kontakty sa nepodarilo načítať.", 500);
  }

  return new Set((data ?? []).map((favorite) => favorite.contact_id));
}

async function findCallableContact(
  supabase: SupabaseClient<TelephonyDatabase>,
  actor: MotoristActor,
  contactId: string,
): Promise<TelephonyDirectoryContact> {
  const { data, error } = await supabase
    .from("motorist_contacts")
    .select("id, name, phone, email, role")
    .eq("organization_id", actor.organizationId)
    .eq("id", contactId)
    .maybeSingle();

  if (error) {
    throw new MutationError("Kontakt sa nepodarilo overiť.", 500);
  }

  const contact = data ? toDirectoryContact(data, false) : null;

  if (!contact) {
    throw new MutationError("Kontakt neexistuje alebo nemá telefónne číslo.", 404);
  }

  return contact;
}

function toDirectoryContact(row: SearchContactRow, isFavorite: boolean): TelephonyDirectoryContact | null {
  const phone = row.phone?.trim();

  if (!phone) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    phone,
    email: row.email,
    role: row.role,
    isFavorite,
  };
}

function normalizeDirectoryQuery(value: string) {
  const query = value.trim().replace(/\s+/g, " ");

  if (query.length > QUERY_MAX_LENGTH) {
    throw new MutationError(`Vyhľadávanie môže mať najviac ${QUERY_MAX_LENGTH} znakov.`, 400);
  }

  return query;
}

function requireContactId(value: string) {
  const contactId = value.trim();

  if (!UUID_PATTERN.test(contactId)) {
    throw new MutationError("Kontakt nemá platný identifikátor.", 400);
  }

  return contactId;
}
