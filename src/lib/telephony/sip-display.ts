/**
 * Text a SIP `From` display name carries intact: ASCII letters, digits, spaces
 * and a few marks. Slovak diacritics are folded ("Kováč" → "Kovac") instead of
 * dropped, which would leave "Kov". Undefined when nothing useful remains.
 */
export function sipDisplayText(value: string | null | undefined): string | undefined {
  const ascii = (value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");
  const safe = ascii.replace(/[^A-Za-z0-9 \-_~!.+]/g, "").replace(/\s+/g, " ").trim().slice(0, 128);
  return safe.length >= 2 ? safe : undefined;
}
