import "server-only";

const RESEND_API_URL = "https://api.resend.com/emails";

export type EmailDeliveryResult =
  | { status: "sent"; provider: "resend"; messageId: string | null; error: null }
  | { status: "failed"; provider: "resend"; messageId?: null; error: string }
  | { status: "disabled"; provider: "resend" | "disabled"; messageId?: null; error: string | null };

type EmailMessage = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
  replyTo?: string;
};

type EmailConfig =
  | { enabled: true; provider: "resend"; apiKey: string; from: string; replyTo?: string; appName: string }
  | { enabled: false; provider: "resend" | "disabled"; error: string | null; from?: string; replyTo?: string; appName: string };

export function getEmailConfig(): EmailConfig {
  const provider = cleanString(process.env.EMAIL_PROVIDER).toLowerCase() || "disabled";
  const appName = cleanString(process.env.EMAIL_APP_NAME) || "Pomoc Motoristom";
  const from = formatFromAddress(process.env.EMAIL_FROM, appName);
  const replyTo = cleanString(process.env.EMAIL_REPLY_TO) || undefined;

  if (provider === "disabled") {
    return { enabled: false, provider: "disabled", error: null, from, replyTo, appName };
  }

  if (provider !== "resend") {
    return { enabled: false, provider: "resend", error: `Unsupported EMAIL_PROVIDER: ${provider}`, from, replyTo, appName };
  }

  const apiKey = cleanString(process.env.RESEND_API_KEY);
  const missing = [];

  if (!apiKey) {
    missing.push("RESEND_API_KEY");
  }

  if (!from) {
    missing.push("EMAIL_FROM");
  }

  if (missing.length > 0) {
    return { enabled: false, provider: "resend", error: `Missing email env: ${missing.join(", ")}`, from, replyTo, appName };
  }

  return { enabled: true, provider: "resend", apiKey, from, replyTo, appName };
}

export async function sendEmail(message: EmailMessage): Promise<EmailDeliveryResult> {
  const config = getEmailConfig();

  if (!config.enabled) {
    return { status: "disabled", provider: config.provider, error: config.error };
  }

  const to = parseEmailList(message.to);

  if (to.length === 0) {
    return { status: "failed", provider: "resend", error: "No recipient email configured" };
  }

  const payload = removeUndefinedFields({
    from: config.from,
    to,
    subject: sanitizeSubject(message.subject),
    html: message.html,
    text: message.text,
    replyTo: cleanString(message.replyTo) || config.replyTo || undefined,
  });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "User-Agent": `${toHeaderToken(config.appName, "PomocMotoristom")}-mailer/1.0`,
    };
    const idempotencyKey = cleanString(message.idempotencyKey);

    if (idempotencyKey) {
      headers["Idempotency-Key"] = idempotencyKey;
    }

    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const raw = await response.text().catch(() => "");
    const data = parseJsonObject(raw);

    if (!response.ok) {
      return {
        status: "failed",
        provider: "resend",
        error: getResendError(data) ?? `Resend request failed (${response.status})`,
      };
    }

    return {
      status: "sent",
      provider: "resend",
      messageId: typeof data?.id === "string" ? data.id : null,
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "resend",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function buildAppUrl(path = "/", fallbackOrigin?: string) {
  const baseUrl = cleanUrl(process.env.APP_BASE_URL) || cleanUrl(fallbackOrigin) || "http://localhost:3000";
  return new URL(path, `${baseUrl}/`).toString();
}

export function requestOrigin(request: Request | undefined) {
  if (!request) {
    return undefined;
  }

  try {
    return new URL(request.url).origin;
  } catch {
    return undefined;
  }
}

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeSubject(value: unknown) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function parseEmailList(value: string | string[]) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\n,;]+/);
  return [...new Set(items.map((item) => cleanString(item)).filter(Boolean))];
}

function formatFromAddress(value: string | undefined, appName: string) {
  const from = cleanString(value);

  if (!from) {
    return "";
  }

  if (from.includes("<") && from.includes(">")) {
    return from;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) {
    return from;
  }

  const displayName = sanitizeSubject(appName).replace(/[<>"]/g, "").trim() || "Pomoc Motoristom";
  return `${displayName} <${from}>`;
}

function toHeaderToken(value: string, fallback: string) {
  const token = sanitizeSubject(value)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return token || fallback;
}

function cleanUrl(value: string | undefined) {
  const raw = cleanString(value);

  if (!raw) {
    return "";
  }

  try {
    const url = new URL(raw);
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function removeUndefinedFields(object: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0)));
}

function parseJsonObject(raw: string) {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function getResendError(data: Record<string, unknown> | null) {
  for (const key of ["message", "error", "name"]) {
    const value = data?.[key];

    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return null;
}
