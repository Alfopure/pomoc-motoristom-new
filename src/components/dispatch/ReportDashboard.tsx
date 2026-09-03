"use client";

import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  Award,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  Gauge,
  Loader2,
  PhoneCall,
  RefreshCw,
  Timer,
  UserRound,
  Users,
} from "lucide-react";
import type { ReportChartPoint, ReportDashboardData, ReportOperatorRow, ReportRangeKey } from "@/lib/reporting";

import { QaDashboard } from "./QaDashboard";
import { TelephonyStatsWidgets } from "./TelephonyStatsWidgets";

type ReportTab = "overview" | "calls" | "quality" | "operators" | "cases";

const tabs: Array<{ icon: LucideIcon; label: string; value: ReportTab }> = [
  { icon: Gauge, label: "Prehľad", value: "overview" },
  { icon: PhoneCall, label: "Hovory", value: "calls" },
  { icon: Award, label: "Kvalita", value: "quality" },
  { icon: Users, label: "Operátori", value: "operators" },
  { icon: BriefcaseBusiness, label: "Prípady", value: "cases" },
];

const rangeOptions: Array<{ label: string; value: ReportRangeKey }> = [
  { label: "Dnes", value: "today" },
  { label: "7 dní", value: "7d" },
  { label: "30 dní", value: "30d" },
];

const chartColors = ["#FCD703", "#18181B", "#10B981", "#F97316", "#3B82F6", "#A855F7", "#EF4444"];

