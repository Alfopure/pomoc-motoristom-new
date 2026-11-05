"use client";

import { ArrowRight, ChevronRight, CircleCheck, Clock3, FileText, Search, TriangleAlert, Truck, UserRound } from "lucide-react";
import type { TowingOrder, TowingWorkspace } from "@/domain/towing/types";
import { Button, Field, Select } from "./primitives";
import { billingLabels, dateTime, euro, paymentIntentLabels, paymentLabels, workLabels } from "./model";
import { towingBookDate } from "@/domain/towing/book-query";
import { bookNet, bookRequester, bookStage, stageLabels } from "./book-model";
import styles from "./towing.module.css";

type Filters = Record<string, string>;
export const emptyBookFilters: Filters = { query: "", requester: "", requesterType: "", stage: "", sort: "operational", dateBasis: "created", workStatus: "", billingStatus: "", paymentStatus: "", branchId: "", driverId: "", fleetAssetId: "", from: "", to: "" };
export function BookOverview({ workspace, filters, setFilters, apply, loading, offset, setOffset, open }: { workspace: TowingWorkspace; filters: Filters; setFilters: (filters: Filters) => void; apply: (filters: Filters) => void; loading: boolean; offset: number; setOffset: (offset: number) => void; open: (order: TowingOrder) => void }) {
  const set = (key: string, value: string) => setFilters({ ...filters, [key]: value });
  const total = workspace.totalCount ?? workspace.orders.length;
  const members = new Map(workspace.members.map(member => [member.id, member.displayName]));
  const fleet = new Map(workspace.fleet.map(asset => [asset.id, asset.name]));
  return <section className={styles.book} aria-label="Kniha odťahových zásahov">
    <div className={styles.bookStats} aria-label="Súčty vybraných zákaziek">
      <div><Truck size={16} /><span>Zákazky vo filtri</span><strong>{total}</strong></div>
      <div><CircleCheck size={16} /><span>Schválené výkony</span><strong>{euro(workspace.summary?.approvedCents)}</strong></div>
      <div><FileText size={16} /><span>Externé faktúry</span><strong>{euro(workspace.summary?.invoicedCents)}</strong></div>
      <div><CircleCheck size={16} /><span>Prijaté platby</span><strong>{euro(workspace.summary?.receivedCents)}</strong></div>
    </div>
    <div className={styles.bookPanel}>
      <form className={styles.bookFilters} onSubmit={event => { event.preventDefault(); apply(filters); }}>
        <div className={styles.quickViews} role="group" aria-label="Rýchly pohľad podľa fázy">{[["", "Všetky"], ...Object.entries(stageLabels)].map(([stage, label]) => <button key={stage} type="button" data-stage={stage || "all"} aria-pressed={filters.stage === stage} onClick={() => { const next = { ...filters, stage }; setFilters(next); apply(next); }}>{label}</button>)}</div>
        <div className={styles.bookFilterGrid}>
          <Field label="Hľadať zákazku, vozidlo, kontakt" value={filters.query} onChange={event => set("query", event.target.value)} placeholder="Číslo, EČV alebo meno…" />
          <Field label="Objednávateľ" value={filters.requester} onChange={event => set("requester", event.target.value)} placeholder="Asistenčka alebo meno…" />
          <Select label="Vodič" value={filters.driverId} onChange={event => set("driverId", event.target.value)}><option value="">Všetci vodiči</option>{workspace.members.filter(member => member.capabilities.includes("drive")).map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</Select>
          <Select label="Pobočka" value={filters.branchId} onChange={event => set("branchId", event.target.value)}><option value="">Všetky pobočky</option>{workspace.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</Select>
          <Select label="Usporiadanie" value={filters.sort} onChange={event => set("sort", event.target.value)}><option value="operational">Prevádzkové poradie</option><option value="date_desc">Najnovšie</option><option value="date_asc">Najstaršie</option><option value="amount_desc">Najvyššia suma</option><option value="driver_asc">Podľa vodiča</option></Select>
        </div>
        <div className={styles.bookFilterActions}>
          <details className={styles.bookMore}><summary>Ďalšie filtre a obdobie</summary><div className={styles.bookAdvanced}>
            <Select label="Stav výkonu" value={filters.workStatus} onChange={event => set("workStatus", event.target.value)}><option value="">Všetky stavy</option>{Object.entries(workLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
            <Select label="Fakturácia" value={filters.billingStatus} onChange={event => set("billingStatus", event.target.value)}><option value="">Všetko</option>{Object.entries(billingLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
            <Select label="Úhrada" value={filters.paymentStatus} onChange={event => set("paymentStatus", event.target.value)}><option value="">Všetko</option>{Object.entries(paymentLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
            <Select label="Technika" value={filters.fleetAssetId} onChange={event => set("fleetAssetId", event.target.value)}><option value="">Všetka technika</option>{workspace.fleet.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</Select>
            <Select label="Typ objednávateľa" value={filters.requesterType} onChange={event => set("requesterType", event.target.value)}><option value="">Všetky typy</option><option value="assistance">Asistencia</option><option value="selfpayer">Samoplatca</option><option value="unknown">Neurčený</option></Select>
            <Select label="Obdobie podľa" value={filters.dateBasis} onChange={event => set("dateBasis", event.target.value)}><option value="created">Založenia zákazky</option><option value="dispatch">Začiatku / plánovaného termínu</option></Select>
            <Field label="Dátum od" type="date" value={filters.from} onChange={event => set("from", event.target.value)} /><Field label="Dátum do" type="date" value={filters.to} onChange={event => set("to", event.target.value)} />
          </div></details>
          <div className={styles.actions}><Button primary type="submit" disabled={loading}><Search size={14} /> Použiť filtre</Button><Button type="button" disabled={loading} onClick={() => { setFilters({ ...emptyBookFilters }); apply({ ...emptyBookFilters }); }}>Vymazať filtre</Button></div>
        </div>
      </form>
      <h2 className={styles.srOnly}>Prehľad zákaziek</h2>
      <div className={styles.tableWrap}><table className={`${styles.table} ${styles.bookTable}`}><thead><tr><th>Termín / číslo</th><th>Vozidlo / EČV</th><th>Objednávateľ / referencia</th><th>Vodič / technika</th><th>Nakládka → vykládka</th><th>Úhrada</th><th>Fáza</th><th className={styles.money}>Bez DPH</th><th className={styles.money}>S DPH</th><th><span className={styles.srOnly}>Detail</span></th></tr></thead><tbody>{workspace.orders.map(order => {
        const stage = bookStage(order); const requester = bookRequester(order); const date = towingBookDate(order, "dispatch");
        return <tr key={order.id} data-stage={stage}>
          <td><span className={styles.cellPrimary} title={date.source === "actual" ? "Skutočný začiatok" : date.source === "planned" ? "Plánovaný termín" : "Založenie · termín neurčený"}>{dateTime(date.value)}{date.source !== "actual" && <span aria-label={date.source === "planned" ? "Plánovaný termín" : "Dátum založenia"}> *</span>}</span><small>{order.number}</small></td>
          <td><button className={styles.orderLink} onClick={() => open(order)} title={order.fields.subjectDescription}>{order.fields.subjectDescription || "Predmet neurčený"}</button><small>{order.fields.plate || "EČV neuvedená"}</small></td>
          <td><span className={styles.requesterChip} data-requester-type={order.fields.requesterType ?? "unknown"} title={requester}>{requester}</span><small title={order.fields.assistanceReference || order.fields.externalReference}>{order.fields.assistanceReference || order.fields.externalReference || "Bez referencie"}</small></td>
          <td><span className={styles.cellPrimary} title={members.get(order.driverId ?? "")}>{members.get(order.driverId ?? "") || "Nepridelené"}</span><small title={fleet.get(order.fields.fleetAssetId ?? "")}>{fleet.get(order.fields.fleetAssetId ?? "") || "Technika neurčená"}</small></td>
          <td><span className={styles.cellPrimary} title={order.fields.pickup}>{order.fields.pickup || "Nakládka chýba"}</span><small title={order.fields.destination}>→ {order.fields.destination || "Cieľ neurčený"}</small></td>
          <td title={`Prijaté ${euro(order.receivedCents)}`}><span className={styles.paymentText} data-settled={order.paymentStatus === "paid"}>{paymentLabels[order.paymentStatus]}</span><small>{order.fields.paymentIntent ? paymentIntentLabels[order.fields.paymentIntent] : "Forma neurčená"}</small></td>
          <td><span className={styles.stageLabel}>{stage === "paid" ? <CircleCheck size={13} /> : stage === "active" ? <Truck size={13} /> : <Clock3 size={13} />}{stageLabels[stage]}</span>{order.reconciliationRequired ? <small className={styles.financialException}><TriangleAlert size={11} /> Finančná výnimka</small> : order.paymentStatus === "overpaid" ? <small className={styles.financialException}>Preplatok · kontrola</small> : <small>{billingLabels[order.billingStatus]}</small>}</td>
          <td className={styles.money}>{euro(bookNet(order))}</td><td className={styles.money}><strong>{euro(order.dueCents)}</strong></td>
          <td><Button aria-label={`Otvoriť ${order.number}`} onClick={() => open(order)}><ChevronRight size={16} /></Button></td>
        </tr>;
      })}</tbody></table></div>
      <div className={styles.mobileRows}>{workspace.orders.map(order => <article key={order.id} className={styles.bookCard} data-stage={bookStage(order)}><div className={styles.row}><strong>{order.number}</strong><span className={styles.stageLabel}>{stageLabels[bookStage(order)]}</span></div><h3>{order.fields.subjectDescription || "Predmet neurčený"} · {order.fields.plate || "Bez EČV"}</h3><div className={styles.row}><span className={styles.requesterChip} data-requester-type={order.fields.requesterType ?? "unknown"}>{bookRequester(order)}</span><span>{order.fields.assistanceReference || order.fields.externalReference || "Bez referencie"}</span></div><p><UserRound size={14} /> {members.get(order.driverId ?? "") || "Nepridelené"} · {dateTime(towingBookDate(order, "dispatch").value)}</p><p className={styles.cardRoute}>{order.fields.pickup || "Nakládka chýba"}<ArrowRight size={14} />{order.fields.destination || "Cieľ neurčený"}</p><div className={styles.row}><span>{paymentLabels[order.paymentStatus]}</span><strong>{euro(order.dueCents)}</strong></div>{order.reconciliationRequired && <p className={styles.financialException}><TriangleAlert size={14} /> Finančná výnimka</p>}<Button onClick={() => open(order)} aria-label={`Otvoriť ${order.number}`}>Otvoriť zákazku <ChevronRight size={16} /></Button></article>)}</div>
      {!workspace.orders.length && <div className={styles.empty}>Žiadna zákazka nezodpovedá zvoleným filtrom.</div>}
      <p className={styles.bookFootnote}>Finančné súčty za celý filter · odovzdanie hotovosti nie je ďalšia platba. * Plánovaný termín alebo dátum založenia, ak začiatok nie je známy.</p>
      <div className={styles.bookPagination}><span>{total ? `${offset + 1}–${offset + workspace.orders.length} z ${total}` : "0 zákaziek"}</span><div className={styles.actions}><Button disabled={!offset || loading} onClick={() => setOffset(Math.max(0, offset - 50))}>Predchádzajúce</Button><Button disabled={offset + workspace.orders.length >= total || loading} onClick={() => setOffset(offset + 50)}>Ďalšie</Button></div></div>
    </div>
  </section>;
}
