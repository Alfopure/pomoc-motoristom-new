"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import Link from "next/link";

type ResetState = "idle" | "working" | "sent" | "error";

type ForgotPasswordResponse = {
  ok?: boolean;
  message?: string;
};

export function ForgotPasswordForm({ initialEmail = "" }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [status, setStatus] = useState<ResetState>("idle");
  const [error, setError] = useState<string | null>(null);
  const isWorking = status === "working";

  async function requestReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) {
      setStatus("error");
      setError("Zadaj email.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      setStatus("error");
      setError("Email nemá správny formát.");
      return;
    }

    setStatus("working");
    setError(null);

    try {
      const response = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: normalizedEmail }),
      });
      const result = (await response.json().catch(() => ({}))) as ForgotPasswordResponse;

      if (!response.ok || result.ok === false) {
        throw new Error(result.message ?? "Obnovu hesla sa nepodarilo odoslať.");
      }

      setSubmittedEmail(normalizedEmail);
      setStatus("sent");
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : "Obnovu hesla sa nepodarilo odoslať.");
    }
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
            <h1 className="text-2xl font-semibold text-zinc-950">Obnova hesla</h1>
            <p className="mt-3 text-sm leading-6 text-zinc-600">Zadaj email účtu a pošleme ti odkaz na nastavenie nového hesla.</p>
          </div>

          {status === "sent" ? (
            <div className="space-y-4">
              <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800" role="status">
                Ak účet existuje, odkaz na obnovu hesla príde na {submittedEmail}.
              </div>
              <Link className="flex h-10 items-center justify-center rounded-md bg-zinc-950 px-4 text-sm font-semibold text-white transition hover:bg-zinc-800" href="/">
                Späť na prihlásenie
              </Link>
              <button
                type="button"
                onClick={() => {
                  setStatus("idle");
                  setError(null);
                }}
                className="w-full text-center text-sm font-semibold text-zinc-700 transition hover:text-zinc-950"
              >
                Poslať znovu
              </button>
            </div>
          ) : (
            <form onSubmit={requestReset} className="space-y-4">
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

              {error ? (
                <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-800" role="alert">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={isWorking}
                className="w-full rounded-md bg-zinc-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-300 disabled:text-zinc-600"
              >
                {isWorking ? "Odosielam..." : "Poslať obnovu hesla"}
              </button>
            </form>
          )}

          {status !== "sent" ? (
            <Link className="mt-4 block w-full text-center text-sm font-semibold text-zinc-700 transition hover:text-zinc-950" href="/">
              Späť na prihlásenie
            </Link>
          ) : null}
        </div>
      </section>
    </main>
  );
}
