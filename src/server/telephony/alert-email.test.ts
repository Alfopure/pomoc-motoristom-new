import { describe, expect, it } from "vitest";
import type { TelephonyAlert } from "./alerts";
import { emptyAlertEvidence, type AlertCallEvidence } from "./alert-evidence";
import { alertLocalTime, renderTelephonyAlertEmail } from "./alert-email";
import { redactAlertDiagnostic } from "./alert-redaction";

const NOW = "2026-10-04T11:00:00.000Z";
const report = { status: "fail" as const, checkedAt: NOW, organizationId: "org", checks: [] };
function alert(check: string, detail: Record<string, unknown> = {}, status: "fail" | "warn" = "fail"): TelephonyAlert {
  return { key: `today:${check}:${status}`, check, status, detail };
}
function call(overrides: Partial<AlertCallEvidence> = {}): AlertCallEvidence {
  return { sessionId: "call-1", checks: ["webhooks"], state: "talking", direction: "inbound", caller: "•••3456", called: "•••8700",
    startedAt: NOW, answeredAt: NOW, endedAt: null, confirmedAt: null, confirmationSource: null, pendingConnection: false, legs: [], ...overrides };
}
function render(alerts: TelephonyAlert[], calls: AlertCallEvidence[] = []) {
  return renderTelephonyAlertEmail({ alerts, report, environment: "test", evidence: { ...emptyAlertEvidence(), calls } });
}

