"use client";

import { useRef, useState } from "react";
import type { TowingCashCategory, TowingWorkspace } from "@/domain/towing/types";
import { CASH_CATEGORIES, allocateCash, cashCategoryLabels } from "@/domain/towing/cash-categories";
import { Button, Field, Panel, Select, usePendingChanges, type PendingChangesReporter } from "./primitives";
import type { SendCommand } from "./OrderDetail";
import { euro, parseCents } from "./model";
import styles from "./towing.module.css";

/** Owner's confirmed physical collection; one transfer, never another receipt. */
export function CashCollection({ workspace, busy, send, onPendingChangesChange }: {
  workspace: TowingWorkspace; busy: boolean; send: SendCommand; onPendingChangesChange?: PendingChangesReporter;
}) {
  const [driverId, setDriverId] = useState("");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState<TowingCashCategory | "all">("other");
  const [confirmed, setConfirmed] = useState(false);
  const handoverId = useRef(crypto.randomUUID());
  usePendingChanges(Boolean(amount || driverId || confirmed), onPendingChangesChange);
  const account = workspace.cashAccounts.find(item => item.driverId === driverId);
  const office = workspace.cashAccounts.find(item => item.driverId === null);
  const cents = parseCents(amount);
  const categories = account?.categories;
  const breakdown = categories && cents !== null ? category === "all" ? allocateCash(cents, categories)
    : cents <= categories[category].balanceCents - categories[category].reservedCents ? { regular: 0, other: 0, unclassified: 0, [category]: cents } : null : undefined;
  const available = account ? account.balanceCents - account.reservedCents : 0;
  const valid = Boolean(account && cents !== null && cents > 0 && cents <= available && ((categories && breakdown) || !categories && category === "all") && confirmed);
  return <Panel title="Prevziať hotovosť od vodiča">
    <p className={styles.muted}>Iná hotovosť (bez faktúry) zostáva u vodiča, kým ju majiteľ alebo poverená kancelária skutočne neprevezme. Prevzatie mení držiteľa peňazí; nevytvára ďalšiu tržbu.</p>
    <div className={styles.grid}>
      <Select label="Od ktorého vodiča" value={driverId} onChange={event => { setDriverId(event.target.value); setConfirmed(false); }}><option value="">Vyberte vodiča</option>{workspace.members.filter(member => member.active && member.capabilities.includes("drive")).map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</Select>
      <Select label="Preberaná hotovosť" value={category} onChange={event => { setCategory(event.target.value as TowingCashCategory | "all"); setConfirmed(false); }}><option value="all">Spolu</option>{CASH_CATEGORIES.map(key => <option key={key} value={key}>{cashCategoryLabels[key]}</option>)}</Select>
      <Field label="Skutočne prevzatá suma (€)" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setConfirmed(false); }} />
    </div>
    {account && !categories && category !== "all" && <p className={styles.muted}>Rozpis kategórií sa nepodarilo overiť. Obnovte pokladňu alebo vyberte Spolu.</p>}
    {account && <p className={styles.muted}>Dostupné spolu: {euro(available)}{categories && category !== "all" ? ` · ${cashCategoryLabels[category]}: ${euro(categories[category].balanceCents - categories[category].reservedCents)}` : ""}</p>}
    {breakdown && <p className={styles.muted}>{CASH_CATEGORIES.filter(key => breakdown[key] > 0).map(key => `${cashCategoryLabels[key]}: ${euro(breakdown[key])}`).join(" · ")}</p>}
    <label className={styles.check}><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> Peniaze som od vybraného vodiča skutočne prevzal(a).</label>
    <Button primary disabled={busy || !valid} onClick={async () => {
      if (!valid || !account || cents === null) return;
      if (await send({ type: "collect_cash", targetId: handoverId.current, payload: { driverId, amountCents: cents, accountRevision: account.revision, officeRevision: office?.revision ?? 1, ...(breakdown ? { cashBreakdown: breakdown } : {}) } }, "Prevzatie hotovosti je zaevidované.")) {
        handoverId.current = crypto.randomUUID(); setAmount(""); setDriverId(""); setConfirmed(false);
      }
    }}>Potvrdiť prevzatie hotovosti</Button>
  </Panel>;
}
