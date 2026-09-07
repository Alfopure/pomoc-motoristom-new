import { stripSmsDiacritics } from "./segments";

export const SMS_TEMPLATE_VERSION = 1;
export const SMS_TEMPLATES = [
  { key: "location_request", label: "Vyžiadať polohu" },
  { key: "case_received", label: "Prijatie prípadu" },
  { key: "eta_update", label: "Technik na ceste" },
  { key: "delay", label: "Zdržanie" },
  { key: "callback", label: "Spätný telefonát" },
  { key: "tow_destination", label: "Cieľ odťahu" },
] as const;
export type SmsTemplateKey = typeof SMS_TEMPLATES[number]["key"];
export type SmsTemplateContext = {
  caseNumber: string;
  etaMinutes?: number;
  link?: string;
  brandName?: string;
  callbackNumber?: string;
  towAddress?: string;
  repliesEnabled?: boolean;
};

export function isSmsTemplateKey(value: unknown): value is SmsTemplateKey {
  return SMS_TEMPLATES.some((template) => template.key === value);
}

export function renderSmsTemplate(template: SmsTemplateKey, context: SmsTemplateContext) {
  const brand = clean(context.brandName) || "Pomoc motoristom";
  const caseNumber = required(context.caseNumber, "číslo prípadu");
  const contact = required(context.callbackNumber, "kontaktný telefón");
  const prefix = `${brand}, pripad ${caseNumber}:`;
  let body: string;
  switch (template) {
    case "location_request":
      body = `${prefix} Poslite polohu vozidla: ${required(context.link, "lokalizačný link")}. Otvorte link a povolte polohu.`;
      break;
    case "case_received":
      body = `${brand}: Pripad ${caseNumber} sme prijali. Dispecer pripravuje pomoc.`;
      break;
    case "eta_update":
      body = `${prefix} Technik je na ceste. Odhad prichodu: ${eta(context.etaMinutes)} min.`;
      break;
    case "delay":
      body = `${prefix} Odhad prichodu sa meni na ${eta(context.etaMinutes)} min. Ospravedlnujeme sa za zdrzanie.`;
      break;
    case "callback":
      body = `${brand}: Nepodarilo sa nam vas zastihnut. Prosim, zavolajte nam.`;
      break;
    case "tow_destination":
      body = `${prefix} Dohodnuty ciel odtahu je ${required(context.towAddress, "adresa cieľa odťahu")}. Pri zmene nam zavolajte.`;
      break;
    default: throw new Error("Nepodporovaná SMS šablóna.");
  }
  return `${body} ${context.repliesEnabled ? "Na SMS mozete odpovedat." : "Na SMS neodpovedajte."} Kontakt: ${contact}.`;
}

// The edited message must keep the verified facts and the server-generated link.
export function validateTemplateMessage(template: SmsTemplateKey, context: SmsTemplateContext, message: string) {
  renderSmsTemplate(template, context);
  const facts = [context.callbackNumber, ...(template === "callback" ? [] : [context.caseNumber])];
  if (template === "location_request") facts.push(context.link);
  if (template === "eta_update" || template === "delay") facts.push(`${eta(context.etaMinutes)} min`);
  if (template === "tow_destination") facts.push(context.towAddress);
  for (const fact of facts) {
    if (fact && !message.includes(fact) && !message.includes(stripSmsDiacritics(fact))) throw new Error("Text musí obsahovať overené údaje šablóny. Upravte údaje a pripravte nový náhľad.");
  }
  const notice = context.repliesEnabled ? "Na SMS mozete odpovedat." : "Na SMS neodpovedajte.";
  if (!message.includes(notice)) throw new Error("Ponechajte pravdivú informáciu o možnosti odpovedať na SMS.");
}

export function renderLocationRequestSms(context: SmsTemplateContext) { return renderSmsTemplate("location_request", context); }
export function renderEtaUpdateSms(context: SmsTemplateContext) { return renderSmsTemplate("eta_update", context); }
// Legacy route-card previews have no authority to send. The editor resolves the contact.
export function renderLocationRequestSmsPreview(caseNumber: string) {
  return renderLocationRequestSms({ caseNumber, link: "{bezpecny-link}", callbackNumber: "{kontaktny-telefon}" });
}
export function renderEtaUpdateSmsPreview(caseNumber: string, etaMinutes: number) {
  return renderEtaUpdateSms({ caseNumber, etaMinutes: Math.round(etaMinutes), callbackNumber: "{kontaktny-telefon}" });
}
function clean(value: unknown) { return String(value ?? "").replace(/\s+/g, " ").trim(); }
function required(value: unknown, label: string) {
  const text = clean(value);
  if (!text) throw new Error(`Doplňte ${label}.`);
  return text;
}
function eta(value: unknown) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("Zadajte aktuálny odhad príchodu: 1 až 1440 minút.");
  return minutes;
}
