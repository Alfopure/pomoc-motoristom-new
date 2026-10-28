"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import type { RentalDraftPreview } from "@/domain/rental-draft";
import { Button, Notice } from "@/components/towing/primitives";
import styles from "./operations.module.css";

/** Náhľad rozpracovaného nájmu pre nájomný systém; kým nie je dohodnuté napojenie, nič neodosiela. */
export function RentalDraftPanel({ operationId }: { operationId: string }) {
  const [preview, setPreview] = useState<RentalDraftPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/operations/${operationId}/rental-draft`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Náhľad nájmu sa nepodarilo pripraviť.");
      setPreview(body);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Náhľad nájmu sa nepodarilo pripraviť."); }
    finally { setBusy(false); }
  }
  return <div className={styles.panel}><div className={styles.panelHeading}><h3><FileText size={16} /> Nájom v nájomnom systéme</h3><Button disabled={busy} onClick={() => void load()}>{preview ? "Obnoviť náhľad" : "Pripraviť nájom"}</Button></div>
    {error && <Notice kind="error">{error}</Notice>}
    {!preview ? <p className={styles.muted}>Pristavovač nebude údaje prepisovať: po napojení sa z prípadu vytvorí rozpracovaný nájom označený „Prenesené z dispečingu“.</p> : <>
      <Notice>{preview.connection.message}</Notice>
      <dl className={styles.form}>{preview.fields.map(field => <div key={field.key}><dt className={styles.muted}>{field.label}</dt><dd>{field.value ?? "— chýba"}</dd></div>)}</dl>
      {preview.missing.length > 0 && <p className={styles.waiting}>Chýba v prípade: {preview.missing.join(", ")}.</p>}
      <p className={styles.muted}>Ostatné (auto, adresu, doklady, vodiča) doplní pristavovač v nájomnom systéme. Otvorené: {preview.openQuestions.join(" ")}</p>
    </>}
  </div>;
}
