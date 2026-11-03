"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Operation, OperationCommand, OperationReceipt, OperationsWorkspace } from "@/domain/operations";
import type { TowingOrder } from "@/domain/towing/types";
import type { RunOperation } from "./OrderDetail";
import { Button, Notice, Panel, Select } from "./primitives";
import styles from "./towing.module.css";

export function VehicleReturnLink({ order, blocked, run }: { order: TowingOrder; blocked: boolean; run: RunOperation }) {
  const [workspace, setWorkspace] = useState<OperationsWorkspace | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [cycleId, setCycleId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<OperationCommand | null>(null);
  const pendingRef = useRef<OperationCommand | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ ownerId: order.id, limit: "1" });
    const response = await fetch(`/api/operations?${query}`, { cache: "no-store", credentials: "same-origin", signal: signal ?? AbortSignal.timeout(30_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Cyklus návratu sa nepodarilo načítať.");
    const current = data as OperationsWorkspace;
    const tow = current.operations.find(item => item.owner === "towing_order" && item.ownerId === order.id) ?? null;
    return { workspace: current, operation: tow };
  }, [order.id]);
  const intentKey = (data: OperationsWorkspace) => JSON.stringify(["towing-return-link", data.actor.organizationId, data.actor.userId, order.id]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(current => {
      if (controller.signal.aborted) return;
      setWorkspace(current.workspace); setOperation(current.operation); setError("");
      const key = JSON.stringify(["towing-return-link", current.workspace.actor.organizationId, current.workspace.actor.userId, order.id]);
      try {
        const saved = JSON.parse(sessionStorage.getItem(key) ?? "null") as OperationCommand | null;
        if (saved?.action === "link_towing_return" && saved.operationId === current.operation?.id && typeof saved.commandId === "string" && typeof saved.payload?.cycleId === "string") {
          pendingRef.current = saved; setPending(saved); setCycleId(saved.payload.cycleId);
        }
      } catch { /* Optional persistence; mounted retries still keep the same command. */ }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Návrat vozidla nie je dostupný."); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load, order.id, order.revision]);

  const link = async () => {
    if (!workspace || !operation || !cycleId || blocked) return;
    const command: OperationCommand = pendingRef.current ?? { commandId: crypto.randomUUID(), action: "link_towing_return", operationId: operation.id, expectedRevision: operation.revision, payload: { cycleId } };
    pendingRef.current = command; setPending(command); setError("");
    try { sessionStorage.setItem(intentKey(workspace), JSON.stringify(command)); } catch { /* Mounted retry remains available. */ }
    await run(`towing-return:${command.commandId}`, async () => {
      let response: Response;
      try {
        response = await fetch("/api/operations", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(75_000) });
      } catch { throw new Error("Spojenie sa prerušilo. Overte rovnaký zámer prepojenia; nevytvárajte ďalší odvoz."); }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) {
          const current = await load();
          setWorkspace(current.workspace); setOperation(current.operation);
        }
        if (response.status < 500) {
          pendingRef.current = null; setPending(null);
          try { sessionStorage.removeItem(intentKey(workspace)); } catch { /* Optional persistence. */ }
        }
        throw new Error(body?.error ?? "Prepojenie návratu sa nepodarilo potvrdiť.");
      }
      const receipt = body as OperationReceipt | null;
      if (receipt?.commandId !== command.commandId || receipt.operation?.id !== operation.id || receipt.operation.cycleId !== command.payload.cycleId || !Number.isSafeInteger(receipt.committedRevision)) {
        throw new Error("Server nepotvrdil prepojenie konkrétneho návratu. Overte rovnaký zámer.");
      }
      setOperation(receipt.operation);
      pendingRef.current = null; setPending(null);
      try { sessionStorage.removeItem(intentKey(workspace)); } catch { /* Optional persistence. */ }
      return receipt;
    }, "Návrat je prepojený s týmto odťahom. Po dokončení odťahu pokračujte kontrolou auta vo Výjazdoch a odvozoch.");
  };

  const linkedCycle = workspace?.cycles?.find(cycle => cycle.id === operation?.cycleId);
  const linkedVehicle = linkedCycle?.vehicle ?? workspace?.fleet.find(asset => asset.id === operation?.cycle?.fleetAssetId)?.name;
  return <Panel title="Návrat náhradného auta odťahom">
    {loading && <p role="status">Načítavam existujúce cykly vozidiel…</p>}
    {error && <Notice kind="error">{error}</Notice>}
    {operation?.cycleId ? <Notice>Tento odťah vracia {linkedVehicle || "vozidlo"} · cyklus {operation.cycleId}. Dokončenie odťahu zaeviduje návrat auta; kontrola auta nasleduje vo Výjazdoch a odvozoch.</Notice> : workspace && !loading && <>
      {!operation ? <p className={styles.muted}>Prepojený výkon odťahu nie je dostupný. Obnovte zákazku.</p> : <>
        <p className={styles.muted}>Vyberte konkrétny otvorený cyklus náhradného auta. Tento odťah zostáva jediným výkonom návratu.</p>
        <Select label="Cyklus vracaného náhradného auta" value={cycleId} disabled={blocked || Boolean(pending)} onChange={event => setCycleId(event.target.value)}><option value="">Vyberte existujúci cyklus</option>{(workspace.cycles ?? []).map(cycle => <option key={cycle.id} value={cycle.id}>{cycle.vehicle} · {cycle.caseNumber ?? "bez prípadu"}</option>)}</Select>
        {!(workspace.cycles?.length) && <p className={styles.muted}>Nie je dostupný otvorený cyklus. Najprv overte existujúci cyklus vo Výjazdoch a odvozoch.</p>}
      </>}
    </>}
    {pending && <Notice>Výsledok prepojenia ešte nie je potvrdený. Opakovanie použije ten istý zámer.</Notice>}
    {operation && (!operation.cycleId || pending) && <div className={styles.actions}><Button primary disabled={blocked || loading || !cycleId || (!pending && ["submitted", "cancelled"].includes(order.workStatus))} onClick={() => void link()}>{pending ? "Overiť a zopakovať rovnaké prepojenie" : "Prepojiť návrat s týmto odťahom"}</Button></div>}
  </Panel>;
}
