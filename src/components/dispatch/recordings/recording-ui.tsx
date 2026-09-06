import type { ReactNode } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

export const recordingButtonClass = "inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-yellow-400 disabled:cursor-not-allowed disabled:opacity-50";
export const recordingInputClass = "min-h-10 w-full min-w-0 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none focus:ring-2 focus:ring-yellow-300 disabled:bg-zinc-100";

export function formatRecordingTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function RecordingSection({ title, children, accessory }: { title: string; children: ReactNode; accessory?: ReactNode }) {
  return <section className="min-w-0 rounded-lg border border-zinc-200 bg-white">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-3 py-3">
      <h3 className="text-sm font-semibold text-zinc-950">{title}</h3>{accessory}
    </div>
    <div className="min-w-0 space-y-3 p-3">{children}</div>
  </section>;
}

export function RecordingMessage({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div role={error ? "alert" : "status"} className={`flex min-w-0 items-start gap-2 rounded-md border p-3 text-sm ${error ? "border-red-200 bg-red-50 text-red-900" : "border-zinc-200 bg-zinc-50 text-zinc-700"}`}>
    <AlertCircle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /><span className="min-w-0 break-words">{children}</span>
  </div>;
}

export function RecordingLoading({ label = "Načítavam záznam hovoru…" }: { label?: string }) {
  return <p role="status" className="flex items-center gap-2 py-3 text-sm text-zinc-600"><Loader2 size={16} className="shrink-0 animate-spin" aria-hidden="true" />{label}</p>;
}
