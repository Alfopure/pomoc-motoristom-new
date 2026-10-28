"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";
import { Button, Notice } from "@/components/towing/primitives";
import styles from "./operations.module.css";

type LastPosition = { lat: number; lng: number; accuracy: number | null; recordedAt: string; member: string } | null;
const time = (value: string) => new Intl.DateTimeFormat("sk-SK", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Bratislava" }).format(new Date(value));

/** Where the executor last was during this accepted jazda (sent from the app while it is open). */
export function OperationPositionPanel({ operationId }: { operationId: string }) {
  const [position, setPosition] = useState<LastPosition | undefined>(undefined);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/operations/${operationId}/position`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Polohu sa nepodarilo načítať.");
      setPosition(body.position ?? null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Polohu sa nepodarilo načítať."); }
    finally { setBusy(false); }
  }
  return <div className={styles.panel}><div className={styles.panelHeading}><h3><MapPin size={16} /> Poloha vykonávateľa</h3><Button disabled={busy} onClick={() => void load()}>{position === undefined ? "Zobraziť polohu" : "Obnoviť"}</Button></div>
    {error && <Notice kind="error">{error}</Notice>}
    {position === undefined ? <p className={styles.muted}>Aplikácia posiela polohu počas prijatej jazdy, kým je otvorená.</p>
      : position === null ? <p className={styles.muted}>Z tejto jazdy zatiaľ neprišla žiadna poloha.</p>
        : <p>{position.member} · {time(position.recordedAt)}{position.accuracy !== null && ` · presnosť ${Math.round(position.accuracy)} m`} · <a href={`https://www.google.com/maps/search/?api=1&query=${position.lat.toFixed(6)}%2C${position.lng.toFixed(6)}`} target="_blank" rel="noreferrer">Otvoriť na mape ↗</a></p>}
  </div>;
}
