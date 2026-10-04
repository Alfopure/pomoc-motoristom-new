import type { AppEnvironment } from "@/lib/app-environment";
import { escapeHtml } from "@/server/email-delivery";
import type { TelephonyAlert } from "./alerts";
import { alertObject, emptyAlertEvidence, type AlertCallEvidence, type TelephonyAlertEvidence } from "./alert-evidence";
import { redactAlertDiagnostic } from "./alert-redaction";
import type { TelephonyHealthReport } from "./health";

export type TelephonyAlertEmailInput = {
  alerts: TelephonyAlert[];
  report: TelephonyHealthReport;
  evidence?: TelephonyAlertEvidence;
  environment: AppEnvironment | "unknown";
};

type Explanation = { title: string; happened: string; outcome: string; action: string };
const UNKNOWN_OUTCOME = "Z tejto kontroly sa nedá potvrdiť, či konkrétny hovor prebehol. Samotné upozornenie nedokazuje stratený hovor.";
const CALL_CHECKS = new Set(["sessions", "webhooks", "connections", "provider", "ledger"]);
const NUMBER = new Intl.NumberFormat("sk-SK");
const DATE = new Intl.DateTimeFormat("sk-SK", { timeZone: "Europe/Bratislava", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

export function alertLocalTime(value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? DATE.format(new Date(value)) : "čas nie je dostupný";
}

function count(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? NUMBER.format(value) : "nezistené";
}

function entries(alert: TelephonyAlert): Record<string, unknown>[] {
  return Array.isArray(alert.detail.entries) ? alert.detail.entries.map(alertObject) : [];
}

function explain(alert: TelephonyAlert): Explanation {
  const d = alert.detail;
  const problems: Record<string, Explanation> = {
    configuration: {
      title: "Nastavenie telefónie",
      happened: d.configured === false ? "Chýba nastavenie potrebné na komunikáciu s Telnyxom."
        : d.liveCallsEnabled === false ? "Živé volania sú v nastavení vypnuté." : "Kontrola nastavenia telefónie našla problém.",
      outcome: "Ide o nastavenie služby, nie o potvrdený výsledok konkrétneho hovoru. Nové hovory môžu byť obmedzené.",
      action: "Skontrolujte nastavenie telefónie a pošlite technickú správu správcovi. V prostredí TEST môže byť vypnutie zámerné.",
    },
    sessions: {
      title: "Hovor čaká na ďalší krok",
      happened: "Niektorá fáza hovoru prekročila svoj časový limit. Môže ísť o vyzváňanie, hlášku, telefónne menu alebo čakanie na operátora. Dlhý rozhovor sám osebe nie je chyba.",
      outcome: "Výsledok závisí od konkrétneho hovoru; dôkazy sú uvedené nižšie. Prekročenie limitu samo nepotvrdzuje prerušený rozhovor.",
      action: "Vyhľadajte hovor podľa času v histórii a overte u operátora, čo sa stalo. Ak zostal visieť alebo sa problém opakuje, pošlite technickú správu na kontrolu.",
    },
    webhooks: {
      title: "Chýba očakávaná udalosť hovoru",
      happened: "Aplikácia nedostala očakávané potvrdenie pre konkrétny krok hovoru včas. Ticho počas už spojeného rozhovoru je normálne.",
      outcome: "Chýbajúca udalosť neznamená automaticky neúspešný hovor. Rozhodujú potvrdenia spojenia pri jednotlivých hovoroch nižšie.",
      action: "Skontrolujte dotknutý hovor v histórii a u operátora. Ak výsledok nesedí alebo výstraha pretrváva, priložte technickú správu.",
    },
    ledger: {
      title: "Udalosť sa nepodarilo spracovať",
      happened: `Počet neúspešne spracovaných udalostí za posledných 24 hodín: ${d.truncated ? "najmenej " : ""}${count(d.failed24h)}. Môže ísť o doručenie alebo následný krok v aplikácii.`,
      outcome: "Chyba spracovania udalosti sama nedokazuje, že hovor zlyhal. Aj „call.hangup“ môže znamenať iba ukončenie jednej vetvy súbežného vyzváňania, nie celého rozhovoru.",
      action: "Porovnajte výsledok dotknutého hovoru nižšie s históriou. Technickú správu pošlite na kontrolu spracovania udalosti.",
    },
    connections: {
      title: "Spojenie alebo prepojenie hovoru",
      happened: "Pri spájaní účastníkov vznikla chyba alebo chýba potvrdenie jej opravy.",
      outcome: "Úspešné prijatie hovoru alebo opakovanie príkazu ešte nepotvrdzuje spojenie oboch účastníkov. Staršie spojenie tiež nepotvrdzuje úspech neskoršieho prepojenia.",
      action: "Overte u operátora, či sa s volajúcim počuli a či prepojenie fungovalo. Ak nie, skontrolujte potrebu spätného volania a pošlite technickú správu.",
    },
    incidents: {
      title: "Systém eviduje technickú chybu",
      happened: `Počet otvorených technických problémov: ${count(d.open)}. Automatická úloha, napríklad kontrola alebo obnova stavu, zaznamenala chybu. Otvorený záznam môže pochádzať aj zo skoršej kontroly; sám nedokazuje nový výpadok.`,
      outcome: "Toto hlásenie opisuje technickú úlohu. Bez dôkazu ku konkrétnemu hovoru nemožno tvrdiť, že volajúci nebol obslúžený.",
      action: "Pošlite oddelenú technickú správu na kontrolu. Ak operátori súčasne hlásia problémy s hovormi, uveďte čas a príznak.",
    },
    usage: {
      title: "Denný limit telefónie",
      happened: `Dnes vzniklo ${count(d.legs)} pokusov o spojenie z denného limitu ${count(d.dailyLegSoftCap)}. Jeden hovor môže vyzváňať na viacerých telefónoch a spotrebovať viac pokusov. ${alert.status === "fail" ? "Limit bol dosiahnutý; nové pokusy o spojenie môžu byť blokované." : "Blížime sa k limitu; ide o preventívne upozornenie."}`,
      outcome: "Toto nie je dôkaz neúspešného ani prerušeného hovoru. Z využitia limitu sa výsledok jednotlivých hovorov nedá určiť.",
      action: "Skontrolujte dnešnú prevádzku a nastavený limit. Pri nezvyčajnom náraste pošlite technickú správu na preverenie.",
    },
    devices: {
      title: "Dostupnosť telefónov operátorov",
      happened: `Dostupné prehliadačové telefóny: ${count(d.live)} z ${count(d.total)}. Nula dostupných telefónov môže byť mimo služby normálna; výsledok závisí aj od záložného smerovania.`,
      outcome: "Dostupnosť telefónov sama nepotvrdzuje zlyhanie konkrétneho hovoru.",
      action: "Ak majú byť operátori v službe, overte prihlásenie a dostupnosť ich telefónov a nastavené záložné smerovanie.",
    },
    provider: {
      title: "Overenie stavu u Telnyxu",
      happened: "Pravidelná kontrola nedokázala úplne potvrdiť súlad medzi Telnyxom a aplikáciou.",
      outcome: "Výsledky overenia jednotlivých častí hovoru sú uvedené nižšie. Aktívna časť hovoru nepotvrdzuje rozhovor; ukončená záložná vetva neznamená ukončenie celého hovoru.",
      action: "Skontrolujte zobrazený hovor a informáciu od operátora. Automatická kontrola sa zopakuje; pri pretrvávaní problému pošlite technickú správu.",
    },
  };
  const result = problems[alert.check] ?? {
    title: "Nový typ technického upozornenia",
    happened: "Monitoring oznámil stav, pre ktorý zatiaľ nemáme osobitný slovný popis.",
    outcome: UNKNOWN_OUTCOME,
    action: "Pošlite technickú správu na posúdenie. Bez ďalších dôkazov nepredpokladajte, že hovor prebehol alebo zlyhal.",
  };
  if (d.error) return { ...result, happened: "Údaje pre túto kontrolu sa nepodarilo úplne načítať alebo overiť.", outcome: UNKNOWN_OUTCOME };
  if (alert.check === "connections") {
    const outcomes = entries(alert).map((entry) => entry.outcome);
    const descriptions = [
      outcomes.includes("pending") ? "Najmenej jedno spojenie alebo prepojenie stále čaká na potvrdenie." : "",
      outcomes.includes("ended_without_confirmation") ? "Niektorý hovor už skončil bez potvrdenia opravy; to nedokazuje, že nikdy nebol spojený." : "",
      outcomes.includes("confirmed_after_failure") ? "Pri časti záznamov bolo spojenie po chybe následne potvrdené." : "",
      outcomes.includes("command_recovered") ? "Niektorý príkaz sa podarilo zopakovať, ale úspešný príkaz sám nedokazuje počuteľný rozhovor." : "",
      outcomes.includes("unknown") ? "Pri niektorých záznamoch výsledok nevieme určiť." : "",
    ].filter(Boolean);
    if (descriptions.length) return { ...result, happened: descriptions.join(" ") };
  }
  return result;
}

function hasUnresolvedConnection(call: AlertCallEvidence, alerts: TelephonyAlert[]): boolean {
  return call.pendingConnection || alerts.some((alert) => entries(alert)
    .some((entry) => entry.sessionId === call.sessionId && (entry.reason === "connection_unconfirmed" || alert.check === "connections" &&
      ["pending", "ended_without_confirmation", "unknown", "command_recovered"].includes(String(entry.outcome)))));
}

function callVerdict(call: AlertCallEvidence, alerts: TelephonyAlert[]): string {
  if (call.confirmedAt) return hasUnresolvedConnection(call, alerts)
    ? "Hovor bol spojený, ale výsledok ďalšieho spojenia alebo prepojenia nie je potvrdený."
    : "Spojenie účastníkov bolo potvrdené. Kvalitu ani obojstrannú počuteľnosť zvuku tieto záznamy nepotvrdzujú.";
  if (call.endedAt || ["ended", "failed"].includes(call.state)) return "Hovor je ukončený. Spojenie s operátorom nevieme potvrdiť; chýbajúci záznam nie je dôkaz, že sa nikdy nespojil.";
  return "Spojenie s operátorom zatiaľ nie je potvrdené. Samotné prijatie hovoru môže znamenať iba automatickú hlášku alebo telefónne menu.";
}

const REASONS: Record<string, string> = {
  greeting_overdue: "Úvodná hláška sa neukončila v očakávanom čase.",
  ringing_overdue: "Vyzváňanie prekročilo svoj časový limit.",
  gather_overdue: "Telefónne menu čaká príliš dlho na ukončenie výberu.",
  waiting_tick_overdue: "Pravidelné spracovanie čakajúceho hovoru mešká.",
  waiting_limit_exceeded: "Hovor prekročil povolený čas čakania.",
  progress_overdue: "Chýba očakávaný ďalší krok hovoru.",
  connection_unconfirmed: "Prijatie hovoru evidujeme, ale spojenie účastníkov ešte nebolo potvrdené.",
};
const ROLES: Record<string, string> = { customer: "volajúci", operator: "operátor", external: "externé alebo záložné číslo", consult: "konzultácia", supervisor: "supervízor" };
const HANGUP_REASONS: Record<string, string> = {
  user_busy: "telefón bol obsadený", busy: "telefón bol obsadený", no_answer: "prijatie nebolo potvrdené v časovom limite",
  timeout: "vypršal časový limit", call_rejected: "pokus o spojenie bol odmietnutý",
  unallocated_number: "cieľové číslo nebolo dostupné ako platné pridelené číslo",
  originator_cancel: "pokus o spojenie bol zrušený", normal_clearing: "táto časť hovoru bola ukončená bežným zavesením",
};

function callNotes(call: AlertCallEvidence, alerts: TelephonyAlert[]): string[] {
  const notes: string[] = [];
  for (const alert of alerts) for (const entry of entries(alert).filter((entry) => entry.sessionId === call.sessionId)) {
    if (typeof entry.reason === "string" && REASONS[entry.reason]) notes.push(REASONS[entry.reason]);
    if (alert.check !== "provider") continue;
    const part = ROLES[String(entry.role)] ?? "časť hovoru";
    const at = alertLocalTime(typeof entry.checkedAt === "string" ? entry.checkedAt : null);
    if (entry.verdict === "alive") notes.push(`Telnyx o ${at} potvrdil aktívnu časť: ${part}. To samo nepotvrdzuje spojenie účastníkov ani zvuk.`);
    if (entry.verdict === "ended") notes.push(`Telnyx o ${at} potvrdil ukončenú časť: ${part}. ${entry.reconciled === true ? "Jej stav bol zosúladený v aplikácii." : "Zosúladenie jej stavu v aplikácii nie je potvrdené."} Samotná táto informácia neznamená koniec celého hovoru.`);
    if (entry.verdict === "unavailable" || entry.verdict === "unknown") notes.push(`Stav časti „${part}“ sa u Telnyxu o ${at} nepodarilo spoľahlivo overiť. Neznamená to, že hovor skončil.`);
  }
  if (call.confirmedAt && call.legs.some((leg) => ["operator", "external"].includes(leg.role) && leg.endedAt && !leg.bridgedAt)) {
    notes.push("Jedna z vetiev vyzváňania skončila bez spojenia. Pri súbežnom vyzváňaní to môže byť bežné zrušenie ostatných telefónov po prijatí hovoru.");
  }
  for (const leg of call.legs) if (leg.hangupCause && HANGUP_REASONS[leg.hangupCause]) {
    notes.push(`Časť hovoru „${ROLES[leg.role] ?? "účastník"}“: ${HANGUP_REASONS[leg.hangupCause]}. Ide o výsledok tejto časti, nie automaticky celého hovoru.`);
  }
  const operatorLegs = call.legs.filter((leg) => ["operator", "external"].includes(leg.role));
  if (!call.confirmedAt && operatorLegs.length && operatorLegs.every((leg) => !leg.answeredAt && !leg.bridgedAt)) notes.push("Prijatie operátorom ani záložným číslom nie je v dostupných záznamoch evidované.");
  return [...new Set(notes)];
}

/** Pure renderer; callers can preview all cases without contacting Resend or Telnyx. */
export function renderTelephonyAlertEmail(input: TelephonyAlertEmailInput): { subject: string; text: string; html: string } {
  const evidence = input.evidence ?? emptyAlertEvidence();
  const env = ({ production: "PRODUKCIA", test: "TEST", development: "VÝVOJ", unknown: "PROSTREDIE NEOVERENÉ" })[input.environment];
  const uncovered = input.alerts.some((alert) => CALL_CHECKS.has(alert.check) && !evidence.calls.some((call) => call.checks.includes(alert.check)));
  const limited = uncovered || input.alerts.length > 30 || evidence.truncated || evidence.errors.length > 0 || evidence.missingSessionIds.length > 0 || input.alerts.some((alert) => alert.detail.truncated || alert.detail.error || Number(alert.detail.remaining) > 0);
  const confirmed = evidence.calls.filter((call) => call.confirmedAt).length;
  const unresolved = evidence.calls.some((call) => hasUnresolvedConnection(call, input.alerts));
  const allCallScoped = input.alerts.every((alert) => CALL_CHECKS.has(alert.check));
  const onlyUsage = input.alerts.length > 0 && input.alerts.every((alert) => alert.check === "usage" && !alert.detail.error);
  let headline = "Telefónia potrebuje kontrolu";
  let summary = UNKNOWN_OUTCOME;
  if (onlyUsage) {
    headline = input.alerts.some((alert) => alert.status === "fail") ? "Denný limit telefónie dosiahnutý" : "Upozornenie na denný limit";
    summary = "Ide o prevádzkové upozornenie na limit. Nehovorí, že konkrétny hovor zlyhal.";
  } else if (evidence.calls.length) {
    if (confirmed === evidence.calls.length && !limited && !unresolved && allCallScoped) {
      const attention = input.alerts.some((alert) => alert.status === "fail") ? "technická chyba potrebuje kontrolu" : "technické upozornenie";
      headline = evidence.calls.length === 1 ? `Hovor bol spojený; ${attention}` : `Spojenie uvedených hovorov potvrdené; ${attention}`;
      summary = "Máme potvrdenie spojenia účastníkov uvedených hovorov. Zvuk tým nie je overený; technický problém je opísaný nižšie.";
    } else if (confirmed) {
      if (evidence.calls.length === 1 && unresolved) {
        headline = "Ďalší priebeh hovoru nie je potvrdený";
        summary = "Hovor bol predtým spojený. Výsledok ďalšieho spojenia alebo prepojenia však nie je potvrdený; overte ho s operátorom podľa podrobností nižšie.";
      } else if (evidence.calls.length === 1) {
        headline = "Overenie hovoru je neúplné";
        summary = "Pri uvedenom hovore máme potvrdenie skoršieho spojenia. Dostupné údaje však nestačia na vyhodnotenie celého hláseného problému; podrobnosti sú nižšie.";
      } else {
        headline = "Výsledky hovorov treba posúdiť jednotlivo";
        summary = `Potvrdenie spojenia máme pri ${confirmed} z ${evidence.calls.length} zobrazených hovorov. Pri ďalšom kroku alebo ďalších hovoroch môže výsledok chýbať; pozrite každý záznam nižšie.`;
      }
    } else {
      headline = "Spojenie hovoru nevieme potvrdiť";
      summary = "Z dostupných dôkazov nevieme potvrdiť rozhovor s operátorom. Nie je to automaticky dôkaz, že sa hovor vôbec nespojil.";
    }
  } else if (input.alerts.some((alert) => alert.check === "provider")) {
    headline = "Stav hovoru sa nepodarilo úplne overiť";
  }
  if (limited) summary += " Časť údajov chýba alebo bol výpis skrátený; tento súhrn nepokrýva všetky hovory.";
  const subject = `[Dispečing · ${env}] ${headline}`;
  const time = `${alertLocalTime(input.report.checkedAt)} (Europe/Bratislava)`;
  const grouped = new Map<string, TelephonyAlert>();
  for (const alert of input.alerts) {
    const previous = grouped.get(alert.check);
    grouped.set(alert.check, previous ? { ...previous, detail: { ...previous.detail, entries: [...entries(previous), ...entries(alert)] } } : alert);
  }
  const explanation = [...grouped.values()].map(explain);
  const callBlocks = evidence.calls.map((call) => {
    const label = `Hovor ${alertLocalTime(call.startedAt)}${call.caller || call.called ? ` · ${call.caller ?? "neznáme číslo"} → ${call.called ?? "neznáme číslo"}` : ""}`;
    const timeline = [
      `Začiatok: ${alertLocalTime(call.startedAt)}.`,
      call.answeredAt ? `Prijatie evidované: ${alertLocalTime(call.answeredAt)} (samo osebe nepotvrdzuje rozhovor).` : "",
      call.confirmedAt ? `Spojenie účastníkov potvrdené: ${alertLocalTime(call.confirmedAt)} (${call.confirmationSource === "conference_membership" ? "overená účasť oboch strán v konferencii" : "potvrdenia spojenia oboch strán"}).` : "",
      call.endedAt ? `Koniec evidovaný: ${alertLocalTime(call.endedAt)}.` : ["ended", "failed"].includes(call.state) ? "Aplikácia eviduje koniec; presný čas chýba." : "Aplikácia zatiaľ neeviduje koniec. Jej stav môže meškať; aktuálny stav posudzujte podľa overenia u Telnyxu.",
    ].filter(Boolean);
    return { label, verdict: callVerdict(call, input.alerts), timeline, notes: callNotes(call, input.alerts), id: call.sessionId };
  });
  const technical = JSON.stringify(redactAlertDiagnostic({
    schemaVersion: 1, checkedAt: input.report.checkedAt, timezone: "Europe/Bratislava", environment: input.environment,
    organizationId: input.report.organizationId, health: input.report.status,
    alerts: input.alerts.map((alert) => ({ key: alert.key, check: alert.check, status: alert.status, diagnostics: alert.detail })), evidence,
  }), null, 2);
  const disclaimer = "Potvrdené spojenie znamená technické spojenie účastníkov. Záznamy neoverujú, či sa obaja počuli ani či bol rozhovor bez výpadkov. E-mail opisuje stav v čase kontroly; neskoršie udalosti ho môžu zmeniť.";
  const technicalHint = "Túto časť môžete skopírovať pri žiadosti o opravu. Obsahuje vybrané technické údaje bez surových webhookov; známe citlivé polia sú filtrované a čísla v prehľade hovorov skrátené. Identifikátory zostávajú pre dohľadanie.";
  const text = [subject, `Kontrola: ${time}`, "Prebehol hovor?", summary,
    ...explanation.map((part) => `${part.title}\nČo sa stalo: ${part.happened}\nPrebehol hovor? ${part.outcome}\nČo urobiť: ${part.action}`),
    ...(callBlocks.length ? callBlocks.map((call) => `${call.label}\n${call.verdict}\n${call.timeline.join("\n")}\n${call.notes.join("\n")}\nID hovoru: ${call.id}`) : ["K tomuto hláseniu nemáme priradený konkrétny hovor. Nevyberali sme náhodný posledný hovor ako dôkaz."]),
    disclaimer, "TECHNICKÁ SPRÁVA PRE KONTROLU", technicalHint, technical,
  ].join("\n\n");
  const paragraph = (label: string, content: string) => `<p style="margin:12px 0;line-height:1.55"><strong>${escapeHtml(label)}</strong><br>${escapeHtml(content)}</p>`;
  const html = `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f5f8;font-family:Arial,sans-serif;color:#172b3a"><main style="max-width:680px;margin:0 auto;padding:24px 16px"><p style="font-size:12px;letter-spacing:1px;font-weight:bold">DISPEČING · ${escapeHtml(env)}</p><section style="background:#fff;border-left:5px solid #c28720;border-radius:8px;padding:20px"><h1 style="font-size:24px;line-height:1.3;margin:0">${escapeHtml(headline)}</h1>${paragraph("Prebehol hovor?", summary)}<p style="font-size:13px;color:#4d5e6c">Kontrola: ${escapeHtml(time)}</p></section>${explanation.map((part) => `<section style="background:#fff;border-radius:8px;padding:20px;margin-top:16px"><h2 style="font-size:19px;margin:0">${escapeHtml(part.title)}</h2>${paragraph("Čo sa stalo", part.happened)}${paragraph("Prebehol hovor?", part.outcome)}${paragraph("Čo urobiť", part.action)}</section>`).join("")}${callBlocks.map((call) => `<section style="background:#fff;border-radius:8px;padding:20px;margin-top:16px"><h2 style="font-size:17px;margin:0">${escapeHtml(call.label)}</h2>${paragraph("Výsledok podľa dôkazov", call.verdict)}${call.timeline.map((line) => `<p style="line-height:1.5;margin:8px 0">${escapeHtml(line)}</p>`).join("")}${call.notes.map((note) => `<p style="line-height:1.5">${escapeHtml(note)}</p>`).join("")}<p style="font-size:12px;overflow-wrap:anywhere">ID hovoru: ${escapeHtml(call.id)}</p></section>`).join("")}${!callBlocks.length ? "<p>Ku kontrole sa nepodarilo priradiť dôkaz o výsledku konkrétneho hovoru.</p>" : ""}<p style="font-size:13px;line-height:1.6;color:#4d5e6c">${escapeHtml(disclaimer)}</p><section style="border-top:2px solid #cbd5df;margin-top:28px;padding-top:20px"><h2 style="font-size:17px">Technická správa pre kontrolu</h2><p style="font-size:13px;line-height:1.5">${escapeHtml(technicalHint)}</p><pre style="white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;background:#e7edf3;padding:16px;border-radius:6px;font-size:11px;line-height:1.5">${escapeHtml(technical)}</pre></section></main></body></html>`;
  return { subject, text, html };
}
