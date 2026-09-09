"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Archive,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Clock3,
  History,
  Layers3,
  ListChecks,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import { areas, catalog, catalogVersion } from "@/lib/catalog";
import {
  exportCsv,
  metrics,
  severityLabels,
  statusHelp,
  statusLabels,
  statuses,
  type Actor,
  type Assessment,
  type AuditEvent,
  type Command,
  type ResultInput,
  type Run,
  type RunInput,
  type Scenario,
  type Status,
  type Store,
} from "@/lib/model";

const targetDefault =
  "https://pomoc-motoristom-new-git-dev-alfopures-projects.vercel.app";
const areaName = (id: string) => areas.find((a) => a.id === id)?.name ?? id;
const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((x) => x[0])
    .join("")
    .toUpperCase();
const dateTime = (value: string) =>
  new Intl.DateTimeFormat("sk", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
const emptyResult: ResultInput = {
  status: "untested",
  note: "",
  severity: "",
  owner: "",
  issueUrl: "",
};
function inputFrom(result?: Assessment): ResultInput {
  return result
    ? {
        status: result.status,
        note: result.note,
        severity: result.severity,
        owner: result.owner,
        issueUrl: result.issueUrl,
      }
    : { ...emptyResult };
}

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, payload?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: payload === undefined ? "GET" : "POST",
      headers:
        payload === undefined
          ? undefined
          : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ApiError(
      "Spojenie sa prerušilo. Rozpracované údaje zostali zachované. Skúste to znova.",
      0,
    );
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      data.error ?? "Požiadavku sa nepodarilo dokončiť.",
      response.status,
    );
  return data as T;
}

