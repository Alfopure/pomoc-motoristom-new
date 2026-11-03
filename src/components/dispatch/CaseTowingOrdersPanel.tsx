"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { TowingCommand, TowingWorkspace } from "@/domain/towing/types";
import { towingClient } from "@/components/towing/client";
import { Button, Notice, Panel, Select } from "@/components/towing/primitives";
import { orderTitle, workLabels } from "@/components/towing/model";
import styles from "@/components/towing/towing.module.css";

/** A case owns several deliberate towing intents; retries keep the original order identity. */
export function CaseTowingOrdersPanel({ caseId, caseNumber }: { caseId: string; caseNumber?: string }) {
  return <CaseTowingOrders key={caseId} caseId={caseId} caseNumber={caseNumber} />;
}

function CaseTowingOrders({ caseId, caseNumber }: { caseId: string; caseNumber?: string }) {
  const [workspace, setWorkspace] = useState<TowingWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [origin, setOrigin] = useState<"local" | "awp_record_only">("local");
  const [createdId, setCreatedId] = useState<string>();
  const running = useRef(false);
  const alive = useRef(true);
  const load = useCallback(async () => {
    const data = await towingClient.workspace("office", { sourceCaseId: caseId, limit: "50" });
    if (alive.current) setWorkspace(data);
    return data;
  }, [caseId]);
  useEffect(() => {
    alive.current = true;
    void load().catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : "Odťahy sa nepodarilo načítať."); }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
  }, [load]);
  const create = async () => {
    if (!workspace || running.current) return;
    running.current = true; setBusy(true); setError("");
    try {
      // Only opaque identifiers are retained. The original case snapshot is copied by the server.
      // Persist before sending, so remount/reload after a lost response retries the same command.
      const key = JSON.stringify(["towing-case-intent", workspace.actor.organizationId, workspace.actor.userId, caseId]);
      const stored = sessionStorage.getItem(key);
      let command: TowingCommand;
      if (stored) {
        const ids = JSON.parse(stored) as { commandId: string; targetId: string; executionOrigin?: "local" | "awp_record_only" };
        if (!/^[0-9a-f-]{36}$/i.test(ids.commandId) || !/^[0-9a-f-]{36}$/i.test(ids.targetId)) throw new Error("Neplatný rozpracovaný zámer odťahu.");
        command = { commandId: ids.commandId, targetId: ids.targetId, type: "create_order", payload: { sourceCaseId: caseId, fields: { serviceType: "tow", executionOrigin: ids.executionOrigin ?? "local" } } };
      } else {
        command = { commandId: crypto.randomUUID(), targetId: crypto.randomUUID(), type: "create_order", payload: { sourceCaseId: caseId, fields: { serviceType: "tow", executionOrigin: origin } } };
        sessionStorage.setItem(key, JSON.stringify({ commandId: command.commandId, targetId: command.targetId, executionOrigin: origin }));
      }
      const result = await towingClient.command(command);
      if (alive.current) setCreatedId(result.targetId);
      await load();
      sessionStorage.removeItem(key);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : "Založenie odťahu sa nepodarilo potvrdiť. Zopakujte rovnaký pokus.");
    } finally { running.current = false; if (alive.current) setBusy(false); }
  };
  return <Panel title={`Odťahy${caseNumber ? ` · ${caseNumber}` : ""}`}>
    {loading && <p role="status">Načítavam prepojené zákazky…</p>}
    {error && <Notice kind="error">{error}</Notice>}
    {workspace && <>
      {!workspace.orders.length && <p className={styles.muted}>K prípadu zatiaľ nie je evidovaný odťah.</p>}
      {workspace.orders.map(order => <div className={styles.row} key={order.id}><span><strong>{order.number}</strong> · {orderTitle(order)} · {workLabels[order.workStatus]}</span><a className={styles.button} href={`/zakazky?orderId=${encodeURIComponent(order.id)}`} target="_blank" rel="noreferrer">Otvoriť zákazku</a></div>)}
      {(workspace.totalCount ?? 0) > workspace.orders.length && <p>Zobrazených je prvých 50 zákaziek. Úplný zoznam je v knihe odťahov.</p>}
      {createdId && <Notice kind="success">Návrh odťahu je uložený. <a href={`/zakazky?orderId=${encodeURIComponent(createdId)}`} target="_blank" rel="noreferrer">Otvoriť, doplniť a prideliť vodiča</a></Notice>}
      {workspace.actor.capabilities.includes("operate") && <Select label="Spôsob vykonania nového odťahu" value={origin} disabled={busy || Boolean(error)} onChange={event => setOrigin(event.target.value as typeof origin)}><option value="local">Lokálny výkon · pridelenie vodičovi</option><option value="awp_record_only">AWP · iba evidencia, bez pridelenia vodiča</option></Select>}
      <div className={styles.actions}>{workspace.actor.capabilities.includes("operate") && <Button primary disabled={busy || loading} onClick={() => void create()}>{busy ? "Potvrdzujem založenie…" : error ? "Zopakovať rovnaké založenie" : workspace.orders.length || createdId ? "Zadať ďalší odťah" : "Zadať odťah"}</Button>}<Button disabled={busy || loading} onClick={() => { setLoading(true); setError(""); void load().catch(cause => setError(cause instanceof Error ? cause.message : "Odťahy nie sú dostupné.")).finally(() => setLoading(false)); }}>Obnoviť zoznam</Button></div>
      <p className={styles.footer}>Údaje prípadu sa skopírujú do samostatného návrhu. Zákazka sa otvorí v novej karte; pridelenie a fyzický začiatok sú samostatné kroky.</p>
    </>}
  </Panel>;
}