export function ReportDashboard() {
  const [activeTab, setActiveTab] = useState<ReportTab>("overview");
  const [range, setRange] = useState<ReportRangeKey>("7d");
  const [data, setData] = useState<ReportDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    async function loadReport() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/reports/dashboard?range=${range}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = (await response.json().catch(() => null)) as (ReportDashboardData & { error?: string }) | null;
        if (!response.ok || !result) throw new Error(result?.error ?? "Report sa nepodarilo načítať.");
        setData(result);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Report sa nepodarilo načítať.");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    void loadReport();
    return () => controller.abort();
  }, [range, refreshKey]);

  return (
    <main className="flex-1 bg-zinc-100 p-3 pb-[calc(84px+env(safe-area-inset-bottom))] sm:p-4 sm:pb-6">
      <h1 className="sr-only">Reporty</h1>
      <div className="mx-auto max-w-[1500px]">
        <nav className="sticky top-0 z-30 mb-3 bg-zinc-100/95 py-2 backdrop-blur" aria-label="Kategórie reportov">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            {tabs.map(({ icon: Icon, label, value }) => {
              const active = activeTab === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setActiveTab(value)}
                  aria-current={active ? "page" : undefined}
                  className={`flex min-h-12 items-center justify-center gap-2 rounded-md border px-3 text-sm font-semibold transition ${
                    active
                      ? "border-yellow-400 bg-[#FCD703] text-zinc-950 shadow-sm"
                      : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50"
                  }`}
                >
                  <Icon size={17} />
                  {label}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-zinc-200 bg-white px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Obdobie</span>
            <div className="flex rounded-md bg-zinc-100 p-1">
              {rangeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setRange(option.value)}
                  className={`rounded px-2.5 py-1.5 text-xs font-semibold transition ${
                    range === option.value ? "bg-white text-zinc-950 shadow-sm" : "text-zinc-500 hover:text-zinc-800"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            {data && !loading ? <span>{data.range.label}</span> : null}
            <button
              type="button"
              onClick={() => setRefreshKey((value) => value + 1)}
              disabled={loading}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-2.5 font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              Obnoviť
            </button>
          </div>
        </div>

        {error && !data ? (
          <ReportError message={error} onRetry={() => setRefreshKey((value) => value + 1)} />
        ) : loading && !data ? (
          <ReportLoading />
        ) : data ? (
          <>
            {error && <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-900">{error}</div>}
            {activeTab === "overview" && <OverviewDashboard data={data} />}
            {activeTab === "calls" && <CallsDashboard data={data} />}
            {activeTab === "quality" && <QualityDashboard />}
            {activeTab === "operators" && <OperatorsDashboard data={data} />}
            {activeTab === "cases" && <CasesDashboard data={data} />}
          </>
        ) : null}
      </div>
    </main>
  );
}

function OverviewDashboard({ data }: { data: ReportDashboardData }) {
  const { overview } = data;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-12">
      <StatCard className="xl:col-span-3" icon={PhoneCall} label="Všetky hovory" value={formatNumber(overview.totalCalls)} detail={data.range.label} tone="dark" />
      <StatCard
        className="xl:col-span-3"
        icon={CheckCircle2}
        label="Úspešnosť prijatia"
        value={overview.answerRate === null ? "—" : `${overview.answerRate}%`}
        detail={overview.completedInboundCalls > 0
          ? `Prijatých ${overview.answeredInboundCalls} z ${overview.completedInboundCalls} ukončených prichádzajúcich`
          : "Zatiaľ bez ukončených prichádzajúcich hovorov"}
        tone="yellow"
      />
      <StatCard
        className="xl:col-span-3"
        icon={Timer}
        label="Medián čakania"
        value={formatDuration(overview.medianWaitSeconds)}
        detail={overview.medianWaitSeconds === null ? "Zatiaľ chýba údaj o čase prijatia" : "Polovica prijatých čakala kratšie"}
      />
      <StatCard className="xl:col-span-3" icon={BriefcaseBusiness} label="Nové prípady" value={formatNumber(overview.newCases)} detail={`${overview.completedCases} uzatvorených v období`} />

      <ChartCard className="md:col-span-2 xl:col-span-8" title="Zaťaženie linky" subtitle="Počet hovorov v jednotlivých dňoch">
        <BarChart data={overview.callsByDay} height={250} />
      </ChartCard>
      <ChartCard className="xl:col-span-4" title="Výsledok hovorov" subtitle="Ako sa hovory v období skončili">
        <DonutChart data={overview.callResults} centerLabel={formatNumber(overview.totalCalls)} centerDetail="hovorov" />
      </ChartCard>

      <ChartCard className="md:col-span-2 xl:col-span-7" title="Stav nových prípadov" subtitle="Aktuálny výsledok prípadov vytvorených v období">
        <HorizontalBarChart data={overview.caseFlow} />
      </ChartCard>
      <section className="overflow-hidden rounded-md border border-zinc-200 bg-zinc-950 text-white md:col-span-2 xl:col-span-5">
        <div className="border-b border-white/10 px-4 py-3">
          <h2 className="text-sm font-semibold">Čomu venovať pozornosť</h2>
          <p className="mt-0.5 text-xs text-zinc-400">Aktuálne pracovné položky, nie odhad.</p>
        </div>
        <div className="grid grid-cols-2 gap-px bg-white/10">
          <AttentionMetric label="Otvorené úlohy" value={overview.openTasks} icon={Clock3} />
          <AttentionMetric label="Po termíne" value={overview.overdueTasks} icon={AlertTriangle} warn={overview.overdueTasks > 0} />
          <AttentionMetric label="Ukončené prípady" value={overview.completedCases} icon={CheckCircle2} />
          <AttentionMetric label="Prijaté do 30 s" value={overview.serviceLevel === null ? "—" : `${overview.serviceLevel}%`} icon={Timer} />
        </div>
      </section>
    </div>
  );
}

function CallsDashboard({ data }: { data: ReportDashboardData }) {
  const calls = data.calls;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-12">
      <TelephonyStatsWidgets />
      <StatCard className="xl:col-span-2" icon={PhoneCall} label="Prichádzajúce" value={formatNumber(calls.inboundCalls)} detail={`${calls.answeredCalls} prijatých`} tone="dark" />
      <StatCard className="xl:col-span-2" icon={AlertTriangle} label="Zmeškané" value={formatNumber(calls.missedCalls)} detail="vrátane opustených v rade" tone={calls.missedCalls > 0 ? "red" : "default"} />
      <StatCard className="xl:col-span-2" icon={Activity} label="Odchádzajúce" value={formatNumber(calls.outboundCalls)} detail={`${calls.linkedToCaseRate}% všetkých prepojených s prípadom`} />
      <StatCard className="xl:col-span-3" icon={Clock3} label="Celkový čas spojených hovorov" value={formatLongDuration(calls.totalTalkSeconds)} detail="Súčet času po prijatí hovoru" tone="yellow" />
      <StatCard className="xl:col-span-3" icon={Timer} label="Priemerná dĺžka hovoru" value={formatDuration(calls.averageDurationSeconds)} detail="Na jeden spojený hovor" />

      <ChartCard className="md:col-span-2 xl:col-span-8" title="Kedy ľudia volajú" subtitle="Hovory zoskupené do dvojhodinových intervalov">
        <BarChart data={calls.byHour} height={260} highlightPeak />
      </ChartCard>
      <ChartCard className="xl:col-span-4" title="Smer hovorov" subtitle="Prichádzajúce, odchádzajúce a interné">
        <DonutChart data={calls.directions} centerLabel={formatNumber(data.overview.totalCalls)} centerDetail="spolu" />
      </ChartCard>

      <ChartCard className="md:col-span-2 xl:col-span-7" title="Vývoj počtu hovorov" subtitle={data.range.label}>
        <BarChart data={calls.byDay} height={210} />
      </ChartCard>
      <ChartCard
        className="xl:col-span-5"
        title="Ako dlho čakali"
        subtitle={calls.waitSampleSize > 0
          ? `Priemer ${formatDuration(calls.averageWaitSeconds)} · ${calls.waitSampleSize} prijatých s dostupným časom`
          : "Zobrazí sa pri prijatých hovoroch s dostupným časom čakania"}
      >
        <HorizontalBarChart data={calls.waitBuckets} emptyMessage="Pri uložených hovoroch zatiaľ chýba čas čakania." />
      </ChartCard>
    </div>
  );
}

function OperatorsDashboard({ data }: { data: ReportDashboardData }) {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-12">
      <ChartCard className="xl:col-span-7" title="Hovory podľa operátora" subtitle="Objem spracovaných a priradených hovorov">
        <HorizontalBarChart data={data.operators.callsByOperator} />
      </ChartCard>
      <ChartCard className="xl:col-span-5" title="Čas na hovore" subtitle="Celkový čas v minútach, nie hodnotenie kvality">
        <BarChart data={data.operators.talkTimeByOperator} height={250} compactLabels />
      </ChartCard>
      <OperatorTable rows={data.operators.rows} />
    </div>
  );
}

/**
 * Quality without recordings: the QA panel gates itself on the reader's role,
 * so a dispatcher who opens the tab is told why it is empty rather than left
 * looking at nothing.
 */
function QualityDashboard() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-12">
      <QaDashboard />
      <section className="rounded-md border border-zinc-200 bg-white p-4 text-xs leading-5 text-zinc-600 md:col-span-2 xl:col-span-12">
        Prehľad kvality vidia služobne starší dispečeri, manažéri a administrátori. Hovory sa v tejto verzii nenahrávajú ani neprepisujú,
        takže sa hodnotí zapísaný výsledok hovoru a dodržanie sľúbených spätných volaní.
      </section>
    </div>
  );
}

function CasesDashboard({ data }: { data: ReportDashboardData }) {
  const cases = data.cases;
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-12">
      <StatCard className="xl:col-span-3" icon={BriefcaseBusiness} label="Vytvorené prípady" value={formatNumber(cases.created)} detail={data.range.label} tone="dark" />
      <StatCard className="xl:col-span-3" icon={CheckCircle2} label="Ukončené" value={formatNumber(cases.completed)} detail={`priemerne za ${formatHours(cases.averageClosureHours)}`} tone="yellow" />
      <StatCard className="xl:col-span-3" icon={Activity} label="Aktívne z nových" value={formatNumber(cases.active)} detail="stále rozpracované" />
      <StatCard className="xl:col-span-3" icon={AlertTriangle} label="Márne výjazdy" value={formatNumber(cases.futileTrips)} detail={`${cases.replacementVehicles}× požadované náhradné vozidlo`} tone={cases.futileTrips > 0 ? "red" : "default"} />

      <ChartCard className="md:col-span-2 xl:col-span-8" title="Nové prípady v čase" subtitle="Počet vytvorených prípadov po dňoch">
        <BarChart data={cases.byDay} height={250} />
      </ChartCard>
      <ChartCard className="xl:col-span-4" title="Priority" subtitle="Ako naliehavé boli nové prípady">
        <DonutChart data={cases.priorities} centerLabel={formatNumber(cases.created)} centerDetail="prípadov" />
      </ChartCard>

      <ChartCard className="xl:col-span-6" title="Aktuálny stav" subtitle="Najčastejšie stavy prípadov vytvorených v období">
        <HorizontalBarChart data={cases.statuses} />
      </ChartCard>
      <ChartCard className="xl:col-span-6" title="Odkiaľ prípady prišli" subtitle="Klienti, asistenčné služby, partneri a samoplatcovia">
        <HorizontalBarChart data={cases.sources} />
      </ChartCard>
      <ChartCard className="md:col-span-2 xl:col-span-12" title="Požadovaná služba" subtitle="Jedna karta môže obsahovať viac služieb">
        <HorizontalBarChart data={cases.jobTypes} />
      </ChartCard>
    </div>
  );
}

function StatCard({ className = "", detail, icon: Icon, label, tone = "default", value }: {
  className?: string;
  detail: string;
  icon: LucideIcon;
  label: string;
  tone?: "default" | "dark" | "yellow" | "red";
  value: string;
}) {
  const toneClass = {
    default: "border-zinc-200 bg-white text-zinc-950",
    dark: "border-zinc-950 bg-zinc-950 text-white",
    yellow: "border-yellow-400 bg-[#FCD703] text-zinc-950",
    red: "border-red-200 bg-red-50 text-red-950",
  }[tone];
  const detailClass = tone === "dark" ? "text-zinc-400" : tone === "red" ? "text-red-700" : "text-zinc-600";
  return (
    <section className={`relative min-h-36 overflow-hidden rounded-md border p-4 ${toneClass} ${className}`}>
      <div className="flex items-center justify-between gap-3 text-sm font-semibold">
        <span>{label}</span>
        <Icon size={18} className={tone === "yellow" ? "text-zinc-700" : tone === "dark" ? "text-yellow-300" : "text-zinc-500"} />
      </div>
      <div className="mt-5 text-4xl font-bold tracking-tight">{value}</div>
      <div className={`mt-1 text-xs font-medium ${detailClass}`}>{detail}</div>
    </section>
  );
}

function ChartCard({ children, className = "", subtitle, title }: { children: React.ReactNode; className?: string; subtitle: string; title: string }) {
  return (
    <section className={`overflow-hidden rounded-md border border-zinc-200 bg-white ${className}`}>
      <div className="border-b border-zinc-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-950">{title}</h2>
        <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function BarChart({ compactLabels = false, data, height, highlightPeak = false }: {
  compactLabels?: boolean;
  data: ReportChartPoint[];
  height: number;
  highlightPeak?: boolean;
}) {
  const max = Math.max(0, ...data.map((point) => point.value));
  const peakIndex = data.findIndex((point) => point.value === max);
  if (data.length === 0 || max === 0) return <EmptyChart />;
  return (
    <div className="overflow-x-auto" role="img" aria-label={data.map((point) => `${point.label}: ${point.value}`).join(", ")}>
      <div
        className="flex items-end gap-2"
        style={{ height, minWidth: Math.max(520, data.length * 32) }}
      >
        {data.map((point, index) => {
          const highlighted = highlightPeak && index === peakIndex;
          return (
            <div key={`${point.label}-${index}`} className="flex h-full min-w-0 flex-1 flex-col justify-end">
              <div className="mb-1 text-center text-[11px] font-semibold text-zinc-600">{point.value || ""}</div>
              <div
                title={`${point.label}: ${point.value}`}
                className={`mx-auto w-full max-w-12 rounded-t-sm transition ${highlighted ? "bg-[#FCD703]" : "bg-zinc-900"}`}
                style={{ height: `${Math.max(4, (point.value / max) * (height - 52))}px` }}
              />
              <div className={`mt-2 truncate text-center text-zinc-500 ${compactLabels ? "text-[10px]" : "text-[11px]"}`} title={point.label}>{point.label}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HorizontalBarChart({ data, emptyMessage }: { data: ReportChartPoint[]; emptyMessage?: string }) {
  const max = Math.max(0, ...data.map((point) => point.value));
  if (data.length === 0 || max === 0) return <EmptyChart message={emptyMessage} />;
  return (
    <div className="grid gap-3" role="img" aria-label={data.map((point) => `${point.label}: ${point.value}`).join(", ")}>
      {data.map((point, index) => (
        <div key={`${point.label}-${index}`}>
          <div className="mb-1 flex items-center justify-between gap-3 text-xs">
            <span className="truncate font-medium text-zinc-700" title={point.label}>{point.label}</span>
            <span className="font-semibold text-zinc-950">{point.value}</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100">
            <div className="h-full rounded-full" style={{ width: `${Math.max(2, (point.value / max) * 100)}%`, backgroundColor: chartColors[index % chartColors.length] }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ centerDetail, centerLabel, data }: { centerDetail: string; centerLabel: string; data: ReportChartPoint[] }) {
  const visible = data.filter((point) => point.value > 0);
  const total = visible.reduce((sum, point) => sum + point.value, 0);
  if (total === 0) return <EmptyChart />;
  const stops = visible.map((point, index) => {
    const start = visible.slice(0, index).reduce((sum, item) => sum + (item.value / total) * 100, 0);
    const end = start + (point.value / total) * 100;
    return `${chartColors[index % chartColors.length]} ${start}% ${end}%`;
  });
  return (
    <div className="grid items-center gap-5 sm:grid-cols-[170px_minmax(0,1fr)] lg:grid-cols-1 xl:grid-cols-[170px_minmax(0,1fr)]">
      <div className="relative mx-auto h-40 w-40 rounded-full" style={{ background: `conic-gradient(${stops.join(", ")})` }} role="img" aria-label={visible.map((point) => `${point.label}: ${point.value}`).join(", ")}>
        <div className="absolute inset-7 flex flex-col items-center justify-center rounded-full bg-white text-center">
          <strong className="text-2xl text-zinc-950">{centerLabel}</strong>
          <span className="text-[11px] font-medium text-zinc-500">{centerDetail}</span>
        </div>
      </div>
      <div className="grid gap-2">
        {visible.map((point, index) => (
          <div key={point.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-2 text-zinc-600">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ backgroundColor: chartColors[index % chartColors.length] }} />
              <span className="truncate">{point.label}</span>
            </span>
            <span className="font-semibold text-zinc-950">{point.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function OperatorTable({ rows }: { rows: ReportOperatorRow[] }) {
  return (
    <section className="overflow-hidden rounded-md border border-zinc-200 bg-white xl:col-span-12">
      <div className="border-b border-zinc-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-zinc-950">Detail podľa operátora</h2>
        <p className="mt-0.5 text-xs text-zinc-500">Objem práce a čas, nie rebríček kvality.</p>
      </div>
      {rows.length === 0 ? <EmptyChart /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-left text-xs">
            <thead className="bg-zinc-50 text-zinc-500">
              <tr>
                <TableHead>Operátor</TableHead>
                <TableHead>Hovory</TableHead>
                <TableHead>Prijaté</TableHead>
                <TableHead>Odchádzajúce</TableHead>
                <TableHead>Čas hovoru</TableHead>
                <TableHead>Priemer</TableHead>
                <TableHead>Prípady</TableHead>
                <TableHead>Hotové úlohy</TableHead>
                <TableHead>Odpracované</TableHead>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((row) => (
                <tr key={row.id} className="text-zinc-700 hover:bg-zinc-50/70">
                  <td className="px-4 py-3 font-semibold text-zinc-950"><span className="inline-flex items-center gap-2"><UserRound size={14} className="text-zinc-400" />{row.name}</span></td>
                  <TableCell>{row.totalCalls}</TableCell>
                  <TableCell>{row.answeredCalls}</TableCell>
                  <TableCell>{row.outboundCalls}</TableCell>
                  <TableCell>{formatLongDuration(row.talkSeconds)}</TableCell>
                  <TableCell>{formatDuration(row.averageDurationSeconds)}</TableCell>
                  <TableCell>{row.linkedCases}</TableCell>
                  <TableCell>{row.completedTasks}</TableCell>
                  <TableCell>{row.workedMinutes > 0 ? formatMinutes(row.workedMinutes) : "—"}</TableCell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AttentionMetric({ icon: Icon, label, value, warn = false }: { icon: LucideIcon; label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="bg-zinc-950 p-4">
      <div className="flex items-center gap-2 text-xs text-zinc-400"><Icon size={14} className={warn ? "text-red-400" : "text-yellow-300"} />{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${warn ? "text-red-300" : "text-white"}`}>{value}</div>
    </div>
  );
}

function TableHead({ children }: { children: React.ReactNode }) {
  return <th className="whitespace-nowrap px-4 py-2.5 font-semibold">{children}</th>;
}

function TableCell({ children }: { children: React.ReactNode }) {
  return <td className="whitespace-nowrap px-4 py-3 font-medium">{children}</td>;
}

function EmptyChart({ message = "Pre toto obdobie ešte nie sú údaje." }: { message?: string }) {
  return <div className="flex min-h-36 items-center justify-center rounded-md bg-zinc-50 px-4 text-center text-sm font-medium text-zinc-500">{message}</div>;
}

function ReportLoading() {
  return (
    <div className="grid min-h-[420px] place-items-center rounded-md border border-zinc-200 bg-white">
      <div className="text-center text-sm font-medium text-zinc-600"><Loader2 size={24} className="mx-auto mb-2 animate-spin text-zinc-900" />Načítavam report…</div>
    </div>
  );
}

function ReportError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-5 text-center text-red-900">
      <AlertTriangle size={24} className="mx-auto mb-2" />
      <div className="font-semibold">Report sa nepodarilo načítať</div>
      <div className="mt-1 text-sm">{message}</div>
      <button type="button" onClick={onRetry} className="mt-4 inline-flex h-9 items-center gap-2 rounded-md bg-zinc-950 px-3 text-xs font-semibold text-white hover:bg-zinc-800"><RefreshCw size={13} />Skúsiť znova</button>
    </div>
  );
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("sk-SK").format(value);
}

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  if (seconds <= 0) return "0 s";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function formatLongDuration(seconds: number) {
  if (!seconds) return "0 min";
  const minutes = Math.round(seconds / 60);
  return formatMinutes(minutes);
}

function formatMinutes(minutes: number) {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function formatHours(hours: number) {
  if (!hours) return "—";
  if (hours < 24) return `${Math.round(hours)} h`;
  return `${(hours / 24).toLocaleString("sk-SK", { maximumFractionDigits: 1 })} d`;
}
