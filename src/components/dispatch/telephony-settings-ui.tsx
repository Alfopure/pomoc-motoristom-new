"use client";

import { useId, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  ListOrdered,
  PhoneCall,
  RefreshCw,
  Repeat2,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import type { TelephonyHealthState } from "@/lib/telephony/health";

type TelephonyReadinessSummaryProps = {
  connectionState: TelephonyHealthState;
  connectionDetail?: string;
  assignedCount: number;
  extensionCount: number;
  routingChangeActive: boolean;
  routingSlotsConfigured: number;
  publicNumberCount: number;
  publicNumbersReady: boolean;
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
};

type ReadinessState = "ready" | "pending" | "checking";

type ReadinessItem = {
  detail: string;
  label: string;
  state: ReadinessState;
};

export function TelephonyReadinessSummary({
  assignedCount,
  connectionDetail,
  connectionState,
  extensionCount,
  onRefresh,
  publicNumberCount,
  publicNumbersReady,
  refreshing,
  routingChangeActive,
  routingSlotsConfigured,
}: TelephonyReadinessSummaryProps) {
  const headingId = useId();
  const connectionReady = connectionState === "live";
  const connectionChecking = connectionState === "checking" || refreshing;
  const safeExtensionCount = Math.max(0, extensionCount);
  const safeAssignedCount = Math.min(Math.max(0, assignedCount), safeExtensionCount);
  const safeRoutingSlots = Math.min(Math.max(0, routingSlotsConfigured), 3);
  const safePublicNumberCount = Math.max(0, publicNumberCount);
  const assignmentsReady = safeExtensionCount > 0 && safeAssignedCount === safeExtensionCount;
  const routingReady = safeRoutingSlots === 3 && !routingChangeActive;
  const numbersReady = publicNumbersReady && safePublicNumberCount > 0;
  const ready = connectionReady && assignmentsReady && routingReady && numbersReady;

  const readinessItems: ReadinessItem[] = [
    {
      label: "Spojenie s VIPTel",
      detail: connectionStateLabel(connectionState),
      state: connectionReady ? "ready" : connectionChecking ? "checking" : "pending",
    },
    {
      label: "Operátori a klapky",
      detail:
        safeExtensionCount === 0
          ? "Klapky ešte nie sú načítané"
          : `${safeAssignedCount} z ${safeExtensionCount} priradených`,
      state: assignmentsReady ? "ready" : "pending",
    },
    {
      label: "Poradie zvonenia",
      detail: routingChangeActive
        ? "Prebieha alebo čaká nedokončená zmena"
        : `${safeRoutingSlots} z 3 miest nastavených`,
      state: routingReady ? "ready" : "pending",
    },
    {
      label: "Telefónne čísla poisťovní",
      detail: numbersReady
        ? `${safePublicNumberCount} ${pluralizeNumbers(safePublicNumberCount)} – postačuje`
        : safePublicNumberCount > 0
          ? `${safePublicNumberCount} ${pluralizeNumbers(safePublicNumberCount)} – treba dokončiť nastavenie`
          : "Čísla ešte nie sú pripravené",
      state: numbersReady ? "ready" : "pending",
    },
  ];

  const statusTitle = ready
    ? "Pripravené na testovací hovor"
    : connectionChecking
      ? "Obnovujem pripravenosť telefonovania"
      : "Ešte nie je pripravené na test";

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={refreshing}
      className="overflow-hidden rounded-md border border-zinc-200 bg-white shadow-sm"
    >
      <div className="flex flex-col gap-4 border-b border-zinc-200 bg-zinc-50 px-4 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-zinc-950">
            <PhoneCall size={20} aria-hidden="true" />
            <h2 id={headingId} className="text-lg font-bold">
              Telefonovanie cez VIPTel
            </h2>
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-5 text-zinc-600">
            Priraďte operátorov ku klapkám a nastavte, v akom poradí bude prichádzajúci hovor zvoniť.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void onRefresh()}
          disabled={refreshing}
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md border border-zinc-300 bg-white px-4 text-sm font-semibold text-zinc-800 outline-none hover:bg-zinc-100 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60 sm:self-start"
        >
          <RefreshCw
            size={16}
            aria-hidden="true"
            className={refreshing ? "motion-safe:animate-spin" : undefined}
          />
          {refreshing ? "Obnovujem stav…" : "Obnoviť stav"}
        </button>
      </div>

      <div className="p-4">
        <div
          role="status"
          aria-live="polite"
          className={`flex items-start gap-3 rounded-md border px-3 py-3 ${
            ready
              ? "border-emerald-200 bg-emerald-50 text-emerald-950"
              : "border-amber-200 bg-amber-50 text-amber-950"
          }`}
        >
          {ready ? (
            <ShieldCheck size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
          ) : (
            <AlertTriangle size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
          )}
          <div className="min-w-0">
            <p className="font-semibold">{statusTitle}</p>
            {!ready && (
              <p className="mt-0.5 text-sm leading-5">
                Dokončite označené kroky. Rozpracované nastavenie môžete meniť aj pred jeho uložením.
              </p>
            )}
          </div>
        </div>

        <ul className="mt-4 grid gap-2 md:grid-cols-2" aria-label="Kontrola pripravenosti telefonovania">
          {readinessItems.map((item, index) => (
            <li key={item.label} className="flex items-start gap-3 rounded-md border border-zinc-200 bg-white px-3 py-3">
              <ReadinessIcon state={item.state} />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-zinc-950">{item.label}</p>
                <p className="mt-0.5 text-sm leading-5 text-zinc-600">{item.detail}</p>
                {index === 0 && connectionDetail && (
                  <p className="mt-1 text-xs leading-5 text-zinc-500">{connectionDetail}</p>
                )}
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href="#viptel-operators"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-[#FCD703] px-4 text-sm font-bold text-zinc-950 outline-none hover:bg-yellow-300 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2"
          >
            <UserRound size={17} aria-hidden="true" />
            {assignmentsReady ? "Skontrolovať operátorov" : "Priradiť operátorov"}
          </a>
          <p className="text-xs leading-5 text-zinc-500">
            Toto nastavenie ovplyvňuje prichádzajúce hovory. Operátori môžu samostatne volať von.
          </p>
        </div>
      </div>
    </section>
  );
}

export type CallRoutingQueueMetadata = {
  queue: string;
  label: string;
  detail: string;
};

type CallRoutingTimelineProps = {
  stepContents: readonly [ReactNode, ReactNode, ReactNode];
  queueMetadata: readonly [CallRoutingQueueMetadata, CallRoutingQueueMetadata, CallRoutingQueueMetadata];
};

export function CallRoutingTimeline({ queueMetadata, stepContents }: CallRoutingTimelineProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="rounded-md border border-zinc-200 bg-zinc-50 p-4">
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-yellow-100 text-yellow-900">
          <ListOrdered size={20} aria-hidden="true" />
        </div>
        <div>
          <h4 id={headingId} className="text-base font-bold text-zinc-950">
            Ako bude prichádzajúci hovor zvoniť
          </h4>
          <p className="mt-1 text-sm leading-5 text-zinc-600">
            Keď operátor hovor nezdvihne do 30 sekúnd, systém ho posunie na ďalšie miesto.
          </p>
        </div>
      </div>

      <ol className="mt-5 grid gap-0 lg:grid-cols-3 lg:gap-24" aria-label="Poradie zvonenia prichádzajúceho hovoru">
        {queueMetadata.map((metadata, index) => (
          <li key={`${metadata.queue}-${index}`} className="relative min-w-0">
            <div className="rounded-md border border-zinc-200 bg-white p-3 shadow-sm lg:h-full">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-zinc-950">{metadata.label}</p>
                  <p className="mt-0.5 text-xs leading-5 text-zinc-600">{metadata.detail}</p>
                </div>
                <span className="shrink-0 rounded-full bg-yellow-100 px-2.5 py-1 text-xs font-bold text-yellow-950">
                  Rad {metadata.queue}
                </span>
              </div>

              <div className="mt-3">{stepContents[index]}</div>

              {index === 2 && (
                <div className="mt-3 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-medium leading-5 text-blue-950">
                  <Repeat2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                  <span>Rad {metadata.queue} zvoní opakovane v slučke, kým niekto hovor nezdvihne.</span>
                </div>
              )}
            </div>

            {index < 2 && (
              <div className="flex min-h-20 flex-col items-center justify-center text-center text-xs font-semibold leading-4 text-zinc-600 lg:absolute lg:left-full lg:top-1/2 lg:min-h-0 lg:w-24 lg:-translate-y-1/2">
                <span className="inline-flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-1">
                  <Clock3 size={13} aria-hidden="true" />
                  cieľ: 20 sekúnd
                </span>
                <ArrowDown size={20} className="mt-1 lg:hidden" aria-hidden="true" />
                <ArrowRight size={20} className="mt-1 hidden lg:block" aria-hidden="true" />
              </div>
            )}
          </li>
        ))}
      </ol>

      <p className="mt-4 text-sm leading-5 text-zinc-600">
        Poradie platí iba pre prichádzajúce hovory. Každý prihlásený operátor môže samostatne volať von.
      </p>
    </section>
  );
}

const technicalTerms = [
  {
    term: "Pripojenie telefónu (SIP)",
    explanation: "Spôsob, ktorým sa telefón alebo prehliadač spojí s telefónnou ústredňou VIPTel.",
  },
  {
    term: "Kontrola bez uloženia (dry-run)",
    explanation: "Systém overí plán a bezpečnostné podmienky, ale v službe VIPTel nič nezmení.",
  },
  {
    term: "Prvé vytvorenie nastavenia (bootstrap)",
    explanation: "Jednorazové naplnenie úplne prázdnych radov 601–603 prvým poradím operátorov.",
  },
  {
    term: "Záložný operátor (fallback)",
    explanation: "Operátor, ktorý zostane dostupný, kým sa poradie bezpečne mení.",
  },
  {
    term: "Návrat k pôvodnému stavu (rollback)",
    explanation: "Obnovenie poradia, ktoré platilo pred poslednou nedokončenou alebo chybnou zmenou.",
  },
  {
    term: "Zosúladenie stavu (reconcile)",
    explanation: "Nové porovnanie aplikácie s VIPTel, keď nie je isté, či sa predchádzajúci krok dokončil.",
  },
  {
    term: "Verejné telefónne číslo (DID)",
    explanation: "Číslo, na ktoré klient volá. Podľa neho aplikácia rozpozná príslušnú poisťovňu.",
  },
  {
    term: "Zoznam rozdielov (diff)",
    explanation: "Prehľad konkrétnych krokov, ktoré by sa po uložení zmenili.",
  },
  {
    term: "Poskytovateľ služby (provider)",
    explanation: "Externá telefónna služba, ktorá zmenu vykoná; v tomto prípade VIPTel.",
  },
  {
    term: "Verzia nastavenia (revision)",
    explanation: "Číslo verzie, ktoré bráni tomu, aby staršia obrazovka prepísala novšiu zmenu.",
  },
  {
    term: "Povolený zoznam (allowlist)",
    explanation: "Zoznam klapiek, ktoré smie aplikácia bezpečne priradiť osobným operátorom.",
  },
  {
    term: "Snímka stavu (snapshot)",
    explanation: "Uložený obraz klapiek, radov a hovorov z jedného konkrétneho okamihu.",
  },
  {
    term: "Dočasná pamäť (cache)",
    explanation: "Krátkodobo uložená kópia údajov, ktorá zrýchľuje načítanie, ale môže byť staršia než živý stav.",
  },
  {
    term: "Neaktuálny stav (stale)",
    explanation: "Údaj je starší než povolený čas a pred bezpečným uložením sa musí obnoviť.",
  },
  {
    term: "Bezpečné zamietnutie (fail-closed)",
    explanation: "Ak systém nevie bezpečnosť potvrdiť, zmenu radšej nevykoná a zachová pôvodné nastavenie.",
  },
  {
    term: "Podpis správy (HMAC)",
    explanation: "Kontrolný podpis vytvorený tajným kľúčom. Potvrdzuje, že správu cestou nikto nezmenil; tajný kľúč sa používateľovi nezobrazuje.",
  },
] as const;

export function TechnicalTermsDisclosure() {
  return (
    <details className="group rounded-md border border-zinc-200 bg-white">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md px-4 py-3 text-left outline-none hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-yellow-400 focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-3">
          <BookOpen size={18} className="shrink-0 text-zinc-600" aria-hidden="true" />
          <span>
            <span className="block text-sm font-bold text-zinc-950">Čo znamenajú technické pojmy?</span>
            <span className="mt-0.5 block text-xs leading-5 text-zinc-600">
              Jednoduché vysvetlenia výrazov používaných pri telefonovaní.
            </span>
          </span>
        </span>
        <ChevronDown
          size={18}
          className="shrink-0 text-zinc-500 motion-safe:transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>

      <div className="border-t border-zinc-200 px-4 py-4">
        <dl className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          {technicalTerms.map(({ explanation, term }) => (
            <div key={term} className="rounded-md bg-zinc-50 px-3 py-3">
              <dt className="text-sm font-bold text-zinc-950">{term}</dt>
              <dd className="mt-1 text-sm leading-5 text-zinc-600">{explanation}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}

function ReadinessIcon({ state }: { state: ReadinessState }) {
  if (state === "ready") {
    return <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden="true" />;
  }
  if (state === "checking") {
    return <RefreshCw size={20} className="mt-0.5 shrink-0 text-blue-600 motion-safe:animate-spin" aria-hidden="true" />;
  }
  return <CircleDashed size={20} className="mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />;
}

function connectionStateLabel(state: TelephonyHealthState) {
  if (state === "live") return "Spojenie je overené";
  if (state === "checking") return "Overujem spojenie";
  if (state === "configured") return "Pripojenie je nastavené a čaká na overenie";
  if (state === "mock") return "Používa sa testovací stav";
  if (state === "degraded") return "Spojenie má obmedzenia";
  if (state === "stale") return "Stav treba obnoviť";
  if (state === "disabled") return "Telefonovanie je vypnuté";
  return "Spojenie nie je dostupné";
}

function pluralizeNumbers(count: number) {
  if (count === 1) return "číslo";
  if (count >= 2 && count <= 4) return "čísla";
  return "čísel";
}
