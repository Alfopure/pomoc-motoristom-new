const BASIC = new Set("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà");
const EXTENDED = new Set("\f^{}\\[~]|€");

export function smsSegments(text: string) {
  const characters = [...text];
  const gsm = characters.every((char) => BASIC.has(char) || EXTENDED.has(char));
  const widths = characters.map((char) => gsm ? EXTENDED.has(char) ? 2 : 1 : char.length);
  const units = widths.reduce((sum, width) => sum + width, 0);
  const single = gsm ? 160 : 70;
  const multipart = gsm ? 153 : 67;
  let segments = units ? 1 : 0;
  if (units > single) {
    // Escape sequences and surrogate pairs cannot straddle a segment boundary.
    let used = 0;
    for (const width of widths) {
      if (used + width > multipart) { segments++; used = 0; }
      used += width;
    }
  }
  return { encoding: gsm ? "GSM-7" as const : "UTF-16" as const, units, segments };
}

export function stripSmsDiacritics(text: string) {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
