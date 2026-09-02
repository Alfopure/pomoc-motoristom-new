const SECRET_PATTERNS = [
  /(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi,
  /((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)[^\s,;]+/gi,
  /https?:\/\/[^\s]*[?&](?:token|key|signature)=[^&\s]+/gi,
] as const;

export function safeErrorMessage(error: unknown) {
  let value = error instanceof Error ? error.message : String(error);
  for (const pattern of SECRET_PATTERNS) {
    value = value.replace(pattern, "$1[REDACTED]");
  }
  return value.replace(/\b\+?\d[\d\s()-]{7,}\d\b/g, "[PHONE]").slice(0, 1000);
}
