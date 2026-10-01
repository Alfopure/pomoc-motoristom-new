import type { DiagnosticIncident, DiagnosticModule, DiagnosticOperation, DiagnosticOutcome, DiagnosticStoredEvent } from "@/lib/diagnostics/types";

export const moduleLabels: Record<DiagnosticModule, string> = { app: "Aplikácia", auth: "Prihlásenie", cases: "Prípady", telephony: "Telefonovanie", sms: "SMS", documents: "Dokumenty", fleet: "Flotila", integrations: "Integrácie" };
export const operationLabels: Record<DiagnosticOperation, string> = {
  "case.open": "Otvorenie prípadu", "case.create": "Vytvorenie prípadu", "case.save": "Uloženie prípadu", "case.assign": "Priradenie prípadu", "case.action": "Akcia prípadu",
  "call.start": "Vytočenie hovoru", "call.pickup": "Prijatie hovoru", "call.hangup": "Ukončenie hovoru", "call.transfer": "Prepojenie hovoru", "call.hold": "Podržanie hovoru",
  "sms.send": "Odoslanie SMS", "document.upload": "Nahratie dokumentu", "document.download": "Stiahnutie dokumentu", "document.generate": "Vytvorenie dokumentu",
  "fleet.refresh": "Obnovenie flotily", "integration.lookup": "Dohľadanie údajov", "auth.login": "Prihlásenie", "app.refresh": "Obnovenie aplikácie",
};
export const outcomeLabels: Record<DiagnosticOutcome, string> = { ok: "Potvrdené", failed: "Zlyhanie", conflict: "Konflikt zmien", cancelled: "Zrušené", timeout: "Časový limit", unknown: "Výsledok nezistený", committed_refresh_failed: "Uložené, obnovenie zlyhalo" };
export const statusLabels = { new: "Nový", acknowledged: "Preveruje sa", resolved: "Vyriešený" } as const;
export const classificationLabels: Record<DiagnosticIncident["classification"], string> = { observation: "Zaznamenaná udalosť", candidate: "Možné prerušenie", interruption_observed: "Prerušenie potvrdené", expected_end: "Očakávané ukončenie", unknown: "Nedostatok dôkazov" };
export const kindLabels: Record<DiagnosticIncident["kind"], string> = { ui_error: "Chyba obrazovky", user_report: "Hlásenie používateľa", operation: "Problém pri úkone", call_interruption: "Prerušenie hovoru" };
export const eventLabels: Record<DiagnosticStoredEvent["type"], string> = { ui_error: "Chyba obrazovky", unhandled_rejection: "Nezachytená chyba", chunk_error: "Chyba načítania aplikácie", user_report: "Hlásenie používateľa", operation: "Úkon", page_lifecycle: "Stav stránky", phone_lifecycle: "Stav telefónu", app_update: "Verzia aplikácie", call_timing: "Priebeh spojenia", coverage: "Úplnosť zberu" };
export function timestamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Nezistené";
  return new Intl.DateTimeFormat("sk-SK", { timeZone: "Europe/Bratislava", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "Nezistené";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}
export function latency(ms: number | null | undefined): string { return ms == null || !Number.isFinite(ms) ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toLocaleString("sk-SK", { maximumFractionDigits: 2 })} s`; }
/** Browser wall time must continue expiring old observations after a failed request. */
export function freshness(observedAt: number | null, now: number, maxAge: number): "unknown" | "fresh" | "stale" {
  if (observedAt === null || !Number.isFinite(observedAt) || observedAt > now + 60_000) return "unknown";
  return now - observedAt >= maxAge ? "stale" : "fresh";
}
export function canShowPercentiles(samples: number, insufficient: boolean): boolean { return !insufficient && Number.isFinite(samples) && samples >= 100; }
