"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ChevronLeft, ChevronRight, Loader2, MessageSquareText, PhoneCall, Search, Star, UserRound } from "lucide-react";
import type {
  TelephonyDirectoryContact,
  TelephonyDirectoryResponse,
  TelephonyFavoriteMutationResponse,
  TelephonyFavoritesResponse,
} from "@/lib/telephony/directory";
import type { DispatchData } from "@/data/dispatch-types";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";
import { cleanPhoneInput } from "@/lib/telephony/phone";
import { SmsComposerDialog } from "./SmsComposerDialog";

export type DashboardPhoneProps = {
  caseContext?: {
    caseNumber: string;
    id: string;
    phone: string;
  };
  className?: string;
  disabled?: boolean;
  isDialing?: boolean;
  onDataChange?: (dispatchData: DispatchData) => void;
  onDial: (phone: string, contact?: TelephonyDirectoryContact) => Promise<void> | void;
  variant?: "card" | "rail";
};

const CONTACT_ROLE_LABELS: Record<TelephonyDirectoryContact["role"], string> = {
  client: "Klient",
  assistance: "Asistencia",
  branch: "Pobočka",
  partner: "Partner",
};

const FAVORITES_PER_PAGE = 5;

export function DashboardPhone({ caseContext, className = "", disabled = false, isDialing = false, onDataChange, onDial, variant = "card" }: DashboardPhoneProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [selectedContact, setSelectedContact] = useState<TelephonyDirectoryContact | null>(null);
  const [favorites, setFavorites] = useState<TelephonyDirectoryContact[]>([]);
  const [results, setResults] = useState<TelephonyDirectoryContact[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isLoadingFavorites, setIsLoadingFavorites] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [favoritePendingId, setFavoritePendingId] = useState<string | null>(null);
  const [favoritePage, setFavoritePage] = useState(0);
  const [dialPending, setDialPending] = useState(false);
  const [smsComposerOpen, setSmsComposerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const normalizedQuery = query.trim();
  const isSearchMode = normalizedQuery.length >= 2;
  const visibleContacts = useMemo(() => (isSearchMode ? results : favorites), [favorites, isSearchMode, results]);
  const favoritePageCount = Math.max(1, Math.ceil(favorites.length / FAVORITES_PER_PAGE));
  const effectiveFavoritePage = Math.min(favoritePage, favoritePageCount - 1);
  const pagedFavorites = favorites.slice(effectiveFavoritePage * FAVORITES_PER_PAGE, (effectiveFavoritePage + 1) * FAVORITES_PER_PAGE);
  const dialing = disabled || isDialing || dialPending;

  useEffect(() => {
    const controller = new AbortController();

    async function loadFavorites() {
      setIsLoadingFavorites(true);

      try {
        const response = await telephonyFetch("/api/telephony/directory/favorites", {
          label: "obľúbené kontakty",
          signal: controller.signal,
          timeoutMs: TELEPHONY_TIMEOUT_MS.read,
        });
        const data = await readResponse<TelephonyFavoritesResponse>(response);
        setFavorites(data.favorites);
      } catch (loadError) {
        if (!isAbortError(loadError)) {
          setError((current) => current ?? messageFromError(loadError, "Obľúbené kontakty sa nepodarilo načítať."));
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingFavorites(false);
        }
      }
    }

    void loadFavorites();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!isSearchMode) {
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setIsSearching(true);

      try {
        const params = new URLSearchParams({ q: normalizedQuery });
        const response = await telephonyFetch(`/api/telephony/directory?${params.toString()}`, {
          label: "hľadanie v adresári",
          signal: controller.signal,
          timeoutMs: TELEPHONY_TIMEOUT_MS.read,
        });
        const data = await readResponse<TelephonyDirectoryResponse>(response);
        setResults(data.contacts);
      } catch (searchError) {
        if (!isAbortError(searchError)) {
          setResults([]);
          setError(messageFromError(searchError, "Telefónny zoznam sa nepodarilo prehľadať."));
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
      }
    }, 250);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [isSearchMode, normalizedQuery]);

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  function updateQuery(value: string) {
    setQuery(value);
    setError(null);
    setIsOpen(true);

    if (value.trim().length < 2) {
      setResults([]);
      setIsSearching(false);
    } else {
      setIsSearching(true);
    }

    if (selectedContact && value !== selectedContact.phone) {
      setSelectedContact(null);
    }
  }

  function chooseContact(contact: TelephonyDirectoryContact) {
    setSelectedContact(contact);
    setQuery(contact.phone);
    setError(null);
    setIsOpen(false);
  }

  async function dial(contact?: TelephonyDirectoryContact) {
    if (dialing) {
      return;
    }

    const dialContact = contact ?? selectedContact;
    const phone = dialContact?.phone ?? normalizedQuery;

    try {
      cleanPhoneInput(phone, "Telefónne číslo");
    } catch {
      setError("Zadajte platné telefónne číslo alebo vyberte kontakt.");
      setIsOpen(true);
      return;
    }

    setDialPending(true);
    setError(null);
    if (dialContact) {
      setSelectedContact(dialContact);
      setQuery(dialContact.phone);
    }

    try {
      await onDial(phone, dialContact ?? undefined);
      setIsOpen(false);
    } catch (dialError) {
      setError(messageFromError(dialError, "Hovor sa nepodarilo spustiť."));
    } finally {
      setDialPending(false);
    }
  }

  async function toggleFavorite(contact: TelephonyDirectoryContact) {
    if (favoritePendingId) {
      return;
    }

    setFavoritePendingId(contact.id);
    setError(null);

    try {
      const response = await telephonyFetch(`/api/telephony/directory/favorites/${encodeURIComponent(contact.id)}`, {
        method: contact.isFavorite ? "DELETE" : "PUT",
        headers: { "Content-Type": "application/json" },
        label: "obľúbený kontakt",
        timeoutMs: TELEPHONY_TIMEOUT_MS.mutation,
      });
      const data = await readResponse<TelephonyFavoriteMutationResponse>(response);
      const updatedContact = { ...(data.contact ?? contact), isFavorite: data.isFavorite };

      setResults((current) => current.map((item) => (item.id === contact.id ? updatedContact : item)));
      setFavorites((current) =>
        data.isFavorite
          ? [updatedContact, ...current.filter((item) => item.id !== contact.id)]
          : current.filter((item) => item.id !== contact.id),
      );
      if (data.isFavorite) {
        setFavoritePage(0);
      }
      setSelectedContact((current) => (current?.id === contact.id ? updatedContact : current));
    } catch (favoriteError) {
      setError(messageFromError(favoriteError, "Obľúbený kontakt sa nepodarilo zmeniť."));
    } finally {
      setFavoritePendingId(null);
    }
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();

    if (isDialable(normalizedQuery)) {
      void dial();
    } else if (visibleContacts[0]) {
      chooseContact(visibleContacts[0]);
    }
  }

  return (
    <div ref={rootRef} className={`relative min-w-0 max-w-full ${className}`}>
      <div className="relative min-w-0">
        <section
          className={
            variant === "rail"
              ? "min-w-0 border-b border-zinc-200 bg-white p-3"
              : "min-w-0 rounded-xl border border-zinc-200 bg-white p-2.5 shadow-sm"
          }
        >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#FCD703] text-zinc-950">
              <PhoneCall size={16} strokeWidth={2.4} />
            </span>
            <div className="min-w-0">
              <div className="truncate text-base font-semibold tracking-tight text-zinc-950">Rýchle volanie</div>
              <div className="truncate text-[11px] text-zinc-500">Číslo, kontakt alebo obľúbené</div>
            </div>
          </div>
        </div>

        <div className={variant === "rail" ? "grid min-w-0 grid-cols-2 gap-2" : "grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] gap-2"}>
          <label className={`flex min-w-0 items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-2.5 focus-within:border-zinc-400 focus-within:bg-white ${variant === "rail" ? "col-span-2" : ""}`}>
            <Search size={15} className="shrink-0 text-zinc-400" />
            <input
              type="text"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              onFocus={() => setIsOpen(true)}
              onKeyDown={handleInputKeyDown}
              role="combobox"
              aria-label="Telefónne číslo alebo meno kontaktu"
              aria-autocomplete="list"
              aria-controls="dashboard-phone-directory"
              aria-expanded={isOpen}
              autoComplete="off"
              placeholder="Číslo alebo meno"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-zinc-900 outline-none placeholder:text-zinc-400"
            />
            {isSearching && <Loader2 size={15} className="shrink-0 animate-spin text-zinc-400" aria-label="Vyhľadávam" />}
          </label>
          <button
            type="button"
            onClick={() => void dial()}
            disabled={dialing}
            className="inline-flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {dialPending || isDialing ? <Loader2 size={16} className="animate-spin" /> : <PhoneCall size={16} />}
            <span className="hidden sm:inline">Volať</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              setSmsComposerOpen(true);
            }}
            className="inline-flex h-10 min-w-0 items-center justify-center gap-1.5 rounded-lg bg-[#FCD703] px-3 text-sm font-semibold text-zinc-950 transition hover:bg-yellow-300"
          >
            <MessageSquareText size={16} />
            <span className="hidden sm:inline">SMS</span>
          </button>
        </div>

        {error && (
          <div className="mt-2 flex min-w-0 items-start gap-1.5 text-xs text-red-700" role="alert">
            <AlertCircle size={14} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}
        </section>

      {isOpen && (variant !== "rail" || isSearchMode) && (
        <div
          id="dashboard-phone-directory"
          role="listbox"
          aria-label={isSearchMode ? "Výsledky vyhľadávania kontaktov" : "Obľúbené kontakty"}
          className={`absolute right-0 top-[calc(100%+6px)] z-50 max-h-80 w-full min-w-0 overflow-y-auto overflow-x-hidden rounded-xl border border-zinc-200 bg-white p-1.5 shadow-xl ${variant === "rail" ? "" : "sm:min-w-[340px]"}`}
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
            <span>{isSearchMode ? "Telefónny zoznam" : "Obľúbené"}</span>
            {!isSearchMode && <Star size={13} className="fill-amber-400 text-amber-500" />}
          </div>

          {(isLoadingFavorites && !isSearchMode) || isSearching ? (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-sm text-zinc-500">
              <Loader2 size={16} className="animate-spin" />
              Načítavam…
            </div>
          ) : visibleContacts.length > 0 ? (
            <div className="space-y-1">
              {visibleContacts.map((contact) => (
                <div key={contact.id} role="option" aria-selected={selectedContact?.id === contact.id} className="flex min-w-0 items-center gap-1 rounded-lg hover:bg-zinc-50">
                  <button
                    type="button"
                    onClick={() => chooseContact(contact)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-left"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600">
                      <UserRound size={15} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-zinc-900">{contact.name}</span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500">
                        <span className="truncate">{contact.phone}</span>
                        <span aria-hidden="true">·</span>
                        <span className="shrink-0">{CONTACT_ROLE_LABELS[contact.role]}</span>
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleFavorite(contact)}
                    disabled={favoritePendingId !== null}
                    aria-label={contact.isFavorite ? `Odobrať ${contact.name} z obľúbených` : `Pridať ${contact.name} medzi obľúbené`}
                    aria-pressed={contact.isFavorite}
                    className="mr-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-100 hover:text-amber-500 disabled:opacity-50"
                  >
                    {favoritePendingId === contact.id ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Star size={16} className={contact.isFavorite ? "fill-amber-400 text-amber-500" : ""} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-6 text-center text-sm text-zinc-500">
              {isSearchMode ? "Nenašli sa žiadne kontakty s telefónnym číslom." : "Zatiaľ nemáte obľúbené kontakty."}
            </div>
          )}
        </div>
      )}
      </div>

      {variant === "rail" && (
        <section className="border-b border-zinc-200 bg-zinc-50/70 px-3 py-2.5" aria-label="Obľúbené kontakty na rýchle volanie">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-zinc-800">
              <Star size={14} className="shrink-0 fill-amber-400 text-amber-500" />
              <span className="truncate">Obľúbené kontakty</span>
            </div>
            {!isLoadingFavorites && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold text-zinc-600 ring-1 ring-zinc-200">{favorites.length}</span>}
          </div>

          {isLoadingFavorites ? (
            <div className="flex h-16 items-center justify-center gap-2 text-xs font-medium text-zinc-500">
              <Loader2 size={15} className="animate-spin" />
              Načítavam kontakty…
            </div>
          ) : pagedFavorites.length > 0 ? (
            <div className="grid gap-1">
              {pagedFavorites.map((contact) => (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => void dial(contact)}
                  disabled={dialing}
                  aria-label={`Volať kontaktu ${contact.name}`}
                  className="group flex min-w-0 items-center gap-2 rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-left transition hover:border-yellow-300 hover:bg-yellow-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-600 group-hover:bg-white">
                    <UserRound size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-zinc-900">{contact.name}</span>
                    <span className="block truncate text-[11px] text-zinc-500">{contact.phone}</span>
                  </span>
                  <PhoneCall size={14} className="shrink-0 text-emerald-600" />
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-zinc-200 bg-white px-3 py-3 text-center text-xs leading-5 text-zinc-500">
              Kontakty označené hviezdičkou sa zobrazia tu.
            </div>
          )}

          {favoritePageCount > 1 && (
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-200 pt-2">
              <button
                type="button"
                onClick={() => setFavoritePage(Math.max(0, effectiveFavoritePage - 1))}
                disabled={effectiveFavoritePage === 0}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:opacity-35"
                aria-label="Predchádzajúca strana obľúbených kontaktov"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-[11px] font-semibold text-zinc-600">{effectiveFavoritePage + 1} / {favoritePageCount}</span>
              <button
                type="button"
                onClick={() => setFavoritePage(Math.min(favoritePageCount - 1, effectiveFavoritePage + 1))}
                disabled={effectiveFavoritePage >= favoritePageCount - 1}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-100 disabled:opacity-35"
                aria-label="Nasledujúca strana obľúbených kontaktov"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </section>
      )}
      <SmsComposerDialog
        caseId={caseContext?.id}
        caseNumber={caseContext?.caseNumber}
        initialPhone={selectedContact?.phone ?? query}
        locationPhone={caseContext?.phone}
        onClose={() => setSmsComposerOpen(false)}
        onSent={(result) => {
          setError(null);
          if (result.dispatchData) onDataChange?.(result.dispatchData);
        }}
        open={smsComposerOpen}
      />
    </div>
  );
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;

  if (!response.ok) {
    const message = typeof payload?.error === "string" ? payload.error : "Požiadavku sa nepodarilo dokončiť.";
    throw new Error(message);
  }

  if (!payload) {
    throw new Error("Server vrátil neplatnú odpoveď.");
  }

  return payload;
}

function isDialable(value: string) {
  try {
    cleanPhoneInput(value);
    return true;
  } catch {
    return false;
  }
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function messageFromError(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
