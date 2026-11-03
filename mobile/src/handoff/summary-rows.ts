import type { MobileHandoffSnapshot } from '../../../src/lib/mobile-api';
const labels: Record<string, string> = {
  immobile: 'Nepojazdné', locked: 'Zamknuté', no_keys: 'Bez kľúčov', blocked_wheel: 'Zablokované koleso', after_accident: 'Po nehode', overturned: 'Prevrátené', in_ditch: 'V priekope', small_car: 'Malé osobné auto', wagon: 'Kombi', suv: 'SUV', van: 'Dodávka', automatic: 'Automat', manual: 'Manuál', ev: 'Elektrické', not_needed: 'Nie je potrebné', not_provided: 'Neposkytnuté', assigned: 'Priradené', provided: 'Poskytnuté', pending: 'Zatiaľ nepriradené'
};
const display = (value: unknown): string => value === null || value === undefined || value === '' ? 'Neuvedené' : value === true ? 'Áno' : value === false ? 'Nie' : Array.isArray(value) ? value.map(v => labels[v] ?? v).join(' · ') || 'Neuvedené' : String(value);
export function handoffTime(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' }) + ' (Bratislava)' : 'Neuvedené';
}
/** One row for every accepted snapshot field, including empty/false/zero data. */
export function snapshotRows(value: MobileHandoffSnapshot): [
  string,
  string
][] {
  const rows: [
    string,
    unknown
  ][] = [['Verzia údajov', value.schemaVersion === 3 ? '3' : 'Pôvodná'], ['Číslo prípadu', value.caseNumber], ['Úkon', value.action], ['Meno klienta', value.contact.name], ['Telefón klienta', value.contact.phone], ['Značka vozidla', value.vehicle.make], ['Model vozidla', value.vehicle.model], ['EČV vozidla', value.vehicle.plate]];
  if (value.schemaVersion === 3)
    rows.push(['Farba vozidla', value.vehicle.color], ['Pojazdné', value.vehicle.driveable], ['Stav vozidla', value.vehicle.conditionFlags]);
  for (const [label, place] of [['Miesto úkonu', value.pickup], ['Cieľ', value.destination]] as const) {
    rows.push([label, place?.address], ['Šírka · ' + label, place?.lat], ['Dĺžka · ' + label, place?.lng]);
  }
  if (value.assistance)
    rows.push(['Asistenčná služba', value.assistance.name], ['Referencia asistenčky', value.assistance.reference]);
  if (value.replacement) {
    const r = value.replacement;
    rows.push(['Náhradné vozidlo potrebné', r.needed], ['Kategória náhradného vozidla', labels[r.category] ?? r.category], ['Požadovaný typ', r.requestedType], ['Preferencie náhradného vozidla', r.preferences], ['Poskytnutie náhradného vozidla', labels[r.status] ?? r.status], ['Pristavenie náhradného vozidla', r.deliveryPlace], ['Značka náhradného vozidla', r.vehicle?.make], ['Model náhradného vozidla', r.vehicle?.model], ['EČV náhradného vozidla', r.vehicle?.plate]);
  }
  if (value.incident)
    rows.push(['Opis udalosti', value.incident.description], ['Počet osôb', value.incident.passengersCount], ['Prístup na miesto', value.incident.access]);
  rows.push(['Pokyny pre kolegu', value.instructions], ['Dohodnutý čas', handoffTime(value.scheduledAt)]);
  if (value.schemaVersion === 3)
    rows.push(['Prípad vytvorený', handoffTime(value.caseCreatedAt)], ['Prvý súvisiaci hovor', handoffTime(value.firstCallAt)]);
  return rows.map(([label, value]) => [label, display(value)]);
}
