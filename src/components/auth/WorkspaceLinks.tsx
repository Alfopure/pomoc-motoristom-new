"use client";
import Link from "next/link";
import { useState } from "react";
import { signOutCurrentSession } from "./sign-out";

export function WorkspaceLinks({ links }: { links: { href: string; label: string }[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="space-y-2"><nav className="flex flex-wrap items-center gap-3 text-sm" aria-label="Pracovné priestory">
    {links.map(link => <Link key={link.href} className="underline underline-offset-2" href={link.href}>{link.label}</Link>)}
    <button type="button" className="min-h-10 rounded border border-zinc-200 px-3 font-medium disabled:opacity-50" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { await signOutCurrentSession(); } catch { setError("Odhlásenie sa nepodarilo dokončiť."); setBusy(false); } }}>{busy ? "Odhlasujem…" : "Odhlásiť"}</button>
  </nav>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}</div>;
}
