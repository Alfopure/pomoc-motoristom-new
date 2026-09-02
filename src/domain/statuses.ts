import type { CasePriority, CaseStatus, CallStatus, OperatorStatus } from "./types";

export const caseStatusLabels: Record<CaseStatus, string> = {
  new: "Nový",
  triage: "Triedenie",
  open: "Otvorený",
  waiting_for_client: "Čaká na klienta",
  scheduled: "Naplánované",
  assigned: "Priradené",
  dispatched: "Vyslané",
  in_progress: "Prebieha",
  waiting_for_docs: "Čaká na doklady",
  completed_assisted: "Vybavené",
  completed_no_assistance: "Bez asistencie",
  rejected: "Odmietnuté",
  cancelled: "Zrušené",
  futile_trip: "Marný výjazd",
};

export const casePriorityLabels: Record<CasePriority, string> = {
  urgent: "Horí",
  high: "Vysoká",
  normal: "Bežná",
  low: "Nízka",
};

/** Priority prípadu od najvyššej po najnižšiu — poradie pre výbery v UI. */
export const casePriorities = ["urgent", "high", "normal", "low"] as const satisfies readonly CasePriority[];

export const callStatusLabels: Record<CallStatus, string> = {
  incoming: "Prichádza",
  ringing_agent: "Zvoní",
  answered: "Prijatý",
  missed: "Zmeškaný",
  outbound: "Odchádzajúci",
  ended: "Ukončený",
};

export const operatorStatusLabels: Record<OperatorStatus, string> = {
  available: "Dostupný",
  ringing: "Zvoní",
  on_call: "Na hovore",
  after_call_work: "Dopisuje",
  working_case: "Rieši prípad",
  paused: "Pauza",
  offline: "Offline",
};

export const caseStatusTone: Record<CaseStatus, string> = {
  new: "bg-blue-50 text-blue-700 ring-blue-200",
  triage: "bg-sky-50 text-sky-700 ring-sky-200",
  open: "bg-zinc-100 text-zinc-700 ring-zinc-200",
  waiting_for_client: "bg-amber-50 text-amber-800 ring-amber-200",
  scheduled: "bg-indigo-50 text-indigo-700 ring-indigo-200",
  assigned: "bg-yellow-100 text-zinc-900 ring-yellow-300",
  dispatched: "bg-orange-50 text-orange-700 ring-orange-200",
  in_progress: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  waiting_for_docs: "bg-purple-50 text-purple-700 ring-purple-200",
  completed_assisted: "bg-emerald-100 text-emerald-800 ring-emerald-300",
  completed_no_assistance: "bg-slate-100 text-slate-700 ring-slate-300",
  rejected: "bg-red-50 text-red-700 ring-red-200",
  cancelled: "bg-zinc-100 text-zinc-500 ring-zinc-200",
  futile_trip: "bg-rose-50 text-rose-700 ring-rose-200",
};

export const priorityTone: Record<CasePriority, string> = {
  urgent: "bg-red-600 text-white",
  high: "bg-orange-500 text-white",
  normal: "bg-zinc-800 text-white",
  low: "bg-zinc-200 text-zinc-700",
};
