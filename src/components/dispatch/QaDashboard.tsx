"use client";

import { useEffect, useState } from "react";
import { Award } from "lucide-react";
import { telephonyFetch, TELEPHONY_TIMEOUT_MS } from "@/lib/telephony/client-request";

type QaDashboardData = {
  totalScored: number;
  lookbackDays: number;
  operators: Array<{ name: string; calls: number; avgScore: number | null }>;
  weeklyTrend: Array<{ week: string; calls: number; avgScore: number | null }>;
  worstCalls: Array<{ callId: string; score: number; summary: string | null; operator: string; callerNumber: string | null; startedAt: string | null }>;
};

// Self-gating: the API allows senior_dispatcher/manager/admin; anyone else gets 403 and
// the whole section stays hidden.
export function QaDashboard() {
  const [data, setData] = useState<QaDashboardData | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    telephonyFetch("/api/telephony/qa/dashboard", {
      label: "QA prehľad",
      signal: controller.signal,
      timeoutMs: TELEPHONY_TIMEOUT_MS.read,
    })
      .then(async (response) => {
        if (response.ok) {
          setData((await response.json()) as QaDashboardData);
        }
      })
      .catch(() => undefined);

    return () => controller.abort();
  }, []);

  if (!data || data.totalScored === 0) {
    return null;
  }

  return (
    <section className="rounded-md border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 p-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-950">
          <Award size={17} />
          Kvalita hovorov (AI hodnotenie)
        </div>
        <span className="text-xs font-semibold text-zinc-500">
          {data.totalScored} hodnotených hovorov / {data.lookbackDays} dní
        </span>
      </div>
      <div className="grid gap-4 p-3 lg:grid-cols-3">
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Priemer podľa dispečera</h4>
          <div className="space-y-1.5">
            {data.operators.map((operator) => (
              <div key={operator.name} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-zinc-800">{operator.name}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{operator.calls}×</span>
                  <ScoreBadge score={operator.avgScore} />
                </span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Trend po týždňoch</h4>
          <div className="space-y-1.5">
            {data.weeklyTrend.slice(-6).map((week) => (
              <div key={week.week} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-zinc-800">{week.week}</span>
                <span className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{week.calls}×</span>
                  <ScoreBadge score={week.avgScore} />
                </span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Najslabšie hovory</h4>
          <div className="space-y-1.5">
            {data.worstCalls.map((call) => (
              <div key={call.callId} className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-zinc-800">
                    {call.callerNumber ?? "?"} · {call.operator}
                  </span>
                  <ScoreBadge score={call.score} />
                </div>
                {call.summary ? <p className="truncate text-xs text-zinc-500">{call.summary}</p> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) {
    return <span className="text-xs text-zinc-400">–</span>;
  }

  const tone = score >= 80 ? "bg-green-100 text-green-800" : score >= 60 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-700";

  return <span className={`rounded-md px-1.5 py-0.5 text-xs font-bold ${tone}`}>{score}</span>;
}
