"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, CircleAlert, RefreshCw } from "lucide-react";
import { isHandoffReceipt, handoffEventLabels, handoffLabels, type CaseHandoff, type HandoffCommand, type HandoffReceipt } from "@/domain/case-handoff";
import { HandoffSummary } from "./HandoffSummary";
import "./case-handoff.css";

export function HandoffRecipient() {
  const [handoff, setHandoff] = useState<CaseHandoff | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [comment, setComment] = useState(""), [eta, setEta] = useState(""), [reasonAction, setReasonAction] = useState<"reject" | "blocked" | null>(null);
  const [pending, setPending] = useState<HandoffCommand | null>(null), [notice, setNotice] = useState("");
  const token = useRef<string | null>(null), expectedGrant = useRef<string | null>(null), started = useRef(false), inFlight = useRef(false);
  async function load() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      if (!token.current && !expectedGrant.current) throw new Error("Otvorte celý odkaz, ktorý vám poslal dispečer.");
      const response = await fetch(token.current ? "/api/public/handoffs/session" : `/api/public/handoffs/current?handoff=${encodeURIComponent(expectedGrant.current!)}`, token.current ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.current }), cache: "no-store", signal: AbortSignal.timeout(20_000) } : { cache: "no-store", signal: AbortSignal.timeout(20_000) });
      const data = await response.json();
      if (!response.ok) { if ([403, 404, 410].includes(response.status)) setHandoff(null); throw new Error(data.error || "Kartu sa nepodarilo načítať."); }
      token.current = null;
      expectedGrant.current = data.handoff.id;
      history.replaceState(null, "", `${location.pathname}?handoff=${encodeURIComponent(data.handoff.id)}`);
      setHandoff(data.handoff);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Kartu sa nepodarilo načítať."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  useEffect(() => {
    if (started.current) return; started.current = true;
    token.current = new URLSearchParams(location.hash.slice(1)).get("token");
    expectedGrant.current = new URLSearchParams(location.search).get("handoff");
    // Remove the bearer before loading data; no URL/log/analytics persistence.
    if (location.hash) history.replaceState(null, "", location.pathname);
    void load();
  }, []);
  useEffect(() => {
    if (!handoff) return;
    const timer = window.setInterval(() => {
      if (Date.parse(handoff.expiresAt) <= Date.now()) { setHandoff(null); setError("Platnosť odkazu skončila. Kontaktujte dispečera."); }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [handoff]);
  async function send(action: string) {
    if (!handoff || inFlight.current) return;
    const command = pending ?? { action, commandId: crypto.randomUUID(), handoffId: handoff.id, expectedRevision: handoff.revision, publishedVersion: handoff.publishedVersion, comment: comment.trim(), ...(action === "update" && eta ? { eta: new Date(eta).toISOString() } : {}) };
    setPending(command); inFlight.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/public/handoffs/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command), signal: AbortSignal.timeout(20_000) });
      const data = await response.json() as HandoffReceipt & { error?: string };
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) setPending(null);
        if ([403, 404, 410].includes(response.status)) setHandoff(null);
        throw new Error(data.error || "Zmenu sa nepodarilo uložiť.");
      }
      if (!isHandoffReceipt(data, command)) throw new Error("Potvrdenie sa nepodarilo overiť. Zopakujte tú istú požiadavku.");
      setHandoff(data.handoff); setPending(null); setComment(""); setEta(""); setReasonAction(null); setNotice("Zmena je uložená a dispečer o nej dostal upozornenie.");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Spojenie sa prerušilo. Zopakujte tú istú požiadavku."); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const terminal = handoff && ["completed", "rejected"].includes(handoff.status);
  return <main className="handoff-page"><header className="handoff-public-brand"><span>PM</span><div><strong>Pomoc motoristom</strong><p>Prípad pre externého kolegu</p></div></header>
    <article className="handoff-public-card">
      {!handoff ? <><h1>{busy ? "Načítavam kartu…" : "Odovzdanie prípadu"}</h1><p>Prístup je určený iba príjemcovi konkrétneho odkazu.</p></> : <>
        <div className="handoff-public-heading"><div><span>Pre {handoff.recipientName}</span><h1>{handoff.published?.caseNumber || "Odovzdanie prípadu"}</h1><p>{handoff.published?.action}</p></div><span className="handoff-status" data-status={handoff.status}>{handoffLabels[handoff.status]}</span></div>
        {handoff.published && <><p className="handoff-expiry">Platné do {new Date(handoff.expiresAt).toLocaleString("sk-SK")} · verzia údajov {handoff.publishedVersion}</p><HandoffSummary value={handoff.published} /></>}
        {terminal ? <div className="handoff-confirmation"><Check size={23} /><strong>{handoff.status === "completed" ? "Ďakujeme. Vykonanie úkonu je zaznamenané." : "Odmietnutie je zaznamenané."}</strong><p>Dispečer má k dispozícii vaše rozhodnutie. Údaje klienta sa už nezobrazujú.</p></div> : <section className="handoff-decisions" aria-label="Riešenie prípadu">
          {handoff.status === "offered" && !reasonAction && <><p>Skontrolujte údaje a potvrďte, či viete tento úkon prevziať.</p><div className="handoff-actions"><button disabled={busy || !!pending} className="handoff-primary" onClick={() => void send("accept")}><Check size={16} />Prijať prípad</button><button disabled={busy || !!pending} onClick={() => setReasonAction("reject")}>Odmietnuť</button></div></>}
          {handoff.status !== "offered" && !reasonAction && <><div className="handoff-actions"><button className="handoff-primary" disabled={busy || !!pending} onClick={() => void send(handoff.status === "accepted" ? "en_route" : handoff.status === "en_route" ? "arrived" : "complete")}><ArrowRight size={16} />{handoff.status === "accepted" ? "Vyrážam na cestu" : handoff.status === "en_route" ? "Som na mieste" : "Potvrdiť dokončenie"}</button><button disabled={busy || !!pending} onClick={() => setReasonAction("blocked")}><CircleAlert size={16} />Nahlásiť problém</button></div>{handoff.eta && <p>Posledný odhad príchodu: <strong>{new Date(handoff.eta).toLocaleString("sk-SK")}</strong></p>}<label>Nový odhad príchodu (voliteľné)<input type="datetime-local" value={eta} disabled={busy || !!pending} onChange={event => setEta(event.target.value)} /></label><label>Poznámka k priebehu<textarea maxLength={1000} rows={3} value={comment} disabled={busy || !!pending} onChange={event => setComment(event.target.value)} /></label><button disabled={busy || !!pending || (!comment.trim() && !eta)} onClick={() => void send("update")}>Uložiť priebeh</button></>}
          {reasonAction && <><label>{reasonAction === "reject" ? "Dôvod odmietnutia" : "Čo bráni realizácii?"}<textarea value={comment} maxLength={1000} rows={4} disabled={busy || !!pending} onChange={event => setComment(event.target.value)} /></label><div className="handoff-actions"><button disabled={busy || !!pending || !comment.trim()} onClick={() => void send(reasonAction)}>{reasonAction === "reject" ? "Potvrdiť odmietnutie" : "Odoslať problém dispečerovi"}</button><button disabled={busy || !!pending} onClick={() => { setReasonAction(null); setComment(""); }}>Späť</button></div></>}
        </section>}
        {handoff.events.length > 0 && <details className="handoff-history"><summary>Priebeh odovzdania ({handoff.events.length})</summary>{handoff.events.map(event => <div key={event.id}><strong>{handoffEventLabels[event.action] || "Zmena odovzdania"}</strong><span>{event.actor} · {new Date(event.createdAt).toLocaleString("sk-SK")}</span>{event.comment && <p>{event.comment}</p>}</div>)}</details>}
      </>}
      {notice && <p role="status" className="handoff-notice">{notice}</p>}{error && <p role="alert" className="handoff-error">{error}</p>}
      {pending ? <button disabled={busy} onClick={() => void send(pending.action)}>{busy ? "Overujem výsledok…" : "Overiť výsledok tej istej požiadavky"}</button> : <button className="handoff-refresh" disabled={busy} onClick={() => void load()}><RefreshCw size={14} />Obnoviť kartu</button>}
    </article><footer>Odkaz poskytuje prístup iba k tomuto odovzdaniu. Nepreposielajte ho ďalším osobám.</footer>
  </main>;
}
