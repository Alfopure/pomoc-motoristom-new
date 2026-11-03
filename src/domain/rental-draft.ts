/** Rozpracovaný nájom v nájomnom systéme (Software House), pripravený z prípadu a pristavenia.
 * Polia podľa obrazovky zmluvy, ktorú označil majiteľ 28. 10. 2026; ostatné doplní pristavovač. */
export type RentalDraftField = { key: 'assistance' | 'caseReference' | 'branch' | 'firstName' | 'lastName' | 'companyName' | 'phone'; label: string; value: string | null };
export type RentalDraftConnection = { state: 'not_connected'; message: string };
export interface RentalDraftPreview { operationId: string; caseId: string | null; caseNumber: string | null; origin: 'Prenesené z dispečingu'; personType: 'person' | 'company'; fields: RentalDraftField[]; missing: string[]; openQuestions: string[]; connection: RentalDraftConnection }
export interface RentalDraftSource {
  operationId: string; caseId: string | null; caseNumber: string | null; caseAssistanceReference: string | null;
  customer: { type?: string; firstName?: string; lastName?: string; companyName?: string; assistanceServiceName?: string; assistanceReference?: string; contacts?: { phone?: string; isPrimary?: boolean }[] } | null;
  contactPhone: string | null; branchName: string | null;
}
const clean = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Only these fields would cross to the rental system; nothing else of the case. */
export function buildRentalDraft(source: RentalDraftSource): RentalDraftPreview {
  const customer = source.customer ?? {};
  const company = customer.type === 'company' || (!clean(customer.firstName) && !clean(customer.lastName) && Boolean(clean(customer.companyName)));
  const phone = clean(customer.contacts?.find(contact => contact.isPrimary)?.phone) ?? clean(customer.contacts?.[0]?.phone) ?? clean(source.contactPhone);
  const fields: RentalDraftField[] = [
    { key: 'assistance', label: 'Asistenčná služba', value: clean(customer.assistanceServiceName) },
    { key: 'caseReference', label: 'Č. prípadu', value: clean(customer.assistanceReference) ?? clean(source.caseAssistanceReference) ?? clean(source.caseNumber) },
    { key: 'branch', label: 'Pobočka', value: clean(source.branchName) },
    ...(company ? [{ key: 'companyName' as const, label: 'Nájomca – firma', value: clean(customer.companyName) }]
      : [{ key: 'firstName' as const, label: 'Nájomca – meno', value: clean(customer.firstName) }, { key: 'lastName' as const, label: 'Nájomca – priezvisko', value: clean(customer.lastName) }]),
    { key: 'phone', label: 'Nájomca – telefón', value: phone },
  ];
  return {
    operationId: source.operationId, caseId: source.caseId, caseNumber: source.caseNumber, origin: 'Prenesené z dispečingu', personType: company ? 'company' : 'person', fields,
    missing: fields.filter(field => !field.value).map(field => field.label),
    openQuestions: ['Prenajímateľ: určí ho nájomný systém alebo pristavovač?', 'Status draftu: dohodnúť hodnotu „Prenesené z dispečingu“.'],
    connection: { state: 'not_connected', message: 'Prenos do nájomného systému čaká na dohodu s Braňom. Nič sa zatiaľ neodosiela.' },
  };
}
