export interface PartnerActor { id: string; userId: string; organizationId: string; partnerId: string; version: number; displayName: string; status: 'invited' | 'active'; }
export interface PartnerOutput { id: string; caseId: string; caseNumber: string; partnerId: string; partnerName: string; version: number; title: string; result: string; recipient: string; publishedAt: string; hash: string; }
export interface PartnerCaseContext { case_id: string; partner_id: string; partner_name: string; source_call_id: string | null; source_line_id: string | null; revision: number; settlement: PartnerSettlement; }
export interface PartnerSettlement { payer: string; reference: string; agreement: string; agreementVersion: string; billable: boolean; approvedCents: number | null; currency: 'EUR'; recommendation: string; serviceAccepted: boolean; acceptanceEvidence: string; }
export const emptyPartnerSettlement: PartnerSettlement = { payer: '', reference: '', agreement: '', agreementVersion: '', billable: false, approvedCents: null, currency: 'EUR', recommendation: '', serviceAccepted: false, acceptanceEvidence: '' };
export type PartnerFollowupStatus = 'new' | 'taken' | 'contacted';
export type PartnerWorkStatus = 'received' | 'in_progress' | 'completed' | 'cancelled';
export interface PartnerFollowupNote { id: string; body: string; author: string; createdAt: string; }
/** Exact server allowlist of `motorist_partner_followup_projection`; the portal gets the customer only for an insurance event. */
export interface PartnerFollowupCase { caseId: string; caseNumber: string; createdAt: string; caseType: string; workStatus: PartnerWorkStatus; vehicle: { make: string | null; model: string | null; plate: string | null }; insuranceEvent: boolean; insuranceLabel: string | null; insuranceMarkedAt: string | null; status: PartnerFollowupStatus; revision: number; takenAt: string | null; takenBy: string | null; contactedAt: string | null; contactedBy: string | null; customer: { name: string | null; phone: string | null } | null; notes: PartnerFollowupNote[]; }
export interface PartnerFollowupStats { from: string; to: string; cases: number; insuranceEvents: number; taken: number; contacted: number; contactSample: number; contactPending: number; contactUnknown: number; contactMedianMinutes: number | null; }
export interface PartnerPortalData { partnerName: string; account: string; newInsurance: number; stats: PartnerFollowupStats; cases: PartnerFollowupCase[]; }
export interface PartnerFollowupOverview { partners: { partnerId: string; partnerName: string; newInsurance: number; stats: PartnerFollowupStats; cases: PartnerFollowupCase[] }[]; case: PartnerFollowupCase | null; }
export const partnerWorkStatusLabels: Record<PartnerWorkStatus, string> = { received: 'Prijatý', in_progress: 'Rieši sa', completed: 'Ukončený', cancelled: 'Zrušený' };
export const partnerFollowupStatusLabels: Record<PartnerFollowupStatus, string> = { new: 'Nové', taken: 'Prevzaté', contacted: 'Klient kontaktovaný' };
const partnerZone = 'Europe/Bratislava';
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
function shiftDate(date: string, days: number) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function zoneOffsetMinutes(at: number) {
  const value = new Intl.DateTimeFormat('en-US', { timeZone: partnerZone, timeZoneName: 'longOffset' }).formatToParts(new Date(at)).find(p => p.type === 'timeZoneName')?.value ?? '';
  const match = /([+-])(\d{2}):(\d{2})/.exec(value); return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}
// The offset is taken at the candidate instant itself, so DST transition days resolve correctly.
function zoneMidnight(date: string) {
  const wall = Date.parse(`${date}T00:00:00Z`); const guess = wall - zoneOffsetMinutes(wall) * 60000;
  return new Date(wall - zoneOffsetMinutes(guess) * 60000);
}
export function partnerToday(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: partnerZone }).format(now); }
/** Inclusive Bratislava calendar days as `[from, to)` instants; last 30 days by default, null when invalid or longer than 400 days. */
export function partnerPeriod(fromDate?: string | null, toDate?: string | null, now = new Date()) {
  const to = toDate || partnerToday(now); const from = fromDate || shiftDate(to, -29);
  if (!isoDate.test(from) || !isoDate.test(to) || Number.isNaN(Date.parse(`${from}T12:00:00Z`)) || Number.isNaN(Date.parse(`${to}T12:00:00Z`)) || shiftDate(from, 0) !== from || shiftDate(to, 0) !== to || from > to) return null;
  const start = zoneMidnight(from); const end = zoneMidnight(shiftDate(to, 1));
  if (end.getTime() - start.getTime() > 400 * 86400000) return null;
  return { fromDate: from, toDate: to, from: start.toISOString(), to: end.toISOString() };
}
/** Unknown stays unknown: an empty sample is never shown as zero minutes. */
export function partnerContactTimeLabel(stats: Pick<PartnerFollowupStats, 'contactMedianMinutes' | 'contactSample' | 'contactPending' | 'contactUnknown'>) {
  const unknown = `${stats.contactPending ? ` · čaká na kontakt: ${stats.contactPending}` : ''}${stats.contactUnknown ? ` · kontakt bez merateľného času: ${stats.contactUnknown}` : ''}`;
  if (stats.contactMedianMinutes === null || stats.contactSample === 0) return `neznámy (0 meraní)${unknown}`;
  const m = stats.contactMedianMinutes; const value = m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1).replace('.', ',')} h`;
  return `medián ${value} (${stats.contactSample} ${stats.contactSample === 1 ? 'meranie' : stats.contactSample < 5 ? 'merania' : 'meraní'})${unknown}`;
}
