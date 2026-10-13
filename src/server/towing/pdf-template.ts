import type { TowingFields, TowingLine } from '@/domain/towing/types';

export interface TowingPdfSnapshot {
  number: string; version?: number; kind: 'work' | 'priced'; fields: TowingFields; lines?: TowingLine[];
  taxDate?: string; totalCents?: number; createdAt?: string; supplier?: Record<string, unknown>;
}
function escape(value: unknown) { return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!)); }
function money(cents: number | undefined) { return cents === undefined ? '' : `${Math.trunc(cents / 100)},${String(Math.abs(cents % 100)).padStart(2,'0')} €`; }
function textRow(label: string, value: unknown) { return value === undefined || value === '' ? '' : `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`; }
export function renderTowingPdf(snapshot: TowingPdfSnapshot, hash: string, regularFont = '', boldFont = '') {
  const f = snapshot.fields;
  const parties = [['Objednávateľ',f.requester],['Vlastník',f.owner],['Zákazník',f.customer],['Príjemca',f.recipient]].map(([label,party]) => {
    if (!party || typeof party === 'string') return ''; return `<section><h2>${escape(label)}</h2><table>${textRow('Meno / firma',party.name)}${textRow('Adresa',party.address)}${textRow('Telefón',party.phone)}${textRow('Email',party.email)}${textRow('IČO',party.companyId)}${textRow('DIČ',party.taxId)}</table></section>`;
  }).join('');
  const priced = snapshot.kind === 'priced';
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><style>
  @font-face{font-family:Document;src:url(data:font/ttf;base64,${regularFont})} @font-face{font-family:Document;src:url(data:font/ttf;base64,${boldFont});font-weight:700}
  @page{size:A4;margin:16mm 14mm 19mm}*{box-sizing:border-box}body{font-family:Document,Arial,sans-serif;font-size:11px;line-height:1.5;color:#18181b}h1{font-size:22px;margin:0 0 5px}h2{font-size:14px;margin:18px 0 6px}p,td{white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border-bottom:1px solid #ddd;padding:7px;text-align:left;vertical-align:top}th{width:27%;font-weight:700}thead{display:table-header-group}thead th{width:auto}tr{break-inside:avoid}section{break-inside:auto}.meta{color:#666;font-size:9px}.signatures{margin-top:30px;display:flex;gap:18px;break-inside:avoid}.signature{flex:1;border-top:1px solid #555;padding-top:7px;min-height:85px}.lines .description{width:38%}.total{text-align:right;font-size:15px;font-weight:700;margin-top:12px}.hash{font-size:8px;overflow-wrap:anywhere;margin-top:16px}
  </style></head><body><h1>${priced ? 'Nacenený zákazkový list' : 'Realizačný list'}</h1><p class="meta">Zákazka ${escape(snapshot.number)} · verzia ${escape(snapshot.version ?? '')} · ${escape(snapshot.createdAt ?? '')}</p>
  <section><h2>Predmet a priebeh práce</h2><table>${textRow('Výkon',f.serviceType)}${textRow('Predmet',f.subjectDescription)}${textRow('Typ predmetu',f.subjectType)}${textRow('EČV',f.plate)}${textRow('VIN',f.vin)}${textRow('Nakládka',f.pickup)}${textRow('Vykládka',f.destination)}${textRow('Kontakt',f.contact)}${textRow('Bez kontaktu — dôvod',f.noContactReason)}${textRow('Plánovaný termín',f.plannedAt)}${textRow('Začiatok',f.startedAt)}${textRow('Koniec',f.finishedAt)}${textRow('Realizované množstvo',f.performedQuantity)}${textRow('Poznámky k výkonu',f.driverNotes)}${textRow('Výnimka fotiek',f.photoException)}${textRow('Referencia asistencie',f.assistanceReference)}</table></section>${parties}
  ${priced ? `<section><h2>Položky výkonu</h2><table class="lines"><thead><tr><th class="description">Popis</th><th>Množstvo</th><th>Jednotka</th><th>Cena bez dane</th><th>Daň %</th><th>Spolu</th></tr></thead><tbody>${(snapshot.lines ?? []).map(line => `<tr><td>${escape(line.description)}</td><td>${escape(line.quantity)}</td><td>${escape(line.unit)}</td><td>${escape(line.unitPrice)}</td><td>${escape(line.taxRate)}</td><td>${money(line.totalCents)}</td></tr>`).join('')}</tbody></table><p class="total">Spolu: ${money(snapshot.totalCents)}</p><p class="meta">Daňový dátum: ${escape(snapshot.taxDate)} · EUR · zaokrúhlenie half-up po riadkoch</p></section>` : ''}
  <div class="signatures"><div class="signature">Objednávateľ<br>Meno:<br>Podpis:</div><div class="signature">Príjemca<br>Meno:<br>Podpis:</div><div class="signature">Dopravca<br>Meno:<br>Podpis:</div></div><p class="hash">Nemenný obsahový snapshot SHA-256: ${escape(hash)}</p></body></html>`;
}
