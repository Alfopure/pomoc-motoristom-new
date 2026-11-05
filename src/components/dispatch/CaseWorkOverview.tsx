"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowRight,
  Building2,
  CalendarClock,
  CarFront,
  ChevronDown,
  ClipboardList,
  ExternalLink,
  MapPin,
  Plus,
  RefreshCw,
  Truck,
  UserRound,
} from "lucide-react";
import type { OperationsWorkspace } from "@/domain/operations";
import type { JobType } from "@/domain/types";
import type { TowingWorkspace } from "@/domain/towing/types";
import {
  workKinds,
  type BranchWorkspace as BranchData,
} from "@/domain/work-groups";
import { CaseOperationsPanel } from "@/components/operations/OperationsModule";
import { BranchWorkspace } from "@/components/branches/BranchWorkspace";
import { CaseTowingOrdersPanel } from "./CaseTowingOrdersPanel";
import {
  caseWorkOverviewItems,
  overviewStatusLabels,
  overviewStatusTone,
  type CaseWorkOverviewItem,
} from "./case-work-overview-model";
import styles from "./case-work-overview.module.css";

type Props = {
  caseId: string;
  caseNumber?: string;
  jobTypes?: JobType[];
  refreshToken?: number;
  active?: boolean;
  onAssign?: () => void;
};
type Source<T> = {
  data: T | null;
  error: "denied" | "failed" | null;
  finished: boolean;
};
type Sources = {
  version: string;
  operations: Source<OperationsWorkspace>;
  towing: Source<TowingWorkspace>;
  branches: Source<BranchData>;
};
type Management = "operations" | "towing" | "branches";
const emptySource = <T,>(): Source<T> => ({
  data: null,
  error: null,
  finished: false,
});
const emptySources = (version: string): Sources => ({
  version,
  operations: emptySource(),
  towing: emptySource(),
  branches: emptySource(),
});
const date = (value: string) =>
  new Intl.DateTimeFormat("sk-SK", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Bratislava",
  }).format(new Date(value));
class OverviewReadError extends Error {
  constructor(public status: number) {
    super("Overview read failed");
  }
}
async function readWorkspace<T>(
  url: string,
  field: string,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new OverviewReadError(response.status);
  const body = await response.json();
  if (!body || !Array.isArray(body[field])) throw new OverviewReadError(503);
  return body as T;
}

