"use client";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  CarFront,
  CheckCircle2,
  Clock3,
  Plus,
  Send,
  Trash2,
  Truck,
} from "lucide-react";
import {
  isCaseWorkReceipt,
  type CaseWorkContext,
  type CaseWorkItem,
  type CaseWorkReceipt,
  type CaseWorkResult,
} from "@/domain/case-work";
import { workKinds } from "@/domain/work-groups";
import "./case-work.css";

type Row = {
  id: string;
  kind: CaseWorkItem["kind"];
  target: string;
  pickup: string;
  destination: string;
  instructions: string;
  scheduled: string;
  scheduledAuto?: boolean;
  end: string;
  fleetAssetId: string;
  cycleId: string;
  branchId: string;
  pending?: CaseWorkItem;
  receipt?: CaseWorkReceipt;
  error?: string;
  errorStatus?: number;
};
const localInputTime = (at: Date) =>
  new Date(at.getTime() - at.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
const localTime = (value: string) =>
  value ? new Date(value).toISOString() : null;
function newRow(
  context: CaseWorkContext,
  kind: CaseWorkItem["kind"] = "delivery",
  at: Date = new Date(),
): Row {
  return {
    id: crypto.randomUUID(),
    kind,
    target: "",
    pickup: context.pickup,
    destination: context.destination,
    instructions: "",
    scheduled: localInputTime(at),
    scheduledAuto: true,
    end: "",
    fleetAssetId: "",
    cycleId: "",
    branchId: "",
  };
}
/** Each item keeps its frozen command until a matching receipt confirms its outcome. */
export function CaseWorkPanel({
  caseId,
  active = true,
  onCommitted,
  initialKinds,
}: {
  caseId: string;
  active?: boolean;
  onCommitted?: () => void;
  initialKinds?: CaseWorkItem["kind"][];
}) {
  const [context, setContext] = useState<CaseWorkContext | null>(null),
    [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [readError, setReadError] = useState(""),
    [readAttempt, setReadAttempt] = useState(0),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const running = useRef(false),
    storageKey = useRef("");
  const baselineCount = initialKinds?.length || 1;
  const makeInitialRows = useEffectEvent(
    (data: CaseWorkContext, openedAt: Date) =>
      [
        ...new Set(initialKinds?.length ? initialKinds : ["delivery" as const]),
      ].map((kind) => newRow(data, kind, openedAt)),
  );
  function refreshAutomaticTimes(current: Row[], openedAt: Date) {
    return current.map((row) =>
      row.scheduledAuto && !row.pending && !row.receipt
        ? { ...row, scheduled: localInputTime(openedAt) }
        : row,
    );
  }
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const openedAt = new Date();
    void fetch(`/api/cases/${encodeURIComponent(caseId)}/work`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error || "Príjemcov sa nepodarilo načítať.");
        return data as CaseWorkContext;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        const nextKey = `case-work:${data.actorKey}:${caseId}`;
        const keepDraft = storageKey.current === nextKey;
        storageKey.current = nextKey;
        setContext(data);
        setReadError("");
        const stored = sessionStorage.getItem(storageKey.current);
        if (stored) {
          const saved: unknown = JSON.parse(stored);
          if (
            !Array.isArray(saved) ||
            saved.length > 12 ||
            saved.some(
              (r) =>
                !r ||
                typeof r !== "object" ||
                ![
                  "id",
                  "kind",
                  "target",
                  "pickup",
                  "destination",
                  "instructions",
                  "scheduled",
                  "end",
                  "fleetAssetId",
                  "cycleId",
                  "branchId",
                ].every((key) => typeof r[key] === "string") ||
                !Object.hasOwn(workKinds, r.kind),
            )
          )
            throw new Error(
              "Rozpracované odoslanie sa nepodarilo obnoviť. Obnovte stránku; ďalšie zadanie zatiaľ neposielajte.",
            );
          setRows((current) =>
            refreshAutomaticTimes(
              keepDraft && current.length ? current : (saved as Row[]),
              openedAt,
            ),
          );
        } else {
          const defaults = makeInitialRows(data, openedAt);
          setRows((current) =>
            keepDraft && current.length
              ? refreshAutomaticTimes(current, openedAt)
              : defaults,
          );
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) {
          setContext(null);
          setReadError(
            e instanceof Error ? e.message : "Príjemcov sa nepodarilo načítať.",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [caseId, active, readAttempt]);
  useEffect(() => {
    if (
      !rows.some(
        (r) =>
          r.pending ||
          (!r.receipt &&
            (rows.length > baselineCount ||
              r.target ||
              r.instructions ||
              (r.scheduled && !r.scheduledAuto) ||
              r.end ||
              r.pickup !== context?.pickup ||
              r.destination !== context?.destination)),
      )
    )
      return;
    const guard = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [rows, context, baselineCount]);
  useEffect(() => {
    if (!context || !storageKey.current || !rows.length) return;
    try {
      const openRows = rows.filter((row) => !row.receipt);
      if (openRows.length)
        sessionStorage.setItem(storageKey.current, JSON.stringify(openRows));
      else sessionStorage.removeItem(storageKey.current);
    } catch {
      /* The send path requires storage; unsent edits retain the unload guard. */
    }
  }, [context, rows]);
  function edit(id: string, change: Partial<Row>) {
    setRows((current) =>
      current.map((r) =>
        r.id === id && !r.pending && !r.receipt
          ? { ...r, ...change, error: undefined }
          : r,
      ),
    );
  }
  async function send() {
    if (running.current || !context) return;
    const selected = rows.filter((r) => !r.receipt);
    if (!selected.length) return;
    const newIds = new Set(
      selected.filter((row) => !row.pending).map((row) => row.id),
    );
    let frozen: Row[];
    try {
      frozen = selected.map((row) => {
        if (row.pending) return row;
        const [type, target] = row.target.split(":");
        if (
          !target ||
          !["branch", "person"].includes(type) ||
          !row.pickup.trim() ||
          (row.kind === "collection" && !row.cycleId) ||
          (row.kind === "tow" && type === "person" && !row.branchId)
        )
          throw new Error(
            "Doplňte príjemcu, miesto začiatku a požadované výbery pri každej práci.",
          );
        if (
          row.end &&
          (!row.scheduled ||
            (localTime(row.end) !== null &&
              Date.parse(row.end) <= Date.parse(row.scheduled)))
        )
          throw new Error("Koniec musí nasledovať po začiatku.");
        const item: CaseWorkItem = {
          commandId: row.id,
          kind: row.kind,
          target: { type: type as "branch" | "person", id: target },
          pickup: row.pickup,
          destination: row.destination,
          instructions: row.instructions,
          scheduledAt: localTime(row.scheduled),
          plannedEndAt: localTime(row.end),
          fleetAssetId: row.fleetAssetId || null,
          cycleId: row.cycleId || null,
          branchId: row.branchId || null,
        };
        return { ...row, pending: item, error: undefined };
      });
      // Persist before the first send, so a lost response/reload retains the same intent.
      sessionStorage.setItem(storageKey.current, JSON.stringify(frozen));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Rozpracované zadanie sa nepodarilo uchovať.",
      );
      return;
    }
    const merged = rows.map(
      (row) => frozen.find((r) => r.id === row.id) ?? row,
    );
    setRows(merged);
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        `/api/cases/${encodeURIComponent(caseId)}/work`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: frozen.map((r) => r.pending) }),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const data = await response.json();
      if (
        !response.ok &&
        [400, 413, 415].includes(response.status) &&
        ["invalid_input", "too_large"].includes(data.code)
      ) {
        // An earlier unknown intent may already exist. Only brand-new IDs can
        // be released after this proven preexecution rejection of the envelope.
        setRows(
          merged.map((row) =>
            newIds.has(row.id)
              ? {
                  ...row,
                  error:
                    typeof data.error === "string"
                      ? data.error
                      : "Skontrolujte zadanie.",
                  errorStatus: 400,
                }
              : row,
          ),
        );
        return;
      }
      if (!response.ok)
        throw new Error(
          data.error || "Odoslanie nie je potvrdené. Overte tie isté práce.",
        );
      const results: CaseWorkResult[] = Array.isArray(data.results)
        ? data.results
        : [];
      const next = merged.map((row) => {
        if (!row.pending) return row;
        const result = results.find((r) => r.commandId === row.id);
        return result &&
          "receipt" in result &&
          isCaseWorkReceipt(result.receipt, row.pending)
          ? {
              ...row,
              pending: undefined,
              receipt: result.receipt,
              error: undefined,
            }
          : {
              ...row,
              error:
                result && "error" in result && typeof result.error === "string"
                  ? result.error
                  : "Výsledok nie je potvrdený. Overte tú istú prácu.",
              errorStatus: result && "error" in result ? result.status : 503,
            };
      });
      const remaining = next.filter((row) => row.pending);
      if (remaining.length)
        sessionStorage.setItem(storageKey.current, JSON.stringify(remaining));
      else sessionStorage.removeItem(storageKey.current);
      setRows(next);
      if (
        next.some(
          (row) =>
            row.receipt &&
            !merged.find((previous) => previous.id === row.id)?.receipt,
        )
      )
        onCommitted?.();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Výsledok nie je potvrdený. Overte tie isté práce.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function editRejected(row: Row) {
    if (row.errorStatus !== 400) return;
    try {
      const remaining = rows.filter((r) => r.pending && r.id !== row.id);
      if (remaining.length)
        sessionStorage.setItem(storageKey.current, JSON.stringify(remaining));
      else sessionStorage.removeItem(storageKey.current);
    } catch {
      setError("Rozpracované zadania sa nepodarilo uchovať. Skúste znova.");
      return;
    }
    setRows((current) =>
      current.map((r) =>
        r.id === row.id
          ? {
              ...r,
              id: crypto.randomUUID(),
              pending: undefined,
              error: undefined,
              errorStatus: undefined,
            }
          : r,
      ),
    );
  }
  const waiting = rows.filter((r) => !r.receipt).length;
  return (
    <section className="case-work" aria-label="Samostatné zadania práce">
      <div className="case-work-title">
        <div>
          <h3>Vyberte príjemcov práce</h3>
          <p>
            Pre každú prácu vyberte pobočku alebo človeka. Termín je
            predvyplnený aktuálnym časom.
          </p>
        </div>
      </div>
      {loading && <p role="status">Načítavam príjemcov…</p>}
      {readError && (
        <p role="alert" className="handoff-error">
          {readError}
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              setReadAttempt((value) => value + 1);
            }}
          >
            Obnoviť príjemcov
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="handoff-error">
          {error}
        </p>
      )}
      {context?.existing?.length ? (
        <details className="case-work-existing">
          <summary>
            Už zadané práce (
            {`${context.existing.length}${context.existingMore ? "+" : ""}`})
          </summary>
          <ul>
            {context.existing.map((work) => (
              <li key={work.id}>
                <strong>{workKinds[work.kind]}</strong>
                <span>{work.recipient}</span>
                <span>
                  {(
                    {
                      queued: "V rade",
                      claimed: "Prevzal dispečer",
                      assigned: "Pridelené",
                      accepted: "Prijaté",
                      en_route: "Na ceste",
                      arrived: "Na mieste",
                      collected: "Vyzdvihnuté",
                      completed: "Dokončené",
                      submitted: "Odovzdané kancelárii",
                      in_progress: "V realizácii",
                      cancelled: "Zrušené",
                      draft: "Návrh",
                      needs_changes: "Na doplnenie",
                    } as Record<string, string>
                  )[work.status] ?? work.status}
                </span>
              </li>
            ))}
          </ul>
          {context.existingMore && (
            <p className="handoff-small">
              Ďalšie práce sú v prevádzkovom prehľade a v rade pobočky.
            </p>
          )}
        </details>
      ) : null}
      <div className="case-work-items">
        {context &&
          rows.map((row, index) => {
            const locked = busy || !!row.pending || !!row.receipt;
            const people = context.people.filter((p) =>
              p.kinds.includes(row.kind),
            );
            const groups = context.groups.filter((g) =>
              g.kinds.includes(row.kind),
            );
            return (
              <article
                key={row.id}
                className="case-work-item"
                data-kind={row.kind}
                aria-label={`Práca ${index + 1}: ${workKinds[row.kind]}`}
              >
                <div className="case-work-item-title">
                  <div className="case-work-item-heading">
                    <span className="case-work-kind-icon">
                      {row.kind === "tow" ? (
                        <Truck size={19} aria-hidden="true" />
                      ) : (
                        <CarFront size={19} aria-hidden="true" />
                      )}
                    </span>
                    <div>
                      <small>Práca {index + 1}</small>
                      <h4>{workKinds[row.kind]}</h4>
                    </div>
                  </div>
                  {row.receipt ? (
                    <span role="status">
                      <CheckCircle2 size={15} />{" "}
                      {row.receipt.owner === "branch"
                        ? "V rade pobočky"
                        : "Pridelené v aplikácii"}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Odstrániť prácu ${index + 1}`}
                      disabled={locked || rows.length === 1}
                      onClick={() =>
                        setRows((current) =>
                          current.filter((r) => r.id !== row.id),
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
                <fieldset disabled={locked} className="case-work-grid">
                  <div className="case-work-fields">
                    <label className="case-work-full">
                      Príjemca
                      <select
                        aria-label="Príjemca"
                        value={row.target}
                        onChange={(e) =>
                          edit(row.id, { target: e.target.value, end: "" })
                        }
                      >
                        <option value="">Vyberte pobočku alebo človeka</option>
                        <optgroup label="Pobočky">
                          {groups.map((g) => (
                            <option key={g.id} value={`branch:${g.id}`}>
                              {g.name}
                            </option>
                          ))}
                        </optgroup>
                        <optgroup label="Ľudia">
                          {people.map((p) => (
                            <option key={p.id} value={`person:${p.id}`}>
                              {p.name}
                            </option>
                          ))}
                        </optgroup>
                      </select>
                    </label>
                    <div className="case-work-kind-time">
                      <label>
                        Druh práce
                        <select
                          aria-label="Druh práce"
                          value={row.kind}
                          onChange={(e) =>
                            edit(row.id, {
                              kind: e.target.value as Row["kind"],
                              target: "",
                              fleetAssetId: "",
                              cycleId: "",
                            })
                          }
                        >
                          {Object.entries(workKinds).map(([v, label]) => (
                            <option key={v} value={v}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Dohodnutý termín
                        <span className="case-work-date-input">
                          <input
                            aria-label="Dohodnutý termín"
                            type="datetime-local"
                            value={row.scheduled}
                            onChange={(e) =>
                              edit(row.id, {
                                scheduled: e.target.value,
                                scheduledAuto: false,
                              })
                            }
                          />
                          <button
                            type="button"
                            aria-label={`Nastaviť aktuálny čas pre prácu ${index + 1}`}
                            onClick={() =>
                              edit(row.id, {
                                scheduled: localInputTime(new Date()),
                                scheduledAuto: false,
                              })
                            }
                          >
                            <Clock3 size={14} aria-hidden="true" />
                            Teraz
                          </button>
                        </span>
                      </label>
                    </div>
                    <label>
                      Začiatok / nakládka
                      <input
                        value={row.pickup}
                        maxLength={1000}
                        onChange={(e) => edit(row.id, { pickup: e.target.value })}
                      />
                    </label>
                    <label>
                      Cieľ / vykládka
                      <input
                        value={row.destination}
                        maxLength={1000}
                        onChange={(e) =>
                          edit(row.id, { destination: e.target.value })
                        }
                      />
                    </label>
                    {row.target.startsWith("person:") && row.kind !== "tow" && (
                      <label>
                        Predpokladaný koniec
                        <input
                          type="datetime-local"
                          value={row.end}
                          min={row.scheduled || undefined}
                          onChange={(e) => edit(row.id, { end: e.target.value })}
                        />
                      </label>
                    )}
                    {row.kind === "tow" && row.target.startsWith("person:") && (
                      <label>
                        Výkonná pobočka
                        <select
                          value={row.branchId}
                          onChange={(e) =>
                            edit(row.id, { branchId: e.target.value })
                          }
                        >
                          <option value="">Vyberte pobočku</option>
                          {context.branches.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {row.kind !== "tow" && row.kind !== "collection" && (
                      <label>
                        Vozidlo (nepovinné)
                        <select
                          value={row.fleetAssetId}
                          onChange={(e) =>
                            edit(row.id, { fleetAssetId: e.target.value })
                          }
                        >
                          <option value="">Bez výberu</option>
                          {context.fleet.map((f) => (
                            <option key={f.id} value={f.id}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {row.kind === "collection" && (
                      <label>
                        Používanie vozidla
                        <select
                          value={row.cycleId}
                          onChange={(e) =>
                            edit(row.id, { cycleId: e.target.value })
                          }
                        >
                          <option value="">Vyberte vozidlo na odvoz</option>
                          {context.cycles.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.vehicle}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="case-work-notes">
                    <p className="case-work-recipient-hint">
                      {row.target.startsWith("branch:")
                        ? "Pobočka prevezme prácu a pridelí vykonávateľa."
                        : row.target.startsWith("person:")
                          ? "Vybraný človek dostane vlastnú prácu v aplikácii."
                          : "Pobočka ju zaradí do svojho radu; človek ju dostane priamo."}
                    </p>
                    <label className="case-work-full">
                      Pokyny pre tohto príjemcu
                      <textarea
                        rows={2}
                        maxLength={4000}
                        value={row.instructions}
                        onChange={(e) =>
                          edit(row.id, { instructions: e.target.value })
                        }
                      />
                    </label>
                  </div>
                </fieldset>
                {row.error && (
                  <p role="alert" className="handoff-error">
                    {row.error}
                    {row.errorStatus === 400 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => editRejected(row)}
                      >
                        Upraviť odmietnuté zadanie
                      </button>
                    )}
                  </p>
                )}
                {row.pending && (
                  <p className="handoff-small">
                    Zadanie je uchované. Opakovanie overí tú istú prácu a
                    nevytvorí novú.
                  </p>
                )}
              </article>
            );
          })}
      </div>
      {context && (
        <div className="case-work-actions">
          <button
            type="button"
            disabled={busy || rows.length >= 12}
            onClick={() => setRows((current) => [...current, newRow(context)])}
          >
            <Plus size={15} />
            Pridať prácu
          </button>
          <button
            className="handoff-primary"
            type="button"
            disabled={busy || !waiting}
            onClick={() => void send()}
          >
            <Send size={15} />
            {busy
              ? "Overujem odoslanie…"
              : rows.some((r) => r.pending)
                ? "Overiť nepotvrdené práce"
                : `Odovzdať práce (${waiting})`}
          </button>
        </div>
      )}
    </section>
  );
}