describe("Slovak telephony alert explanations", () => {
  it.each(["configuration", "sessions", "webhooks", "ledger", "connections", "incidents", "usage", "devices", "provider", "future_check"])("explains %s without claiming every call failed", (check) => {
    const message = render([alert(check)]);
    expect(message.text).toContain("Čo sa stalo:");
    expect(message.text).toContain("Prebehol hovor?");
    expect(message.text).toContain("Čo urobiť:");
    expect(message.html).toContain("Technická správa pre kontrolu");
    expect(message.subject).toContain("TEST");
    expect(message.subject).not.toContain("Hovor bol spojený");
  });

  it("states confirmed operator departure without asserting a network cause or audible outage", () => {
    const message = render([alert("interruptions", { entries: [{ sessionId: "call-1", interruptedAt: NOW, classifiedAt: NOW }] })], [call({ confirmedAt: NOW, checks: ["interruptions"] })]);
    expect(message.subject).toContain("Zaznamenané prerušenie účasti operátora");
    expect(message.text).toContain("Predtým spojená vetva operátora skončila a zákazník zostal na linke");
    expect(message.text).toContain("Príčina prerušenia ani kvalita zvuku nie sú");
    expect(message.text).toContain("Dôkazy znovu posúdené:");
    expect(message.subject).not.toContain("Hovor bol spojený;");
  });

  it("puts verified bridge evidence first and explains cancelled parallel ringing", () => {
    const message = render([alert("ledger", { failed24h: 1 })], [call({ checks: ["ledger"], confirmedAt: NOW, confirmationSource: "bridge_events", legs: [
      { id: "loser", role: "external", state: "ended", answeredAt: null, bridgedAt: null, endedAt: NOW, hangupCause: "originator_cancel" },
    ] })]);
    expect(message.subject).toContain("Hovor bol spojený");
    expect(message.subject).toContain("chyba potrebuje kontrolu");
    expect(message.text).toContain("call.hangup");
    expect(message.text).toContain("bežné zrušenie ostatných telefónov");
    expect(message.text).toContain("Kvalitu ani obojstrannú počuteľnosť");
    expect(message.text).toContain("13:00:00");
    expect(message.text).toContain('"schemaVersion": 1');
  });

  it("does not turn answered IVR, state talking or provider alive into a confirmed conversation", () => {
    const message = render([alert("provider", { entries: [{ sessionId: "call-1", verdict: "alive", checkedAt: NOW, role: "customer" }] })], [call()]);
    expect(message.subject).toContain("Spojenie hovoru nevieme potvrdiť");
    expect(message.text).toContain("iba automatickú hlášku alebo telefónne menu");
    expect(message.text).toContain("aktívnu časť: volajúci");
    expect(message.text).not.toContain("Spojenie účastníkov bolo potvrdené");
  });

  it("distinguishes ended-without-proof from a proven lost call", () => {
    const message = render([alert("connections", { entries: [{ sessionId: "call-1", outcome: "ended_without_confirmation" }] })], [call({ endedAt: NOW, state: "ended" })]);
    expect(message.text).toContain("Hovor je ukončený");
    expect(message.text).toContain("chýbajúci záznam nie je dôkaz, že sa nikdy nespojil");
  });

  it("states caller cancellation separately from the earlier database timeout", () => {
    const cancelled = call({ state: "ended", endedAt: NOW, answeredAt: null, checks: ["ledger"], legs: [
      { id: "customer", role: "customer", state: "ended", endedAt: NOW, answeredAt: NOW, bridgedAt: null,
        hangupCause: "normal_clearing", hangupSource: "caller" },
    ] });
    const message = renderTelephonyAlertEmail({ alerts: [alert("ledger", { failedIds: ["timeout"] })], report, environment: "production",
      evidence: { ...emptyAlertEvidence(), calls: [cancelled], events: [{ eventId: "timeout", type: "call.answered", receivedAt: NOW,
        sessionIds: [cancelled.sessionId], failureKind: "database_timeout" }] } });
    expect(message.subject).toContain("Volajúci zavesil; technická chyba potrebuje kontrolu");
    for (const output of [message.text, message.html]) {
      expect(output).toContain("Dôvod zavesenia zo záznamov nevieme určiť");
      expect(output).toContain("vypršal časový limit databázového kroku");
      expect(output).not.toContain("Hovor bol spojený;");
    }
  });

  it.each([null, "callee"])("does not attribute normal clearing to the caller with source %s", hangupSource => {
    const message = render([alert("ledger")], [call({ state: "ended", endedAt: NOW, answeredAt: null, checks: ["ledger"], legs: [
      { id: "customer", role: "customer", state: "ended", endedAt: NOW, answeredAt: NOW, bridgedAt: null,
        hangupCause: "normal_clearing", hangupSource },
    ] })]);
    expect(message.subject).toContain("Spojenie hovoru nevieme potvrdiť");
    expect(message.text).not.toContain("Volajúci ukončil hovor pred");
  });

  it("does not let historical connection confirmation hide a later failed transfer", () => {
    const message = render([alert("connections", { entries: [{ sessionId: "call-1", outcome: "pending" }] })], [call({ confirmedAt: NOW, confirmationSource: "conference_membership" })]);
    expect(message.subject).toContain("Ďalší priebeh hovoru nie je potvrdený");
    expect(message.text).toContain("výsledok ďalšieho spojenia alebo prepojenia nie je potvrdený");
  });

  it("treats ordinary bridge progress warnings as unconfirmed even with historical bridge evidence", () => {
    const message = render([alert("webhooks", { entries: [{ sessionId: "call-1", reason: "connection_unconfirmed" }] })], [call({ confirmedAt: NOW, confirmationSource: "bridge_events" })]);
    expect(message.subject).not.toContain("Hovor bol spojený;");
    expect(message.subject).toContain("Ďalší priebeh hovoru nie je potvrdený");
    expect(message.text).toContain("výsledok ďalšieho spojenia alebo prepojenia nie je potvrdený");
  });

  it.each(["user_busy", "no_answer", "timeout", "call_rejected", "unallocated_number", "normal_clearing"])("explains %s only for its affected leg", (hangupCause) => {
    const message = render([alert("ledger")], [call({ legs: [{ id: "operator", role: "external", state: "ended", endedAt: NOW, answeredAt: null, bridgedAt: null, hangupCause }] })]);
    expect(message.text).toContain("Ide o výsledok tejto časti, nie automaticky celého hovoru");
    expect(message.text).toContain("Prijatie operátorom ani záložným číslom nie je v dostupných záznamoch evidované");
  });

  it("keeps mixed call outcomes separate", () => {
    const message = render([alert("webhooks")], [call({ confirmedAt: NOW, confirmationSource: "bridge_events" }), call({ sessionId: "call-2", state: "ringing" })]);
    expect(message.subject).toContain("posúdiť jednotlivo");
    expect(message.text).toContain("1 z 2");
    expect(message.text).toContain("ID hovoru: call-1");
    expect(message.text).toContain("ID hovoru: call-2");
  });

  it.each(["unavailable", "unknown", "ended"])("explains provider %s per leg without claiming whole call ended", (verdict) => {
    const message = render([alert("provider", { entries: [{ sessionId: "call-1", role: "external", verdict, checkedAt: NOW, reconciled: false }] }, "warn")], [call()]);
    expect(message.text).toContain("externé alebo záložné číslo");
    expect(message.text).not.toContain("Hovor je ukončený.");
    if (verdict === "ended") expect(message.text).toContain("Zosúladenie jej stavu v aplikácii nie je potvrdené");
    else expect(message.text).toContain("Neznamená to, že hovor skončil");
  });

  it("explains command recovery separately from bridge confirmation", () => {
    const message = render([alert("connections", { entries: [{ sessionId: "call-1", outcome: "command_recovered" }, { sessionId: "call-2", outcome: "confirmed_after_failure" }, { sessionId: "call-3", outcome: "unknown" }] })]);
    expect(message.text).toContain("príkaz sa podarilo zopakovať");
    expect(message.text).toContain("spojenie po chybe následne potvrdené");
    expect(message.text).toContain("výsledok nevieme určiť");
  });

  it.each(["warn", "fail"] as const)("treats a %s usage limit as operational notification", (status) => {
    const message = render([alert("usage", { legs: 80, dailyLegSoftCap: 100 }, status)]);
    expect(message.text).toContain("Jeden hovor môže vyzváňať na viacerých telefónoch");
    expect(message.text).toContain("Nehovorí, že konkrétny hovor zlyhal");
    expect(message.text).toContain(status === "fail" ? "nové pokusy o spojenie môžu byť blokované" : "preventívne upozornenie");
  });

  it("does not claim a limit was reached when usage data could not be read", () => {
    const message = render([alert("usage", { error: "database timeout", legs: 0 }, "fail")]);
    expect(message.subject).toContain("Telefónia potrebuje kontrolu");
    expect(message.text).toContain("nepodarilo úplne načítať");
    expect(message.text).not.toContain("Limit bol dosiahnutý");
  });

  it.each(["errors", "truncated", "missingSessionIds"] as const)("never gives blanket reassurance with incomplete %s", (field) => {
    const evidence = { ...emptyAlertEvidence(), calls: [call({ confirmedAt: NOW, confirmationSource: "bridge_events" })], [field]: field === "truncated" ? true : ["missing"] };
    const message = renderTelephonyAlertEmail({ alerts: [alert("webhooks")], report, evidence, environment: "production" });
    expect(message.subject).toContain("PRODUKCIA");
    expect(message.subject).not.toContain("Hovor bol spojený;");
    expect(message.subject).toContain("Overenie hovoru je neúplné");
    expect(message.text).toContain("Časť údajov chýba");
  });

  it("escapes malicious content in HTML and excludes secrets from technical JSON", () => {
    const detail = { note: '<img src=x onerror="alert(1)"> https://user:password@host.test/path?token=signed SIP:alice:secret@telnyx.test',
      token: "token-secret", SUPABASE_SERVICE_ROLE_KEY: "service-secret", headers: { Authorization: "Bearer header-secret" }, payload: { raw: "payload-secret" },
      nested: { API_KEY: "nested-secret", error: 'failed {"api_key":"json-secret"} Authorization: Basic dXNlcjpzZWNyZXQ= TELNYX_API_KEY=env-secret' } };
    const message = render([alert("future_check", detail)]);
    expect(message.html).not.toContain("<img");
    expect(message.html).toContain("&lt;img");
    for (const secret of ["password@", "token=signed", "alice:secret", "token-secret", "service-secret", "header-secret", "payload-secret", "nested-secret", "json-secret", "dXNlcjpzZWNyZXQ=", "env-secret"]) {
      expect(message.text).not.toContain(secret);
      expect(message.html).not.toContain(secret);
    }
  });

  it("bounds unknown diagnostics and localizes summer/winter dates", () => {
    const safe = JSON.stringify(redactAlertDiagnostic({ items: Array.from({ length: 100 }, () => "x".repeat(10_000)) }));
    expect(safe.length).toBeLessThan(25_000);
    expect(alertLocalTime("2026-01-04T11:00:00Z")).toContain("12:00:00");
    expect(alertLocalTime(NOW)).toContain("13:00:00");
    expect(alertLocalTime("invalid")).toBe("čas nie je dostupný");
  });

  it("omits arbitrary error bodies including escaped JSON, bare credentials and multiline secrets", () => {
    const result = JSON.stringify(redactAlertDiagnostic({
      error: 'database failed {\\"api_key\\":\\"escaped-secret\\"} KEY0123456789bareproviderkey',
      errors: ['password="first line\nsecond-secret-line"'], stack: "raw-stack-secret", message: "raw-message-secret",
      sessionId: "keep-session-id", eventId: "keep-event-id", reason: "provider_unavailable", checkedAt: NOW,
    }));
    for (const secret of ["escaped-secret", "KEY012345", "second-secret-line", "raw-stack-secret", "raw-message-secret"]) expect(result).not.toContain(secret);
    expect(result).toContain("database_read_failed");
    expect(result).toContain("keep-session-id");
    expect(result).toContain("keep-event-id");
  });
});
