"use client";

import { useState } from "react";

/** A real compiled frame, exercised through the normal global error listener. */
export function CanaryButton() {
  const [sent, setSent] = useState(false);
  return (
    <button
      type="button"
      disabled={sent}
      className="rounded bg-zinc-900 px-4 py-2 text-white disabled:opacity-50"
      onClick={() => {
        setSent(true);
        throw new Error("Diagnostic browser canary");
      }}
    >
      {sent ? "Skúšobná chyba vyvolaná" : "Overiť chybu prehliadača"}
    </button>
  );
}