function Badge({ status }: { status: Status }) {
  return (
    <span className={`badge status-${status}`}>
      <span className="status-dot" />
      {statusLabels[status]}
    </span>
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-symbol">
        <CheckCheck size={23} strokeWidth={2.5} />
      </span>
      <span>
        Pomoc motoristom<small>TESTOVACÍ PRIESTOR</small>
      </span>
    </div>
  );
}
function download(filename: string, value: string, type: string) {
  const objectUrl = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    return () => {
      el.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? "modal-wide" : ""}`}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div className="modal-content">
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Zavrieť"
            onClick={onClose}
          >
            <X size={21} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export function Tracker() {
  const [actor, setActor] = useState<Actor | null>(null);
  const [ready, setReady] = useState(false);
  const [store, setStore] = useState<Store | null>(null);
  const storeRef = useRef<Store | null>(null);
  const [runId, setRunId] = useState("");
  const [level, setLevel] = useState<1 | 2>(1);
  const [area, setArea] = useState("all");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [mine, setMine] = useState(false);
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const [history, setHistory] = useState(false);
  const [help, setHelp] = useState(false);
  const [rename, setRename] = useState(false);
  const [error, setError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState("");
  const [notice, setNotice] = useState("");
  const actorRef = useRef<Actor | null>(null);
  const initStarted = useRef(false);

  const accept = useCallback((next: Store) => {
    if (storeRef.current && next.revision < storeRef.current.revision) return;
    storeRef.current = next;
    setStore(next);
    setLastSync(new Date().toISOString());
    setError("");
    setRunId((old) =>
      next.runs.some((r) => r.id === old)
        ? old
        : (next.runs.find((r) => !r.archived)?.id ?? ""),
    );
  }, []);
  const load = useCallback(
    async (quiet = false) => {
      if (!actorRef.current) return;
      if (!quiet) setSyncing(true);
      try {
        const data = await request<{ store?: Store; actor: Actor }>(
          `/api/tracker?revision=${storeRef.current?.revision ?? -1}`,
        );
        if (data.actor.id !== actorRef.current?.id) {
          actorRef.current = data.actor;
          setActor(data.actor);
          setNotice(
            `Meno v tomto prehliadači sa zmenilo na ${data.actor.name}.`,
          );
        }
        if (data.store) accept(data.store);
        else {
          setError("");
          setLastSync(new Date().toISOString());
        }
      } catch (e) {
        setError((e as Error).message);
        if ((e as ApiError).status === 401) setRename(true);
      } finally {
        if (!quiet) setSyncing(false);
      }
    },
    [accept],
  );
  useEffect(() => {
    if (initStarted.current) return;
    initStarted.current = true;
    void (async () => {
      try {
        const data = await request<{ actor: Actor | null }>("/api/session");
        if (data.actor) {
          actorRef.current = data.actor;
          setActor(data.actor);
          const entry = await request<{ store: Store }>("/api/tracker", {
            kind: "entry",
            requestId: crypto.randomUUID(),
            actorId: data.actor.id,
          });
          accept(entry.store);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setReady(true);
      }
    })();
  }, [accept]);
  useEffect(() => {
    if (!actor) return;
    const refresh = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    const timer = setInterval(refresh, 25_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [actor, load]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  async function enter(name: string) {
    const data = await request<{ actor: Actor }>("/api/session", { name });
    actorRef.current = data.actor;
    setActor(data.actor);
    setRename(false);
    await load();
  }
  async function command(value: Command): Promise<Store> {
    const data = await request<{ store: Store }>("/api/tracker", {
      ...value,
      actorId: actorRef.current?.id,
    });
    accept(data.store);
    return data.store;
  }
  const run = store?.runs.find((r) => r.id === runId);
  const runOptions = store?.runs.filter((r) => archived || !r.archived) ?? [];
  const scope = (run?.scenarios ?? catalog).filter(
    (s) => level === 2 || s.level === 1,
  );
  const results = run?.results ?? {};
  const summary = metrics(scope, results);
  const query = search.trim().toLocaleLowerCase("sk");
  const filtered = scope.filter(
    (s) =>
      (area === "all" || s.area === area) &&
      (status === "all" || (results[s.id]?.status ?? "untested") === status) &&
      (!mine || results[s.id]?.actor.name === actor?.name) &&
      (!query ||
        `${s.id} ${s.title} ${areaName(s.area)} ${results[s.id]?.note ?? ""}`
          .toLocaleLowerCase("sk")
          .includes(query)),
  );
  const selectedScenario = run?.scenarios.find((s) => s.id === selected);
  const scopeEvents = store?.events.filter((e) => e.runId === run?.id) ?? [];
  const participantNames = [
    ...new Set(
      scopeEvents
        .filter((e) => e.kind === "result_saved")
        .map((e) => e.actor.name),
    ),
  ];
  const changed = area !== "all" || status !== "all" || !!search || mine;
  function resetFilters() {
    setArea("all");
    setStatus("all");
    setSearch("");
    setMine(false);
  }
  function csv() {
    if (run)
      download(
        `testovanie-${run.id.slice(0, 8)}.csv`,
        exportCsv(run, filtered),
        "text/csv;charset=utf-8",
      );
  }

  if (!ready)
    return (
      <main className="loading-screen">
        <Brand />
        <LoaderCircle className="spin" size={26} />
        <p>Pripravujeme testovací priestor…</p>
      </main>
    );
  if (!actor) return <Welcome onEnter={enter} initialError={error} />;

  return (
    <>
      <header className="topbar">
        <Brand />
        <div className="top-actions">
          <span
            className={`sync-indicator ${error ? "sync-error" : ""}`}
            title={lastSync ? `Posledná obnova: ${dateTime(lastSync)}` : ""}
          >
            <span />
            {error ? "Spojenie prerušené" : "Spoločná evidencia"}
          </span>
          <button
            className="button ghost desktop-label"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={17} />
            Ako testovať
          </button>
          <button
            className="person-button"
            onClick={() => setRename(true)}
            title="Zmeniť meno"
          >
            <span className="avatar">{initials(actor.name)}</span>
            <span>{actor.name}</span>
            <ChevronDown size={14} />
          </button>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">PREHĽAD</div>
          <button
            className={`area-button ${area === "all" ? "active" : ""}`}
            onClick={() => setArea("all")}
          >
            <Layers3 size={18} />
            <span>Všetky oblasti</span>
            <b>{scope.length}</b>
          </button>
          <div className="sidebar-heading sidebar-section">
            OBLASTI TESTOVANIA <span>16</span>
          </div>
          <nav aria-label="Oblasti testovania">
            {areas.map((a, i) => {
              const items = scope.filter((s) => s.area === a.id);
              const m = metrics(items, results);
              return (
                <button
                  key={a.id}
                  className={`area-button ${area === a.id ? "active" : ""}`}
                  onClick={() => setArea(a.id)}
                  title={a.description}
                >
                  <span className="area-number">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span>{a.short}</span>
                  <small>
                    {m.executed}/{items.length}
                  </small>
                </button>
              );
            })}
          </nav>
          <div className="sidebar-note">
            <ShieldCheck size={19} />
            <strong>Každá zmena má históriu</strong>
            <p>Výsledky aj poznámky sa ukladajú s menom a časom.</p>
            <button onClick={() => setHistory(true)}>
              Otvoriť históriu <ArrowRight size={14} />
            </button>
          </div>
        </aside>
        <main className="main">
          <div className="page-kicker">
            <span className="eyebrow">DISPEČING / TESTOVANIE</span>
            <div className="inline-actions">
              <button className="button ghost" onClick={() => setHistory(true)}>
                <History size={17} />
                História
              </button>
              <button
                className="button secondary"
                onClick={csv}
                disabled={!run}
              >
                <ArrowDownToLine size={16} />
                Export CSV
              </button>
            </div>
          </div>
          <div className="page-title">
            <div>
              <h1>Overme, že všetko funguje.</h1>
              <p>Jasné kroky. Spoločné výsledky. Žiadne stratené poznámky.</p>
            </div>
            <button className="button primary" onClick={() => setEditor("new")}>
              <Plus size={18} />
              Nové kolo
            </button>
          </div>
          {error && (
            <div className="notice error" role="alert">
              <span>{error}</span>
              <button onClick={() => void load()}>
                <RefreshCw size={16} />
                Skúsiť znova
              </button>
            </div>
          )}
          {run ? (
            <>
              <section className="run-bar" aria-label="Testovacie kolo">
                <div className="run-symbol">
                  <ClipboardCheck size={23} />
                </div>
                <div className="run-choice">
                  <label htmlFor="run-select">TESTOVACIE KOLO</label>
                  <select
                    id="run-select"
                    value={runId}
                    onChange={(e) => {
                      setRunId(e.target.value);
                      resetFilters();
                    }}
                  >
                    {runOptions.map((r) => (
                      <option value={r.id} key={r.id}>
                        {r.title}
                        {r.archived ? " · archív" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <span className={`stage-tag ${run.stage}`}>
                  {run.stage === "internal" ? "Interné" : "Klientské"}
                </span>
                <div className="run-context">
                  <span title={run.version}>{run.version}</span>
                  <small>{run.device}</small>
                </div>
                <a
                  className="button ghost open-app"
                  href={run.targetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Otvoriť dispečing <ArrowUpRight size={17} />
                </a>
                <button
                  className="icon-button"
                  title="Podmienky a nastavenie kola"
                  aria-label="Podmienky a nastavenie kola"
                  onClick={() => setEditor("edit")}
                >
                  <SlidersHorizontal size={18} />
                </button>
              </section>
              {run.archived && (
                <div className="notice">
                  Toto kolo je archivované. Výsledky a história zostávajú
                  dostupné na čítanie.
                </div>
              )}
              <div className="scope-line">
                <div className="level-switch" aria-label="Úroveň testov">
                  <button
                    className={level === 1 ? "selected" : ""}
                    onClick={() => setLevel(1)}
                  >
                    <span>1</span>Základná sada
                  </button>
                  <button
                    className={level === 2 ? "selected" : ""}
                    onClick={() => setLevel(2)}
                  >
                    <span>2</span>Kompletná sada
                  </button>
                </div>
                <p>
                  {level === 1
                    ? "Bežný pracovný deň a kľúčové riziká"
                    : "Základ + rozšírené funkcie a situácie"}
                </p>
                <label className="archive-toggle">
                  <input
                    type="checkbox"
                    checked={archived}
                    onChange={(e) => {
                      setArchived(e.target.checked);
                      if (!e.target.checked && run.archived)
                        setRunId(
                          store?.runs.find((r) => !r.archived)?.id ?? "",
                        );
                    }}
                  />
                  Aj archív
                </label>
              </div>
              <section className="stats" aria-label="Postup testovania">
                <div className="stat stat-progress">
                  <div>
                    <span>Vykonané testy</span>
                    <ListChecks size={18} />
                  </div>
                  <strong>
                    {summary.executed}
                    <small> / {summary.relevant}</small>
                  </strong>
                  <div className="progress-track">
                    <span style={{ width: `${summary.percent}%` }} />
                  </div>
                  <small>
                    {summary.percent} % vykonaných
                    {summary.counts.na
                      ? ` · ${summary.counts.na} mimo rozsahu`
                      : ""}
                  </small>
                </div>
                <div className="stat">
                  <div>
                    <span>Akceptované</span>
                    <Check size={18} className="green" />
                  </div>
                  <strong>{summary.counts.accepted}</strong>
                  <small>Očakávaný výsledok splnený</small>
                </div>
                <div className="stat">
                  <div>
                    <span>S výhradou</span>
                    <CircleHelp size={18} className="amber" />
                  </div>
                  <strong>{summary.counts.reservation}</strong>
                  <small>Drobný nedostatok na doriešenie</small>
                </div>
                <div className="stat">
                  <div>
                    <span>Na vyriešenie</span>
                    <span className="problem-mark">!</span>
                  </div>
                  <strong>
                    {summary.counts.rejected + summary.counts.blocked}
                  </strong>
                  <small>
                    {summary.counts.rejected} neakceptovaných ·{" "}
                    {summary.counts.blocked} blokovaných
                  </small>
                </div>
              </section>
              {summary.serious > 0 && (
                <div className="notice error">
                  <strong>
                    {summary.serious} kritických alebo závažných chýb
                  </strong>
                  <span>Pred akceptáciou ich treba vyriešiť a overiť.</span>
                  <button onClick={() => setStatus("rejected")}>
                    Zobraziť chyby
                  </button>
                </div>
              )}
              <div className="mobile-area">
                <label htmlFor="mobile-area">Oblasť</label>
                <select
                  id="mobile-area"
                  value={area}
                  onChange={(e) => setArea(e.target.value)}
                >
                  <option value="all">Všetky oblasti</option>
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <section className="test-list">
                <div className="list-heading">
                  <div>
                    <h2>
                      {area === "all" ? "Testovacie scenáre" : areaName(area)}{" "}
                      <span>{filtered.length}</span>
                    </h2>
                    <p>Otvorte test, prejdite kroky a zapíšte výsledok.</p>
                  </div>
                  <button
                    className={`icon-button ${syncing ? "spin" : ""}`}
                    onClick={() => void load()}
                    disabled={syncing}
                    title="Obnoviť výsledky"
                    aria-label="Obnoviť výsledky"
                  >
                    <RefreshCw size={18} />
                  </button>
                </div>
                <div className="filters">
                  <div className="search-field">
                    <Search size={18} />
                    <input
                      aria-label="Hľadať test alebo poznámku"
                      placeholder="Hľadať test, ID alebo poznámku…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        className="icon-button"
                        onClick={() => setSearch("")}
                        aria-label="Vymazať hľadanie"
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  <select
                    aria-label="Filter výsledkov"
                    value={status}
                    onChange={(e) => setStatus(e.target.value)}
                  >
                    <option value="all">Všetky výsledky</option>
                    {statuses.map((s) => (
                      <option value={s} key={s}>
                        {statusLabels[s]}
                      </option>
                    ))}
                  </select>
                  <button
                    className={`button filter-mine ${mine ? "selected" : ""}`}
                    onClick={() => setMine(!mine)}
                  >
                    <Users size={16} />
                    Moje zápisy
                  </button>
                  {changed && (
                    <button className="text-button" onClick={resetFilters}>
                      Zrušiť filtre
                    </button>
                  )}
                </div>
                <div className="table-head">
                  <span>SCENÁR</span>
                  <span>OBLASŤ</span>
                  <span>VÝSLEDOK</span>
                  <span>POSLEDNÝ ZÁPIS</span>
                  <span />
                </div>
                <div className="scenario-rows">
                  {filtered.map((s) => {
                    const result = results[s.id];
                    return (
                      <button
                        key={s.id}
                        className="scenario-row"
                        onClick={() => setSelected(s.id)}
                        aria-label={`${s.id}: ${s.title}`}
                      >
                        <div className="scenario-title">
                          <span className="scenario-id">
                            {s.id}
                            <span className={`level-mini level-${s.level}`}>
                              L{s.level}
                            </span>
                            {s.audience === "internal" && (
                              <span className="technical">Technický</span>
                            )}
                          </span>
                          <strong>{s.title}</strong>
                          {result?.note && (
                            <span className="row-note">{result.note}</span>
                          )}
                        </div>
                        <span className="row-area">
                          {areas.find((a) => a.id === s.area)?.short}
                        </span>
                        <div className="row-status">
                          <Badge status={result?.status ?? "untested"} />
                        </div>
                        <div className="row-author">
                          {result ? (
                            <>
                              <span>{result.actor.name}</span>
                              <small>{dateTime(result.updatedAt)}</small>
                            </>
                          ) : (
                            <span className="muted">Čaká na overenie</span>
                          )}
                        </div>
                        <ChevronRight className="row-arrow" size={17} />
                      </button>
                    );
                  })}
                </div>
                {!filtered.length && (
                  <div className="empty">
                    <Search size={28} />
                    <h3>Žiadny test nezodpovedá filtrom</h3>
                    <p>Skúste inú oblasť, výsledok alebo hľadaný výraz.</p>
                    <button className="button secondary" onClick={resetFilters}>
                      Zobraziť všetky testy
                    </button>
                  </div>
                )}
                <div className="list-footer">
                  <span>
                    {filtered.length} z {scope.length} scenárov · katalóg{" "}
                    {run.catalogVersion}
                  </span>
                  <span>
                    <Clock3 size={13} />
                    Zmeny kolegov sa priebežne obnovujú
                  </span>
                </div>
              </section>
              <section className="team-strip">
                <div className="team-avatars">
                  {participantNames.slice(0, 4).map((n) => (
                    <span key={n} className="avatar" title={n}>
                      {initials(n)}
                    </span>
                  ))}
                  {!participantNames.length && <Users size={21} />}
                </div>
                <div>
                  <strong>
                    {participantNames.length
                      ? `${participantNames.length} ${participantNames.length === 1 ? "tester prispel" : "testeri prispeli"} do tohto kola`
                      : "Prvý zápis môže byť váš"}
                  </strong>
                  <span>
                    {
                      scopeEvents.filter((e) => e.kind === "result_saved")
                        .length
                    }{" "}
                    zápisov výsledkov · každá úprava ostáva v histórii
                  </span>
                </div>
                <button
                  className="text-button"
                  onClick={() => setHistory(true)}
                >
                  Pozrieť aktivitu <ArrowRight size={15} />
                </button>
              </section>
            </>
          ) : (
            <section className="empty-start">
              <span className="welcome-check">
                <ClipboardCheck size={39} />
              </span>
              <h2>Začnime prvým testovacím kolom.</h2>
              <p>
                {catalog.length} pripravených scenárov v 16 oblastiach.
                <br />
                Stačí pomenovať kolo, vybrať testovanú verziu a zariadenie.
              </p>
              <button
                className="button primary"
                onClick={() => setEditor("new")}
              >
                <Plus size={17} />
                Pripraviť kolo
              </button>
              {store?.runs.length ? (
                <button
                  className="text-button"
                  onClick={() => {
                    setArchived(true);
                    setRunId(store.runs[0].id);
                  }}
                >
                  Otvoriť archív
                </button>
              ) : null}
            </section>
          )}
          <footer className="page-footer">
            <span>Pomoc motoristom · Spoločné testovanie</span>
            <button onClick={() => setHelp(true)}>
              Pravidlá hodnotenia <CircleHelp size={14} />
            </button>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
      {rename && (
        <Modal
          title="Pod akým menom zapisujete?"
          onClose={() => setRename(false)}
        >
          <NameForm
            initial={actor.name}
            onEnter={async (name) => {
              await enter(name);
              setNotice(`Ďalšie zápisy budú pod menom ${name.trim()}.`);
            }}
          />
        </Modal>
      )}
      {editor && (
        <RunEditor
          run={editor === "edit" ? run : undefined}
          onClose={() => setEditor(null)}
          onSave={async (input, requestId) => {
            const next = await command(
              editor === "edit" && run
                ? {
                    kind: "updateRun",
                    requestId,
                    runId: run.id,
                    revision: run.revision,
                    input,
                  }
                : { kind: "createRun", requestId, input },
            );
            if (editor === "new") {
              const ev = next.events.find((e) => e.requestId === requestId);
              if (ev?.runId) setRunId(ev.runId);
            }
            setEditor(null);
            resetFilters();
            setNotice(
              editor === "new"
                ? "Nové kolo je pripravené. Všetky testy začínajú bez výsledku."
                : "Podmienky kola boli uložené.",
            );
          }}
          onArchive={async () => {
            if (!run) return;
            await command({
              kind: "archiveRun",
              requestId: crypto.randomUUID(),
              runId: run.id,
              revision: run.revision,
              archived: !run.archived,
            });
            setArchived(true);
            setEditor(null);
            setNotice(
              run.archived
                ? "Kolo bolo obnovené."
                : "Kolo bolo archivované. História zostáva zachovaná.",
            );
          }}
        />
      )}
      {selectedScenario && run && (
        <ScenarioEditor
          key={`${run.id}/${selectedScenario.id}`}
          runRevision={run.revision}
          scenario={selectedScenario}
          result={run.results[selectedScenario.id]}
          actor={actor}
          readOnly={run.archived}
          events={scopeEvents.filter(
            (e) => e.scenarioId === selectedScenario.id,
          )}
          onClose={() => setSelected(null)}
          onRefresh={() => load()}
          onSave={async (input, revision, requestId, advance, runRevision) => {
            const next = await command({
              kind: "saveResult",
              requestId,
              runId: run.id,
              runRevision,
              scenarioId: selectedScenario.id,
              revision,
              input,
            });
            setNotice("Výsledok uložený do spoločnej evidencie.");
            if (advance) {
              const index = filtered.findIndex(
                (s) => s.id === selectedScenario.id,
              );
              const candidates = [
                ...filtered.slice(index + 1),
                ...filtered.slice(0, index),
              ];
              const savedRun = next.runs.find((r) => r.id === run.id)!;
              setSelected(
                candidates.find(
                  (s) =>
                    !savedRun.results[s.id] ||
                    savedRun.results[s.id].status === "untested",
                )?.id ?? null,
              );
            } else setSelected(null);
          }}
        />
      )}
      {history && (
        <HistoryModal
          store={store}
          run={run}
          onClose={() => setHistory(false)}
        />
      )}
      {help && (
        <Modal
          title="Ako spoločne testovať"
          onClose={() => setHelp(false)}
          wide
        >
          <div className="help-intro">
            <span className="welcome-check">
              <ListChecks size={26} />
            </span>
            <p>
              Vyberte kolo a úroveň, otvorte scenár a postupujte podľa krokov.
              Výsledok zapíšte až po overení očakávaného správania.
            </p>
          </div>
          <div className="help-statuses">
            {statuses.map((s) => (
              <div key={s}>
                <Badge status={s} />
                <p>{statusHelp[s]}</p>
              </div>
            ))}
          </div>
          <div className="help-note">
            <strong>
              Jedno kolo = jedna verzia a dohodnuté zariadenie/podmienky.
            </strong>
            <p>
              Pre ďalšiu verziu alebo iné zariadenie vytvorte nové kolo.
              Kompletná sada obsahuje aj základné testy. Interné a klientské
              kolá majú vlastné výsledky. Technické skúšky vykonáva interný tím.
            </p>
            <p>
              Meno zadáva každý sám, bez overovania identity. Používajte
              stabilné a navzájom rozlíšiteľné mená. Evidencia zaznamená vstupy
              a všetky uložené zmeny; samotné otvorenie scenára nie je vykonaný
              test.
            </p>
            <p>
              V dispečingu používajte označené testovacie dáta a určené
              telefónne čísla. Testy výpadkov databázy a záťaže vykonávajte iba
              v izolovanom prostredí.
            </p>
            <p>
              Katalóg v{catalogVersion} je pripravená prvá sada. Zrozumiteľnosť
              a konkrétne očakávania ešte overte interným pilotom.
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}

function NameForm({
  onEnter,
  initial = "",
  initialError = "",
}: {
  onEnter: (name: string) => Promise<void>;
  initial?: string;
  initialError?: string;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  return (
    <form
      className="name-form"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await onEnter(name);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor="tester-name">Vaše meno</label>
      <input
        id="tester-name"
        autoFocus
        autoComplete="name"
        placeholder="Napr. Martin Novák"
        value={name}
        minLength={2}
        maxLength={80}
        required
        onChange={(e) => setName(e.target.value)}
      />
      <p className="field-help">
        Pod týmto menom sa uložia vaše výsledky a poznámky.
      </p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <button
        className="button primary"
        type="submit"
        disabled={busy || name.trim().length < 2}
      >
        {busy ? (
          <LoaderCircle className="spin" size={18} />
        ) : (
          <ArrowRight size={18} />
        )}
        Vstúpiť do testovania
      </button>
      <span className="name-footnote">
        Bez hesla a registrácie. Meno môžete neskôr zmeniť.
      </span>
    </form>
  );
}
function Welcome({
  onEnter,
  initialError,
}: {
  onEnter: (name: string) => Promise<void>;
  initialError: string;
}) {
  return (
    <main className="welcome">
      <div className="welcome-top">
        <Brand />
        <span className="eyebrow">SPOLOČNE K SPOĽAHLIVEJŠIEMU DISPEČINGU</span>
      </div>
      <div className="welcome-body">
        <section className="welcome-copy">
          <span className="welcome-label">
            <span />
            PRIPRAVENÉ PRE CELÝ TÍM
          </span>
          <h1>
            Dobré testovanie
            <br />
            začína <em>prehľadom.</em>
          </h1>
          <p>
            Všetko, čo potrebujeme overiť, na jednom mieste. Prejdite scenáre,
            zapíšte výsledok a posuňte dispečing o krok ďalej.
          </p>
          <div className="welcome-numbers">
            <div>
              <strong>16</strong>
              <span>oblastí aplikácie</span>
            </div>
            <div>
              <strong>2</strong>
              <span>úrovne testovania</span>
            </div>
            <div>
              <strong>1</strong>
              <span>spoločná história</span>
            </div>
          </div>
          <div className="welcome-path">
            <span>
              <ListChecks size={16} />
              Vybrať test
            </span>
            <ChevronRight size={15} />
            <span>
              <Check size={16} />
              Overiť výsledok
            </span>
            <ChevronRight size={15} />
            <span>
              <History size={16} />
              Uložiť zápis
            </span>
          </div>
        </section>
        <section className="welcome-card">
          <span className="welcome-check">
            <CheckCheck size={30} />
          </span>
          <h2>Vitajte v testovaní.</h2>
          <p>Najprv nám povedzte, kto dnes testuje.</p>
          <NameForm onEnter={onEnter} initialError={initialError} />
          <div className="welcome-card-note">
            <ShieldCheck size={18} />
            <span>
              História uchová, kto čo zapísal a kedy sa výsledok zmenil.
            </span>
          </div>
        </section>
      </div>
      <footer>
        Pomoc motoristom <span>·</span> Interné a klientské testovanie
      </footer>
    </main>
  );
}

function RunEditor({
  run,
  onClose,
  onSave,
  onArchive,
}: {
  run?: Run;
  onClose: () => void;
  onSave: (input: RunInput, requestId: string) => Promise<void>;
  onArchive: () => Promise<void>;
}) {
  const [input, setInput] = useState<RunInput>(
    run
      ? {
          title: run.title,
          stage: run.stage,
          targetUrl: run.targetUrl,
          version: run.version,
          device: run.device,
          conditions: run.conditions,
        }
      : {
          title: "Interné overenie · 1",
          stage: "internal",
          targetUrl: targetDefault,
          version: "",
          device: "",
          conditions: "",
        },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const operation = useRef<{ fingerprint: string; id: string } | null>(null);
  const locked = !!run && (Object.keys(run.results).length > 0 || run.archived);
  const update = (patch: Partial<RunInput>) => {
    setInput((old) => ({ ...old, ...patch }));
    setDirty(true);
  };
  const close = () => {
    if (
      !busy &&
      (!dirty || window.confirm("Zahodiť neuložené nastavenie kola?"))
    )
      onClose();
  };
  return (
    <Modal
      title={run ? "Podmienky testovacieho kola" : "Pripraviť nové kolo"}
      onClose={close}
    >
      <form
        className="editor-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const fingerprint = JSON.stringify(input);
          if (operation.current?.fingerprint !== fingerprint)
            operation.current = { fingerprint, id: crypto.randomUUID() };
          try {
            await onSave(input, operation.current.id);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="form-intro">
          Kolo spája výsledky jednej verzie aplikácie a dohodnutého zariadenia.
          Nové kolo začína bez výsledkov predchádzajúceho testovania.
        </p>
        {locked && (
          <div className="notice">
            Podmienky kola s výsledkami sú uzamknuté, aby história zostala
            pravdivá. Pre inú verziu alebo zariadenie vytvorte nové kolo.
          </div>
        )}
        <fieldset disabled={busy || locked}>
          <label>
            Názov kola
            <input
              value={input.title}
              onChange={(e) => update({ title: e.target.value })}
              required
              minLength={3}
              maxLength={100}
            />
          </label>
          <div className="form-pair">
            <label>
              Etapa
              <select
                value={input.stage}
                onChange={(e) =>
                  update({ stage: e.target.value as RunInput["stage"] })
                }
              >
                <option value="internal">Interné testovanie</option>
                <option value="client">Klientské testovanie</option>
              </select>
            </label>
            <label>
              Testované zariadenie
              <input
                value={input.device}
                placeholder="Napr. Windows · Chrome 140"
                onChange={(e) => update({ device: e.target.value })}
                required
                minLength={2}
                maxLength={120}
              />
            </label>
          </div>
          <label>
            Testovaná verzia / commit
            <input
              value={input.version}
              placeholder="Napr. b02ee19 alebo označenie vydania"
              onChange={(e) => update({ version: e.target.value })}
              required
              minLength={2}
              maxLength={120}
            />
          </label>
          <label>
            Odkaz na testovaný dispečing
            <input
              type="url"
              value={input.targetUrl}
              onChange={(e) => update({ targetUrl: e.target.value })}
              required
            />
          </label>
          <label>
            Podmienky a rozsah <span className="optional">voliteľné</span>
            <textarea
              rows={4}
              value={input.conditions}
              maxLength={3000}
              placeholder="Zapnuté funkcie, testovacie linky, roly, dohodnuté výnimky…"
              onChange={(e) => update({ conditions: e.target.value })}
            />
          </label>
        </fieldset>
        {run && (
          <p className="field-help">
            Vytvoril/a {run.createdBy.name} · {dateTime(run.createdAt)} ·
            katalóg {run.catalogVersion}
          </p>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <div className="form-actions">
          {run && (
            <button
              type="button"
              className="button ghost"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onArchive();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Archive size={16} />
              {run.archived ? "Obnoviť kolo" : "Archivovať"}
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={close}
          >
            Zavrieť
          </button>
          {!locked && (
            <button type="submit" className="button primary" disabled={busy}>
              {busy && <LoaderCircle size={16} className="spin" />}
              {run ? "Uložiť podmienky" : "Vytvoriť kolo"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function ScenarioEditor({
  scenario,
  result,
  actor,
  readOnly,
  events,
  onClose,
  onRefresh,
  onSave,
  runRevision,
}: {
  scenario: Scenario;
  result?: Assessment;
  actor: Actor;
  readOnly: boolean;
  events: AuditEvent[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
  onSave: (
    input: ResultInput,
    revision: number,
    requestId: string,
    advance: boolean,
    runRevision: number,
  ) => Promise<void>;
  runRevision: number;
}) {
  const [input, setInput] = useState<ResultInput>(() => inputFrom(result));
  const [base, setBase] = useState(result?.revision ?? 0);
  const [dirty, setDirty] = useState(false);
  const [openedRunRevision] = useState(runRevision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [advance, setAdvance] = useState(false);
  const operation = useRef<{ fingerprint: string; id: string } | null>(null);
  const conflict = (result?.revision ?? 0) !== base;
  const update = (patch: Partial<ResultInput>) => {
    setInput((old) => ({ ...old, ...patch }));
    setDirty(true);
  };
  useEffect(() => {
    if (!dirty) {
      setInput(inputFrom(result));
      setBase(result?.revision ?? 0);
    }
  }, [result, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const close = () => {
    if (!busy && (!dirty || window.confirm("Zahodiť neuložené hodnotenie?")))
      onClose();
  };
  return (
    <Modal title={`${scenario.id} · ${scenario.title}`} onClose={close} wide>
      <div className="scenario-meta">
        <span className={`level-mini level-${scenario.level}`}>
          Úroveň {scenario.level}
        </span>
        <span>{areaName(scenario.area)}</span>
        {scenario.audience === "internal" && (
          <span className="technical">Interný technický test</span>
        )}
      </div>
      <div className="scenario-instructions">
        <div className="prerequisites">
          <span>
            <Users size={15} />
            {scenario.role}
          </span>
          <p>{scenario.setup}</p>
        </div>
        <h3>Postup overenia</h3>
        <ol className="steps">
          {scenario.steps.map((step, i) => (
            <li key={i}>
              <span>{i + 1}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
        <div className="expected">
          <strong>
            <CheckCheck size={18} />
            Očakávaný výsledok
          </strong>
          <p>{scenario.expected}</p>
        </div>
        <details className="source-details">
          <summary>Podklad a ukončenie skúšky</summary>
          <p>{scenario.source}</p>
          <p>{scenario.cleanup}</p>
        </details>
      </div>
      <form
        className="result-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          const fingerprint = JSON.stringify({ input, base });
          if (operation.current?.fingerprint !== fingerprint)
            operation.current = { fingerprint, id: crypto.randomUUID() };
          try {
            await onSave(
              input,
              base,
              operation.current.id,
              advance,
              openedRunRevision,
            );
          } catch (err) {
            setError((err as Error).message);
            if ((err as ApiError).status === 409) await onRefresh();
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="result-heading">
          <h3>Výsledok testu</h3>
          <span>
            Zapisuje <strong>{actor.name}</strong>
          </span>
        </div>
        {readOnly && (
          <div className="notice">
            Archivované kolo · výsledok je iba na čítanie.
          </div>
        )}
        {conflict && (
          <div className="conflict" role="alert">
            <strong>Novší zápis od {result?.actor.name}</strong>
            <p>
              {statusLabels[result?.status ?? "untested"]}
              {result?.note ? ` · ${result.note}` : ""}
            </p>
            <p>
              Váš rozpracovaný text je nižšie. Porovnajte ho s kolegovým
              zápisom.
            </p>
            <div className="inline-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setInput(inputFrom(result));
                  setBase(result?.revision ?? 0);
                  setDirty(false);
                  setError("");
                }}
              >
                Prevziať kolegov výsledok
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setBase(result?.revision ?? 0);
                  setDirty(true);
                  setError("");
                }}
              >
                Zachovať môj text pre nový zápis
              </button>
            </div>
          </div>
        )}
        <fieldset disabled={busy || readOnly}>
          <div className="status-choices">
            {statuses.map((s) => (
              <button
                type="button"
                key={s}
                className={`status-choice status-${s} ${input.status === s ? "chosen" : ""}`}
                aria-pressed={input.status === s}
                onClick={() =>
                  update({
                    status: s,
                    severity:
                      s === "reservation"
                        ? "minor"
                        : s === "rejected"
                          ? input.severity || "major"
                          : "",
                  })
                }
              >
                <span className="status-dot" />
                {statusLabels[s]}
                {input.status === s && <Check size={15} />}
              </button>
            ))}
          </div>
          <p className="field-help status-description">
            {statusHelp[input.status]}
          </p>
          {input.status === "rejected" && (
            <label>
              Závažnosť
              <select
                value={input.severity}
                onChange={(e) =>
                  update({
                    severity: e.target.value as ResultInput["severity"],
                  })
                }
                required
              >
                <option value="major">Závažná — funkcia neplní účel</option>
                <option value="critical">
                  Kritická — dáta, prístup alebo zásadný výpadok
                </option>
                <option value="minor">Drobná — menší nedostatok</option>
              </select>
            </label>
          )}
          <label>
            Poznámka{" "}
            {!["reservation", "rejected", "blocked", "na"].includes(
              input.status,
            ) && <span className="optional">voliteľná</span>}
            <textarea
              autoComplete="off"
              rows={4}
              maxLength={5000}
              value={input.note}
              onChange={(e) => update({ note: e.target.value })}
              required={["reservation", "rejected", "blocked", "na"].includes(
                input.status,
              )}
              minLength={
                ["reservation", "rejected", "blocked", "na"].includes(
                  input.status,
                )
                  ? 3
                  : undefined
              }
              placeholder="Čo sa stalo? Čo sa líšilo od očakávania?"
            />
          </label>
          {["reservation", "rejected", "blocked", "na"].includes(
            input.status,
          ) && (
            <div className="form-pair">
              <label>
                {input.status === "na" ? "Vyradenie potvrdil/a" : "Kto dorieši"}
                {!["reservation", "na"].includes(input.status) && (
                  <span className="optional">voliteľné</span>
                )}
                <input
                  value={input.owner}
                  maxLength={100}
                  required={["reservation", "na"].includes(input.status)}
                  minLength={
                    ["reservation", "na"].includes(input.status) ? 2 : undefined
                  }
                  onChange={(e) => update({ owner: e.target.value })}
                  placeholder="Meno kolegu / koordinátora"
                />
              </label>
              <label>
                Odkaz na chybu / obrázok{" "}
                <span className="optional">voliteľný</span>
                <input
                  type="url"
                  value={input.issueUrl}
                  onChange={(e) => update({ issueUrl: e.target.value })}
                  placeholder="https://…"
                />
              </label>
            </div>
          )}
        </fieldset>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <div className="save-footer">
          <span>
            {dirty
              ? "Neuložené zmeny"
              : result
                ? `Uložil/a ${result.actor.name} · ${dateTime(result.updatedAt)}`
                : "Výsledok ešte nie je uložený"}
          </span>
          {!readOnly && (
            <div className="inline-actions">
              <button
                type="submit"
                className="button secondary"
                disabled={busy || conflict}
                onClick={() => setAdvance(false)}
              >
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Check size={16} />
                )}
                Uložiť výsledok
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={busy || conflict}
                onClick={() => setAdvance(true)}
              >
                Uložiť a ďalší <ArrowRight size={16} />
              </button>
            </div>
          )}
        </div>
      </form>
      {events.length > 0 && (
        <details className="test-history">
          <summary>
            <History size={16} />
            História tohto testu <span>{events.length}</span>
          </summary>
          <AuditList events={[...events].reverse()} />
        </details>
      )}
    </Modal>
  );
}

const eventLabels: Record<AuditEvent["kind"], string> = {
  entry: "Vstúpil/a do evidencie",
  run_created: "Vytvoril/a testovacie kolo",
  run_updated: "Upravil/a podmienky kola",
  result_saved: "Zapísal/a výsledok",
  run_archived: "Archivoval/a kolo",
  run_restored: "Obnovil/a kolo",
};
function AuditList({
  events,
  store,
}: {
  events: AuditEvent[];
  store?: Store | null;
}) {
  return (
    <div className="audit-list">
      {events.map((event) => {
        const before = event.before as Assessment | null;
        const after = event.after as Assessment | null;
        const run = store?.runs.find((r) => r.id === event.runId);
        const scenario = run?.scenarios.find((s) => s.id === event.scenarioId);
        return (
          <article key={event.id} className="audit-event">
            <span className="avatar">{initials(event.actor.name)}</span>
            <div>
              <div className="audit-heading">
                <strong>{event.actor.name}</strong>
                <time dateTime={event.at}>{dateTime(event.at)}</time>
              </div>
              <p>
                {eventLabels[event.kind]}
                {event.scenarioId ? ` · ${event.scenarioId}` : ""}
                {run ? ` · ${run.title}` : ""}
              </p>
              {scenario && (
                <strong className="audit-test-title">{scenario.title}</strong>
              )}
              {event.kind === "result_saved" ? (
                <>
                  <div className="audit-transition">
                    <Badge status={before?.status ?? "untested"} />
                    <ArrowRight size={14} />
                    <Badge status={after?.status ?? "untested"} />
                  </div>
                  <details>
                    <summary>Pozrieť celý zápis a pôvodné hodnoty</summary>
                    <div className="audit-comparison">
                      <div>
                        <strong>Pred zmenou</strong>
                        <p>{before?.note || "Bez poznámky"}</p>
                        <small>
                          {severityLabels[before?.severity ?? ""]}
                          {before?.owner ? ` · ${before.owner}` : ""}
                        </small>
                        {before?.issueUrl && (
                          <a
                            href={before.issueUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Pôvodný odkaz <ArrowUpRight size={12} />
                          </a>
                        )}
                      </div>
                      <div>
                        <strong>Po zmene</strong>
                        <p>{after?.note || "Bez poznámky"}</p>
                        <small>
                          {severityLabels[after?.severity ?? ""]}
                          {after?.owner ? ` · ${after.owner}` : ""}
                        </small>
                        {after?.issueUrl && (
                          <a
                            href={after.issueUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Odkaz na podklad <ArrowUpRight size={12} />
                          </a>
                        )}
                      </div>
                    </div>
                  </details>
                </>
              ) : (
                event.kind !== "entry" && (
                  <details>
                    <summary>Podrobnosti zmeny</summary>
                    <pre>
                      {JSON.stringify(
                        { pred: event.before, po: event.after },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                )
              )}
              <span
                className="audit-id"
                title={`Záznam ${event.id} · vstup ${event.actor.id}`}
              >
                Zápis {event.id.slice(0, 8)}
              </span>
            </div>
          </article>
        );
      })}
    </div>
  );
}
function HistoryModal({
  store,
  run,
  onClose,
}: {
  store: Store | null;
  run?: Run;
  onClose: () => void;
}) {
  const [all, setAll] = useState(!run);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(60);
  const entries = (store?.events ?? [])
    .filter(
      (e) =>
        (all || e.runId === run?.id) &&
        (!search ||
          `${e.actor.name} ${e.scenarioId ?? ""} ${JSON.stringify(e.after)}`
            .toLocaleLowerCase("sk")
            .includes(search.toLocaleLowerCase("sk"))),
    )
    .toReversed();
  const names = new Set(
    entries.filter((e) => e.kind === "result_saved").map((e) => e.actor.name),
  );
  return (
    <Modal title="História a aktivita tímu" onClose={onClose} wide>
      <p className="form-intro">
        Každý uložený zápis má autora, čas a pôvodnú hodnotu. Úprava výsledku
        pridá nový záznam.
      </p>
      <div className="history-toolbar">
        <div className="search-field">
          <Search size={17} />
          <input
            aria-label="Hľadať v histórii"
            placeholder="Meno, test alebo poznámka…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setLimit(60);
            }}
          />
        </div>
        <select
          aria-label="Rozsah histórie"
          value={all ? "all" : "run"}
          onChange={(e) => {
            setAll(e.target.value === "all");
            setLimit(60);
          }}
        >
          {run && <option value="run">Toto kolo</option>}
          <option value="all">Všetky kolá aj vstupy</option>
        </select>
        <button
          className="button secondary"
          onClick={() =>
            download(
              `historia-testovania-${new Date().toISOString().slice(0, 10)}.json`,
              JSON.stringify(
                {
                  exportedAt: new Date().toISOString(),
                  scope: all ? "all" : run?.id,
                  runs: store?.runs.filter((r) => all || r.id === run?.id),
                  events: entries,
                },
                null,
                2,
              ),
              "application/json",
            )
          }
        >
          <ArrowDownToLine size={16} />
          Export histórie
        </button>
      </div>
      <div className="history-metrics">
        <span>
          <strong>{names.size}</strong> mien so zápisom
        </span>
        <span>
          <strong>
            {entries.filter((e) => e.kind === "result_saved").length}
          </strong>{" "}
          zápisov výsledkov
        </span>
        <span>
          <strong>{entries.filter((e) => e.kind === "entry").length}</strong>{" "}
          vstupov do evidencie
        </span>
      </div>
      {entries.length ? (
        <>
          <AuditList events={entries.slice(0, limit)} store={store} />
          {entries.length > limit && (
            <button
              className="button secondary load-more"
              onClick={() => setLimit(limit + 60)}
            >
              Zobraziť ďalšie záznamy ({entries.length - limit})
            </button>
          )}
        </>
      ) : (
        <div className="empty">
          <History size={28} />
          <h3>História čaká na prvý zápis</h3>
          <p>Pri ukladaní testov sa sem automaticky pridajú zmeny.</p>
        </div>
      )}
    </Modal>
  );
}