/** One case overview; detailed existing editors remain mounted after their first visit. */
export function CaseWorkOverview(props: Props) {
  return <CaseWorkOverviewSession key={props.caseId} {...props} />;
}
function CaseWorkOverviewSession({
  caseId,
  caseNumber,
  jobTypes,
  refreshToken = 0,
  active = true,
  onAssign,
}: Props) {
  const [reload, setReload] = useState(0);
  const version = `${refreshToken}:${reload}`;
  const [sources, setSources] = useState<Sources>(() => emptySources(version));
  const [managementOpen, setManagementOpen] = useState(false),
    [management, setManagement] = useState<Management>("operations");
  const [visited, setVisited] = useState<Set<Management>>(() => new Set());
  const managementRef = useRef<HTMLDetailsElement>(null);
  const managementId = useId();
  if (sources.version !== version) setSources(emptySources(version));
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    async function load<K extends "operations" | "towing" | "branches">(
      key: K,
      url: string,
      field: string,
    ) {
      try {
        const data = await readWorkspace<NonNullable<Sources[K]["data"]>>(
          url,
          field,
          controller.signal,
        );
        if (!controller.signal.aborted)
          setSources((current) =>
            current.version === version
              ? { ...current, [key]: { data, error: null, finished: true } }
              : current,
          );
      } catch (error) {
        if (!controller.signal.aborted)
          setSources((current) =>
            current.version === version
              ? {
                  ...current,
                  [key]: {
                    data: null,
                    error:
                      error instanceof OverviewReadError &&
                      [401, 403].includes(error.status)
                        ? "denied"
                        : "failed",
                    finished: true,
                  },
                }
              : current,
          );
      }
    }
    const query = new URLSearchParams({ caseId, view: "all", limit: "50" });
    void Promise.allSettled([
      load("operations", `/api/operations?${query}`, "operations"),
      load(
        "towing",
        `/api/towing/workspace?${new URLSearchParams({ view: "office", sourceCaseId: caseId, limit: "50" })}`,
        "orders",
      ),
      load("branches", `/api/pobocky?${query}`, "requests"),
    ]);
    return () => controller.abort();
  }, [active, caseId, version]);

  const items = caseWorkOverviewItems({
    operations: sources.operations.data?.operations,
    orders: sources.towing.data?.orders,
    requests: sources.branches.data?.requests,
    drivers: sources.towing.data?.members,
    branches: sources.towing.data?.branches,
  });
  const loading =
    !sources.operations.finished ||
    !sources.towing.finished ||
    !sources.branches.finished;
  const incomplete = Boolean(
    sources.operations.error || sources.towing.error || sources.branches.error,
  );
  const more =
    (sources.operations.data?.totalCount ?? 0) >
      (sources.operations.data?.operations.length ?? 0) ||
    (sources.towing.data?.totalCount ?? 0) >
      (sources.towing.data?.orders.length ?? 0) ||
    (sources.branches.data?.totalCount ?? 0) >
      (sources.branches.data?.requests.length ?? 0);
  const open = items.filter(
    (item) => !["done", "cancelled"].includes(overviewStatusTone(item.status)),
  ).length;
  const extra = items.filter(
    (item) => item.kind !== "tow" && item.kind !== "delivery",
  );
  function showManagement(tab: Management) {
    setManagement(tab);
    setManagementOpen(true);
    setVisited((current) => new Set([...current, tab]));
    requestAnimationFrame(() =>
      managementRef.current?.scrollIntoView({ block: "nearest" }),
    );
  }
  return (
    <section
      className={styles.overview}
      aria-label="Prehľad odťahu a pristavenia"
    >
      <header className={styles.header}>
        <div>
          <h3>Práca na prípade</h3>
          <p>
            {loading && !items.length
              ? "Načítavam zadania…"
              : `${more || incomplete || loading ? "Zobrazené" : "Spolu"}: ${items.length} · Otvorené: ${open}`}
          </p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.refresh}
            aria-label="Obnoviť prehľad práce"
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={16} />
          </button>
          {onAssign && (
            <button type="button" className={styles.primary} onClick={onAssign}>
              <Plus size={16} />
              Odovzdať prácu
            </button>
          )}
        </div>
      </header>
      {incomplete && (
        <div className={styles.warning} role="status">
          <strong>Časť údajov nie je dostupná.</strong>
          {(["operations", "towing", "branches"] as const)
            .filter((key) => sources[key].error)
            .map((key) => (
              <span key={key}>
                {
                  {
                    operations: "Jazdy",
                    towing: "Podrobné odťahové zákazky",
                    branches: "Požiadavky pobočiek",
                  }[key]
                }{" "}
                {sources[key].error === "denied"
                  ? "nie sú pre tento účet dostupné."
                  : "sa nepodarilo načítať."}
              </span>
            ))}
          <button
            type="button"
            disabled={loading}
            onClick={() => setReload((value) => value + 1)}
          >
            Skúsiť znova
          </button>
        </div>
      )}
      <div className={styles.columns}>
        {(["tow", "delivery"] as const).map((kind) => {
          const rows = items.filter((item) => item.kind === kind);
          const requested =
            !jobTypes ||
            (kind === "tow"
              ? jobTypes.some(
                  (type) => type === "tow" || type === "vehicle_recovery",
                )
              : jobTypes.includes("replacement_vehicle"));
          const Icon = kind === "tow" ? Truck : CarFront;
          return (
            <section
              key={kind}
              className={styles.column}
              data-work-kind={kind}
              aria-label={workKinds[kind]}
            >
              <header
                className={`${styles.columnHeader} ${kind === "tow" ? styles.tow : styles.delivery}`}
              >
                <span className={styles.kindIcon}>
                  <Icon size={19} />
                </span>
                <div>
                  <h4>{workKinds[kind]}</h4>
                  <p>
                    {kind === "tow" ? "Vozidlo klienta" : "Náhradné vozidlo"}
                  </p>
                </div>
                <span className={styles.count}>{rows.length}</span>
              </header>
              <div className={styles.cards}>
                {rows.map((item) => (
                  <WorkCard
                    key={item.key}
                    item={item}
                    onManage={() =>
                      showManagement(
                        item.source === "request" ? "branches" : "operations",
                      )
                    }
                  />
                ))}
                {!rows.length && (
                  <div className={styles.empty}>
                    {loading ? (
                      <p role="status">
                        Načítavam {kind === "tow" ? "odťah" : "pristavenie"}…
                      </p>
                    ) : (
                      <>
                        <ClipboardList size={23} />
                        <strong>
                          {incomplete
                            ? "V dostupných údajoch bez zadania"
                            : requested
                              ? "Zatiaľ neodovzdané"
                              : "Služba nie je vybraná"}
                        </strong>
                        <p>
                          {incomplete
                            ? "Úplný stav overte po obnovení údajov."
                            : requested
                              ? "Vyberte pobočku alebo človeka cez Odovzdať prácu."
                              : "Keď službu doplníte do prípadu, môžete ju odovzdať spolu s ostatnými."}
                        </p>
                      </>
                    )}
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {extra.length > 0 && (
        <section className={styles.extra} aria-label="Ďalšie jazdy">
          <h4>Ďalšie jazdy</h4>
          <div className={styles.columns}>
            {extra.map((item) => (
              <WorkCard
                key={item.key}
                item={item}
                onManage={() =>
                  showManagement(
                    item.source === "request" ? "branches" : "operations",
                  )
                }
              />
            ))}
          </div>
        </section>
      )}
      {more && (
        <p className={styles.limit}>
          Zobrazená je prvá časť zadaní. Ďalšie nájdete v podrobnej správe.
        </p>
      )}
      <details
        ref={managementRef}
        className={styles.management}
        open={managementOpen}
        onToggle={(event) => {
          const next = event.currentTarget.open;
          setManagementOpen(next);
          if (!next && managementOpen) setReload((value) => value + 1);
          if (next) setVisited((current) => new Set([...current, management]));
        }}
      >
        <summary>
          <ChevronDown size={15} />
          Podrobná správa jázd a zákaziek
        </summary>
        <p className={styles.managementHint}>
          Plánovanie, úpravy a história všetkých jázd, odťahových zákaziek a
          požiadaviek tohto prípadu.
        </p>
        <div
          className={styles.managementTabs}
          role="group"
          aria-label="Vybrať podrobnú správu"
        >
          {(["operations", "towing", "branches"] as const).map((tab) => (
            <button
              type="button"
              key={tab}
              aria-pressed={management === tab}
              aria-controls={`${managementId}-${tab}`}
              onClick={() => {
                setManagement(tab);
                setVisited((current) => new Set([...current, tab]));
              }}
            >
              {
                {
                  operations: "Všetky jazdy",
                  towing: "Odťahové zákazky",
                  branches: "Pobočky",
                }[tab]
              }
            </button>
          ))}
        </div>
        <div
          id={`${managementId}-operations`}
          hidden={management !== "operations"}
          className={styles.managementContent}
        >
          {visited.has("operations") && (
            <CaseOperationsPanel
              caseId={caseId}
              embedded
              refreshToken={refreshToken + reload}
            />
          )}
        </div>
        <div
          id={`${managementId}-towing`}
          hidden={management !== "towing"}
          className={styles.managementContent}
        >
          {visited.has("towing") && (
            <CaseTowingOrdersPanel
              caseId={caseId}
              caseNumber={caseNumber}
              embedded
              refreshToken={refreshToken + reload}
            />
          )}
        </div>
        <div
          id={`${managementId}-branches`}
          hidden={management !== "branches"}
          className={styles.managementContent}
        >
          {visited.has("branches") && <BranchWorkspace caseId={caseId} />}
        </div>
      </details>
    </section>
  );
}
function WorkCard({
  item,
  onManage,
}: {
  item: CaseWorkOverviewItem;
  onManage: () => void;
}) {
  return (
    <article className={styles.card} data-work-key={item.key}>
      <div className={styles.cardHeading}>
        <strong>{item.title}</strong>
        <span
          className={styles.status}
          data-tone={overviewStatusTone(item.status)}
        >
          {overviewStatusLabels[item.status] || item.status}
        </span>
      </div>
      {item.kind !== "tow" && item.kind !== "delivery" && (
        <p className={styles.kindLabel}>{workKinds[item.kind]}</p>
      )}
      <dl className={styles.cardFacts}>
        <div>
          <UserRound size={14} />
          <dt>Príjemca</dt>
          <dd>
            {item.recipient ||
              (item.assigned
                ? "Pridelený vykonávateľ"
                : item.branch
                  ? "Čaká na vykonávateľa"
                  : "Zatiaľ bez príjemcu")}
          </dd>
        </div>
        {item.branch && (
          <div>
            <Building2 size={14} />
            <dt>Pobočka</dt>
            <dd>{item.branch}</dd>
          </div>
        )}
        <div>
          <CalendarClock size={14} />
          <dt>{item.timeLabel}</dt>
          <dd>
            {item.time ? (
              <time dateTime={item.time}>{date(item.time)}</time>
            ) : (
              "Termín neurčený"
            )}
          </dd>
        </div>
        {item.vehicle && (
          <div>
            <CarFront size={14} />
            <dt>Vozidlo</dt>
            <dd>{item.vehicle}</dd>
          </div>
        )}
      </dl>
      <div className={styles.route}>
        <MapPin size={14} />
        <div>
          <span>{item.from || "Miesto začiatku neurčené"}</span>
          <span className={styles.destination}>
            <ArrowRight size={13} />
            {item.to || "Cieľ neurčený"}
          </span>
        </div>
      </div>
      <footer className={styles.cardActions}>
        {item.href ? (
          <a href={item.href} target="_blank" rel="noopener noreferrer">
            Otvoriť zákazku
            <ExternalLink size={13} />
          </a>
        ) : (
          <button type="button" onClick={onManage}>
            Spravovať {item.source === "request" ? "požiadavky" : "jazdy"}
            <ArrowRight size={13} />
          </button>
        )}
      </footer>
    </article>
  );
}
