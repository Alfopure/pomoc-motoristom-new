"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function MotoristLogin({ message }: { message: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim();

    if (!normalizedEmail) {
      setError("Zadaj email.");
      return;
    }

    if (!password) {
      setError("Zadaj heslo.");
      return;
    }

    setStatus("working");
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: normalizedEmail,
      password,
    });

    if (signInError) {
      setStatus("error");
      setError("Prihlásenie zlyhalo. Skontroluj email a heslo.");
      return;
    }

    window.location.href = "/";
  }

  const isWorking = status === "working";
  const forgotPasswordHref = email.trim() ? `/auth/forgot-password?email=${encodeURIComponent(email.trim().toLowerCase())}` : "/auth/forgot-password";

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
            <h1 className="text-2xl font-semibold text-zinc-950">Prihlásenie</h1>
            <p className="mt-3 text-sm leading-6 text-zinc-600">{message}</p>
          </div>

          <form onSubmit={signIn} className="space-y-4">
            <label className="block text-sm font-medium text-zinc-800">
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-base text-zinc-950 outline-none ring-[#FCD703] transition focus:border-zinc-400 focus:ring-2"
                autoComplete="email"
              />
            </label>

            <label className="block text-sm font-medium text-zinc-800">
              Heslo
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className="mt-2 w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-base text-zinc-950 outline-none ring-[#FCD703] transition focus:border-zinc-400 focus:ring-2"
                autoComplete="current-password"
              />
            </label>

            {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800">{error}</p> : null}

            <button
              type="submit"
              disabled={isWorking}
              className="w-full rounded-md bg-zinc-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
            >
              {isWorking ? "Pracujem..." : "Prihlásiť sa"}
            </button>
          </form>

          <Link href={forgotPasswordHref} className="mt-4 block w-full text-center text-sm font-semibold text-zinc-700 transition hover:text-zinc-950">
            Zabudnuté heslo
          </Link>
        </div>
      </section>
    </main>
  );
}
