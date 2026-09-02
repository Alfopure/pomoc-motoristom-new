"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type BrowserSupabaseClient = ReturnType<typeof createSupabaseBrowserClient>;

export function SetPasswordForm() {
  const [supabase, setSupabase] = useState<BrowserSupabaseClient | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [passwordAgain, setPasswordAgain] = useState("");
  const [status, setStatus] = useState<"initializing" | "idle" | "saving" | "saved" | "error">("initializing");
  const [error, setError] = useState<string | null>(null);
  const displayStatus = configurationError ? "error" : status;
  const displayError = configurationError ?? error;

  useEffect(() => {
    let active = true;

    queueMicrotask(() => {
      if (!active) {
        return;
      }

      try {
        setSupabase(createSupabaseBrowserClient());
      } catch {
        setConfigurationError(
          "Supabase konfigurácia nie je dostupná. Skontroluj nastavenie prostredia pre túto deployment vetvu.",
        );
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const client = supabase;

    if (!client) {
      return;
    }

    let active = true;

    async function initializeSession(client: BrowserSupabaseClient) {
      const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const accessToken = hash.get("access_token");
      const refreshToken = hash.get("refresh_token");
      const errorDescription = hash.get("error_description") ?? hash.get("error");

      if (errorDescription) {
        if (!active) {
          return;
        }

        setStatus("error");
        setError("Odkaz na nastavenie hesla je neplatný alebo expiroval. Vyžiadaj si nový odkaz na obnovu hesla.");
        return;
      }

      if (accessToken && refreshToken) {
        const { error: sessionError } = await client.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });

        window.history.replaceState(null, document.title, `${window.location.pathname}${window.location.search}`);

        if (sessionError) {
          if (!active) {
            return;
          }

          setStatus("error");
          setError("Odkaz sa nepodarilo overiť. Otvor najnovší email alebo si vyžiadaj nový odkaz na obnovu hesla.");
          return;
        }
      }

      const {
        data: { session },
      } = await client.auth.getSession();

      if (!active) {
        return;
      }

      if (!session) {
        setStatus("error");
        setError("Otvor odkaz priamo z emailu. Bez overeného odkazu nie je možné nastaviť heslo.");
        return;
      }

      setStatus("idle");
    }

    void initializeSession(client);

    return () => {
      active = false;
    };
  }, [supabase]);

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const client = supabase;

    if (!client) {
      setStatus("error");
      setError("Supabase konfigurácia nie je dostupná. Skontroluj nastavenie prostredia pre túto deployment vetvu.");
      return;
    }

    if (password.length < 8) {
      setError("Heslo musí mať aspoň 8 znakov.");
      return;
    }

    if (password !== passwordAgain) {
      setError("Heslá sa nezhodujú.");
      return;
    }

    setStatus("saving");
    setError(null);

    const { error: updateError } = await client.auth.updateUser({ password });

    if (updateError) {
      setStatus("error");
      setError("Heslo sa nepodarilo uložiť. Skús otvoriť odkaz z emailu znova.");
      return;
    }

    const response = await fetch("/api/auth/password-completed", { method: "POST" });
    const result = (await response.json().catch(() => ({}))) as { error?: string };

    if (!response.ok) {
      setStatus("error");
      setError(result.error ?? "Heslo je uložené, ale stav prístupu sa nepodarilo potvrdiť.");
      return;
    }

    setStatus("saved");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-4 py-10 text-zinc-950">
      <section className="w-full max-w-sm overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-2xl shadow-zinc-950/10">
        <div className="h-2 bg-[#FCD703]" />
        <div className="p-6">
          <div className="mb-6">
            <div className="mb-5 flex items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[#FCD703] text-base font-black text-zinc-950">PM</div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">Pomoc motoristom</p>
                <p className="text-sm font-semibold text-zinc-950">Dispečing</p>
              </div>
            </div>
            <h1 className="text-2xl font-semibold text-zinc-950">Nastavenie hesla</h1>
            <p className="mt-3 text-sm leading-6 text-zinc-600">
              {displayStatus === "initializing" ? "Overujem bezpečný odkaz z emailu." : "Zadaj nové heslo pre prístup do dispečingu."}
            </p>
          </div>

          {displayStatus === "initializing" ? (
            <p className="rounded-md border border-yellow-200 bg-yellow-50 px-3 py-2 text-sm font-medium text-zinc-800">Pripravujem nastavenie hesla...</p>
          ) : displayStatus === "saved" ? (
            <div className="space-y-4">
              <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">Heslo je nastavené. Môžeš pokračovať do dispečingu.</p>
              <Link className="flex h-10 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white transition hover:bg-zinc-800" href="/">
                Otvoriť dispečing
              </Link>
            </div>
          ) : (
            <form onSubmit={savePassword} className="space-y-4">
              <label className="block text-sm font-medium text-zinc-800">
                Nové heslo
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-base text-zinc-950 outline-none ring-[#FCD703] transition focus:border-zinc-400 focus:ring-2"
                  autoComplete="new-password"
                />
              </label>
              <label className="block text-sm font-medium text-zinc-800">
                Zopakovať heslo
                <input
                  type="password"
                  value={passwordAgain}
                  onChange={(event) => setPasswordAgain(event.target.value)}
                  className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-base text-zinc-950 outline-none ring-[#FCD703] transition focus:border-zinc-400 focus:ring-2"
                  autoComplete="new-password"
                />
              </label>
              {displayError ? (
                <div className="space-y-3">
                  <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{displayError}</p>
                  {displayStatus === "error" ? (
                    <Link className="block text-center text-sm font-semibold text-zinc-700 transition hover:text-zinc-950" href="/auth/forgot-password">
                      Vyžiadať nový odkaz
                    </Link>
                  ) : null}
                </div>
              ) : null}
              <button
                type="submit"
                disabled={status === "saving" || !supabase}
                className="w-full rounded-md bg-zinc-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
              >
                {status === "saving" ? "Ukladám..." : "Nastaviť heslo"}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
