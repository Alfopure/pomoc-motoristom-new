import { evaluateBusinessHours } from "./business-hours";
import { describeRingPlan, NO_RUNNABLE_STEP_OUTCOME, planDraftsFromDocument } from "./ring-plan-model";
import { returnLineProblem } from "./return-line";
import type { IvrOptionDoc, RoutingDocument } from "@/server/telephony/config-service";

export type RoutingNavigationTarget = { section: "telephony"; tab: "incoming" | "numbers" | "ivr" | "hours"; lineId?: string; planId?: string; groupId?: string; ivrMenuId?: string; businessHoursId?: string };
export type RoutingSummaryLine = {
  id: string; label: string; phoneNumber: string; environment: string; active: boolean;
  effectiveLineLabel: string | null; status: "open" | "closed" | "inactive" | "unavailable";
  timezone: string | null; sentence: string;
  branches: Array<{ label: string; sentence: string; target: RoutingNavigationTarget }>;
  notes: string[]; target: RoutingNavigationTarget;
};
export type RoutingSummary = { snapshotId: string; checkedAt: string; validUntil: string; canEdit: boolean; lines: RoutingSummaryLine[] };

/** Only operational output leaves the server: never devices, SIP identities or raw settings. */
export function buildRoutingSummary(document: RoutingDocument, now: Date, canEdit: boolean, runtime?: { liveCallsEnabled: boolean }): RoutingSummary {
  const describe = (planId: string | null) => {
    const plan = document.plans.find(candidate => candidate.id === planId);
    if (!plan) return `Plán nie je dostupný; ${NO_RUNNABLE_STEP_OUTCOME}.`;
    return describeRingPlan(planDraftsFromDocument([plan])[0], document.groups, document.settingsConfigured ? document.limits?.maxRingFanout : undefined)
      .replaceAll("zvoní všetkým", "skúsi dostupných členov naraz");
  };
  const lines = document.lines.map((source): RoutingSummaryLine => {
    const targetLine = source.returnLineId ? document.lines.find(line => line.id === source.returnLineId) : source;
    const problem = returnLineProblem(source, document.lines, document.plans, document.groups, new Set(document.operators.filter(operator => operator.active).map(operator => operator.profileId)));
    const target: RoutingNavigationTarget = { section: "telephony", tab: "incoming", lineId: source.id, ...(targetLine?.ringPlanId ? { planId: targetLine.ringPlanId } : {}) };
    const base = { id: source.id, label: source.label, phoneNumber: source.phoneNumber, environment: source.environment, active: source.active, effectiveLineLabel: source.returnLineId ? targetLine?.label ?? null : null, target };
    if (!source.active) return { ...base, status: "inactive", timezone: null, sentence: "Linka je v aplikácii neaktívna. To nevypína číslo u poskytovateľa; prichádzajúci hovor môže skončiť ponukou spätného volania.", branches: [], notes: [], target: { ...target, tab: "numbers" } };
    if (!targetLine || problem) return { ...base, status: "unavailable", timezone: null, sentence: "Návratová linka nemá platné smerovanie. Správca musí skontrolovať jej nastavenie.", branches: [], notes: [], target: { ...target, tab: "numbers" } };
    const hours = document.businessHours.find(row => row.id === targetLine.businessHoursId && row.active);
    const decision = evaluateBusinessHours(hours ?? null, now);
    const notes = ["Pravidlá platia pre nové hovory. Rozbehnutý hovor pokračuje podľa svojho uloženého plánu.", "Systém skúša iba dostupných členov. Skutočný čas závisí aj od pripravenosti telefónov a kapacity; ďalšieho operátora nemožno vopred zaručiť."];
    if (!hours) notes.push("Bez aktívneho rozvrhu platí nepretržitá prevádzka.");
    if (decision.exceptionLabel) notes.push(`Dátumová výnimka: ${decision.exceptionLabel}.`);
    if (!decision.open) return { ...base, status: "closed", timezone: hours?.timezone ?? null, sentence: "Po úvode a kontrole otváracích hodín sa ponúkne spätné volanie. Pri skrytom alebo neplatnom čísle spätné volanie nie je možné.", branches: [], notes, target: { ...target, tab: "hours", businessHoursId: hours?.id } };
    const menu = document.ivrMenus.find(row => row.id === targetLine.ivrMenuId && row.active);
    const branch = (option: IvrOptionDoc): string => {
      switch (option.action) {
        case "ring_plan": {
          const plan = document.plans.find(row => row.id === option.targetRingPlanId && row.active);
          return plan ? describe(plan.id) : `Cieľový plán nie je aktívny; použije sa plán linky. ${describe(targetLine.ringPlanId)}`;
        }
        case "callback": return "Uloží sa požiadavka na spätné volanie (ak má volajúci platné číslo).";
        case "external_number": return `Systém skúsi externé číslo ${option.targetNumber ?? "(chýba)"}.`;
        case "waiting_room": return "Hovor prejde do čakárne.";
        case "repeat": return "Zopakuje sa hlasové menu.";
        case "hangup": return "Prehrá sa záverečná hláška a hovor sa ukončí.";
      }
    };
    const branches = menu ? [
      ...menu.options.map(option => ({ label: `Voľba ${option.digit}: ${option.label}`, sentence: branch(option), target: { ...target, tab: "ivr" as const, ivrMenuId: menu.id, ...(option.targetRingPlanId ? { planId: option.targetRingPlanId } : {}) } })),
      { label: "Bez platnej voľby", sentence: `Po vyčerpaní pokusov sa použije plán linky. ${describe(targetLine.ringPlanId)}`, target },
    ] : [];
    if (document.settingsConfigured && document.settings) {
      notes.push(`Pri čakárni pre nový hovor platí limit ${document.settings.parkMaxMinutes} min. Prvá ponuka spätného volania môže zaznieť skôr.`);
      if (document.settings.queueEscalateAfterSeconds > 0) notes.push(`Po ${document.settings.queueEscalateAfterSeconds} s nepretržitej nedostupnosti v čakárni je jeden pokus o spôsobilú externú zálohu; nejde o vek hovoru ani obvolanie všetkých záloh.`);
      else notes.push("Eskalácia čakárne pri nedostupnosti je vypnutá.");
    } else notes.push("Účinné limity čakárne a súbežného zvonenia zatiaľ nie sú overené.");
    return { ...base, status: "open", timezone: hours?.timezone ?? null, sentence: menu ? `Po úvode a kontrole hodín nasleduje hlasové menu „${menu.name}“. Ďalší postup závisí od voľby volajúceho.` : `Po úvode a kontrole hodín: ${describe(targetLine.ringPlanId)}`, branches, notes };
  });
  if (runtime && !runtime.liveCallsEnabled) {
    for (const line of lines) {
      line.sentence = `Živé volanie nie je povolené. Uložené pravidlá: ${line.sentence}`;
      line.notes.unshift("Nastavené poradie sa nevydáva za prebiehajúce zvonenie. Aktiváciu živého volania spravuje administrátor.");
    }
  }
  return { snapshotId: `${document.snapshotId ?? "unavailable"}${runtime ? runtime.liveCallsEnabled ? ":live" : ":paused" : ""}`, checkedAt: now.toISOString(), validUntil: new Date(Math.floor(now.getTime() / 60_000) * 60_000 + 60_000).toISOString(), canEdit, lines };
}
