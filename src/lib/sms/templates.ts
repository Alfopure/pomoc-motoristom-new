export type SmsTemplateKey = "location_request" | "eta_update";

export type SmsTemplateContext = {
  caseNumber: string;
  etaMinutes?: number;
  link?: string;
  brandName?: string;
};

const LOCATION_LINK_PLACEHOLDER = "{bezpecny-link}";

export function renderSmsTemplate(template: SmsTemplateKey, context: SmsTemplateContext) {
  if (template === "location_request") {
    return renderLocationRequestSms(context);
  }

  if (template === "eta_update") {
    return renderEtaUpdateSms(context);
  }

  throw new Error(`Unsupported SMS template: ${template}`);
}

export function renderLocationRequestSms(context: SmsTemplateContext) {
  const brandName = cleanText(context.brandName) || "Pomoc motoristom";
  const casePart = cleanText(context.caseNumber) ? ` k pripadu ${cleanText(context.caseNumber)}` : "";
  const link = cleanLink(context.link);

  return `${brandName}: Dobry den, prosim poslite nam presnu polohu vozidla${casePart}. Otvorte link ${link} a povolte zdielanie polohy. Na tuto SMS neodpovedajte.`;
}

export function renderEtaUpdateSms(context: SmsTemplateContext) {
  const brandName = cleanText(context.brandName) || "Pomoc motoristom";
  const casePart = cleanText(context.caseNumber) ? ` k pripadu ${cleanText(context.caseNumber)}` : "";
  const eta = cleanEtaMinutes(context.etaMinutes);

  return `${brandName}: Dobry den, technik je na ceste${casePart}. Predpokladany prichod je priblizne ${eta} min. Na tuto SMS neodpovedajte.`;
}

export function renderLocationRequestSmsPreview(caseNumber: string) {
  return renderLocationRequestSms({
    caseNumber,
    link: LOCATION_LINK_PLACEHOLDER,
  });
}

export function renderEtaUpdateSmsPreview(caseNumber: string, etaMinutes: number) {
  return renderEtaUpdateSms({
    caseNumber,
    etaMinutes,
  });
}

function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLink(value: unknown) {
  const link = cleanText(value);

  if (!link) {
    throw new Error("SMS location link is required.");
  }

  return link;
}

function cleanEtaMinutes(value: unknown) {
  const eta = Math.round(Number(value));

  if (!Number.isFinite(eta) || eta <= 0) {
    throw new Error("SMS ETA minutes are required.");
  }

  return eta;
}
