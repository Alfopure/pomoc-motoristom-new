/** Real application components, synthetic data only. Used by capture-guide-screenshots.mjs. */
import { createRoot } from 'react-dom/client';
import { DispatchConsole } from '@/components/dispatch/DispatchConsole';
import { MotoristLogin } from '@/components/auth/MotoristLogin';
import { PhoneBar } from '@/components/dispatch/PhoneBar';
import { CallQueuePanel } from '@/components/dispatch/CallQueuePanel';
import { CallbackQueuePanel } from '@/components/dispatch/CallbackQueuePanel';
import { CallTransferPicker } from '@/components/dispatch/CallTransferPicker';
import { PauseRoutingDialog } from '@/components/dispatch/PauseRoutingDialog';
import { HeaderPhoneStatusMenu } from '@/components/dispatch/HeaderPhoneStatusMenu';
import { SmsComposerDialog } from '@/components/dispatch/SmsComposerDialog';
import { EMPTY_ACTIVE_CALLS } from '@/lib/telephony/active-calls-model';
import { DEFAULT_OPERATOR_SETTINGS } from '@/lib/telephony/operator-settings';
import { DEFAULT_ANNOUNCEMENT_VOICE } from '@/lib/telephony/announcements';
import * as seed from '@/mock/seed';
import type { DispatchData } from '@/data/dispatch-types';
import type { RoutingDocument } from '@/server/telephony/config-service';
import type { PhoneBarCall, PhoneBarModel } from '@/lib/telephony/active-calls-model';
import type { WebphoneSnapshot } from '@/lib/telephony/telnyx-webphone';

const now = '2026-09-11T09:30:00.000Z';
const me = 'op-natalia';
const noop = () => {};
const names = ['Jana Ukážková', 'Martin Ukážkový', 'Eva Ukážková', 'Tomáš Ukážkový', 'Mária Ukážková'];
// Even repository demo telephone numbers are replaced with visibly synthetic numbers.
function sanitize<T>(input: T): T {
  return JSON.parse(JSON.stringify(input).replace(/\+421[\d ]{8,15}/g, '+421 900 000 001').replace(/0850 005 006/g, '+421 900 000 002').replace(/2026-05-20/g, '2026-09-11').replace(/2026-05-/g, '2026-09-'));
}
const operators = seed.operators.map((op, index) => ({ ...op, name: names[index], status: index === 0 || index === 1 ? 'available' as const : op.status }));
const cases = sanitize(seed.dispatchCases).map((item, index) => ({ ...item, contact: { ...item.contact, name: ['Klient — ukážka A', 'Asistencia — ukážka B', 'Klient — ukážka C', 'Klient — ukážka D'][index] ?? 'Ukážkový klient', phone: '+421 900 000 010' }, ownerName: operators.find(op => op.id === item.ownerId)?.name ?? 'Jana Ukážková', vehicle: { ...item.vehicle, licensePlate: `DEMO ${index + 1}`, vin: '' }, timeline: item.timeline.map(event => ({ ...event, actor: 'Ukážkový dispečer' })) }));
const members = operators.slice(0, 2).map((op, index) => ({ id: `member-${index}`, memberKind: 'operator' as const, profileId: op.id, externalNumber: null, position: index, ringSecs: index === 0 ? 20 : 15, lastOfferedAt: null, lastAnsweredAt: null }));
const doc: RoutingDocument = {
  organizationId: '00000000-0000-4000-8000-000000000001', routingVersion: 3,
  groups: [
    { id: 'group-main', name: 'Dispečing — denná služba', description: 'Ukážka: hlavný tím dispečerov', active: true, members },
    { id: 'group-backup', name: 'Záloha — služobný mobil', description: 'Ukážka: záložná pozícia v pláne', active: true, members: [{ id: 'member-backup', memberKind: 'external_number', profileId: null, externalNumber: '+421900000020', ownerProfileId: 'op-miso', position: 0, ringSecs: 15, lastOfferedAt: null, lastAnsweredAt: null }] },
  ],
  plans: [{ id: 'plan-main', name: 'Hlavná linka — služba a záloha', fallbackKind: 'waiting_room', fallbackNumber: null, active: true, steps: [{ id: 'step-team', stepIndex: 0, ringGroupId: 'group-main', timeoutSecs: 25, strategy: 'all' }, { id: 'step-backup', stepIndex: 1, ringGroupId: 'group-backup', timeoutSecs: 15, strategy: 'ordered' }] }],
  businessHours: [{ id: 'hours-main', name: 'Pracovné dni 08:00 – 18:00', timezone: 'Europe/Bratislava', active: true, intervals: [1, 2, 3, 4, 5].map(weekday => ({ weekday, opens: '08:00', closes: '18:00' })), exceptions: [{ date: '2026-12-24', closed: true, intervals: [], label: 'Štedrý deň — ukážka' }] }],
  pauseReasons: [{ id: 'pause-break', code: 'break', label: 'Krátka prestávka', maxMinutes: 15, sortOrder: 0, active: true }, { id: 'pause-lunch', code: 'lunch', label: 'Obed', maxMinutes: 30, sortOrder: 1, active: true }], pauseReasonsInUse: [],
  lines: [{ id: 'line-main', phoneNumber: '+421900000002', label: 'Hlavná linka — ukážka', partnerName: 'Ukážková asistencia', telnyxNumberId: null, ringPlanId: 'plan-main', ivrMenuId: 'ivr-main', businessHoursId: 'hours-main', environment: 'development', active: true, returnLineId: 'line-main' }],
  ivrMenus: [{ id: 'ivr-main', name: 'Hlavné hlasové menu', active: true, promptMediaUrl: null, ttsText: 'Pre dispečing stlačte jednotku. Pre spätné volanie dvojku.', invalidMediaUrl: null, timeoutSecs: 7, maxTries: 2, ringPlanIds: ['plan-main'], options: [{ id: 'ivr-1', digit: '1', action: 'ring_plan', label: 'Spojiť s dispečingom', targetRingPlanId: 'plan-main', targetNumber: null, promptMediaUrl: null, ttsText: null }, { id: 'ivr-2', digit: '2', action: 'callback', label: 'Požiadať o spätné volanie', targetRingPlanId: null, targetNumber: null, promptMediaUrl: null, ttsText: 'Ďakujeme, zavoláme vám späť.' }] }],
  operators: operators.map(op => ({ profileId: op.id, displayName: op.name, role: 'dispatcher', active: true, settings: { ...DEFAULT_OPERATOR_SETTINGS, defaultFromLineId: 'line-main' }, device: { environment: 'development', credentialId: null, sipUsername: null, registrationState: 'registered', deviceSeenAt: now } })),
  limits: { destinationAllowlist: ['SK', 'CZ'], maxRingFanout: 8, maxConcurrentLegs: 9 }, settings: null,
};
const taskBase = { caseId: '', caseIds: [], caseLinks: [], revision: 1, originLocked: false, provenance: 'manual' as const, origins: [], updatedAt: now, assignedTo: me, dueAt: '2026-09-11T10:00:00Z', reminderAt: '2026-09-11T09:50:00Z', status: 'open' as const, priority: 'normal' as const, kind: 'other' as const };
const tasks = [{ ...taskBase, id: '00000000-0000-4000-8000-000000000010', title: 'Overiť príchod odťahovky' }, { ...taskBase, id: '00000000-0000-4000-8000-000000000011', title: 'Odovzdať rozpracované prípady', dueAt: '2026-09-12T08:00:00Z' }];
const data: DispatchData = { ...sanitize({ attendance: seed.attendance, branches: seed.branches, callCenterCalls: seed.callCenterCalls, fleetAssets: seed.fleetAssets, incomingCall: seed.incomingCall, integrations: seed.integrations, metrics: seed.metrics, notifications: seed.notifications, priceRules: seed.priceRules }), dispatchCases: cases, callCenterCalls: sanitize(seed.callCenterCalls).map((call, index) => ({ ...call, callerName: `Klient — ukážka ${index + 1}`, operatorName: names[index % names.length] })), operators, users: [], partnerDirectory: [], fleetProviderVehicles: [], commanderVehicles: [], source: 'mock', workspaceCapabilities: { notes: true, tasks: true, atomicCaseSave: false, pdf: false }, tasks };
const callbackBase = { callerNumber: '+421900000011', callerName: 'Klient — ukážka A', source: 'ivr', status: 'open', lineId: 'line-main', lineLabel: 'Hlavná linka — ukážka', partnerName: null, caseId: null, sessionId: 'session-demo', claimedByProfileId: null, claimedByName: null, claimedAt: null, dueAt: '2026-09-11T09:45:00Z', createdAt: '2026-09-11T09:15:00Z', resolvedAt: null, notes: null, lastCallSessionId: null, lastCalledAt: null };
const responses: Record<string, unknown> = {
  '/api/telephony/calls/active': { ...EMPTY_ACTIVE_CALLS, checkedAt: now, actorProfileId: me, ownPresence: { status: 'available', pauseReasonId: null, statusSince: now } },
  '/api/tasks': { tasks },
  '/api/telephony/directory/favorites': { favorites: [] },
  '/api/telephony/monitor-invitations': { invitations: [] },
  '/api/sms/inbox': { messages: [], unreadCount: 0 },
  '/api/health/live': { status: 'ok', services: [] },
  '/api/telephony/calls/call-demo/recording-detail': { liveState: 'off' },
  '/api/telephony/config/ring-groups': { document: doc, canEdit: true, canManageSettings: false },
  '/api/telephony/presence': { configured: true, snapshot: { actorProfileId: me, checkedAt: now, canManageAssignments: true, devices: [], presence: operators.map(op => ({ profileId: op.id, status: op.status, currentSessionId: null })) }, own: { profileId: me, status: 'available', pauseReasonId: null, currentSessionId: null, wrapUpUntil: null, statusSince: now } },
  '/api/telephony/config/announcements': { lines: [{ id: 'line-main', label: 'Hlavná linka — ukážka', phoneNumber: '+421900000002', revision: now, config: { version: 1, language: 'sk', voiceId: DEFAULT_ANNOUNCEMENT_VOICE, prompts: {} } }], canEdit: true, generationAvailable: true },
  '/api/telephony/config/recording-policy': { policy: { revision: 1, recordingEnabled: false, transcriptionEnabled: false, analysisEnabled: false, qualityEnabled: false, inboundEnabled: true, outboundEnabled: false, audioRetentionDays: 30, transcriptRetentionDays: 30, reviewRetentionDays: 90, maxRecordingsPerHour: 10, maxRecordingBytes: 33554432, maxSegmentSeconds: 1800, controllerName: 'Ukážková organizácia', contactEmail: 'spravca@example.test', privacyNoticeUrl: 'https://example.test/ochrana-hovorov', serviceLegalBasis: '', qualityLegalBasis: '', approvedAt: null }, canEdit: true, readiness: { recording: false, transcription: false, analysis: false, reasons: [] } },
  '/api/telephony/callbacks': { checkedAt: now, configured: true, actorProfileId: me, actorRole: 'manager', open: [{ ...callbackBase, id: 'callback-1', origin: { kind: 'requested', requestedAt: '2026-09-11T09:15:00Z', digit: '2', context: 'ivr', evidence: 'dtmf' } }, { ...callbackBase, id: 'callback-2', callerName: 'Klient — ukážka B', callerNumber: '+421900000012', status: 'scheduled', claimedByProfileId: me, claimedByName: names[0], claimedAt: now, source: 'missed', createdAt: '2026-09-11T09:00:00Z', dueAt: '2026-09-11T09:30:00Z' }], resolved: [] },
  '/api/telephony/calls/session-demo/transfer-targets': { targets: operators.slice(1, 4).map((op, index) => ({ profileId: op.id, displayName: op.name, role: 'dispatcher', available: index === 0, status: index === 0 ? 'available' : 'on_call', deviceLive: true })) },
  '/api/notes': { notes: [{ id: 'note-demo', ownerProfileId: me, title: 'Odovzdanie služby — ukážka', body: 'Pred koncom služby skontrolovať:\n\n• Otvorené spätné volania\n• Termíny úloh na dnes\n• Prípady čakajúce na techniku\n\nDohodnuté kroky zapíšte ku konkrétnemu prípadu.', revision: 1, updatedAt: now, recipientProfileIds: [], canEdit: true }] },
  '/api/notes/colleagues': { colleagues: operators.slice(1).map(op => ({ id: op.id, displayName: op.name })) },
  '/api/version': { version: 'guide-demo' },
  '/api/directory': { canEdit: true, entries: ['Odťahová služba — ukážka', 'Partnerský servis — ukážka', 'Asistenčná spoločnosť — ukážka'].map((name, index) => ({ id: `directory-${index}`, kind: index === 2 ? 'assistance' : 'company', name, phone: `+42190000003${index}`, email: 'kontakt@example.test', note: 'Demonštračný kontakt pre návod', active: true, updatedAt: now, ico: '', address: 'Ukážková 1, Žilina', website: '', focus: index === 0 ? 'towing' : 'garage', contactIds: [], parentId: null, role: 'partner', location: null, availableReplacementCars: 2 })) },
  '/api/sms/context': { cases: cases.map(item => ({ id: item.id, caseNumber: item.caseNumber, name: item.contact.name, phone: item.contact.phone, validPhone: true })), tasks: [], callbackNumber: '+421900000002', sender: 'PomocMotor', repliesEnabled: false },
  '/api/reports/dashboard': { generatedAt: now, range: { key: '7d', label: '5. – 11. september 2026', from: '2026-09-05', to: '2026-09-11' }, overview: { totalCalls: 128, answerRate: 94.44, answeredInboundCalls: 102, completedInboundCalls: 108, medianWaitSeconds: 14, serviceLevel: 87, newCases: 42, completedCases: 36, openTasks: 8, overdueTasks: 2, callsByDay: [12, 18, 15, 21, 17, 25, 20].map((value, index) => ({ label: `${5 + index}. 9.`, value })), callResults: [{ label: 'Prijaté', value: 102 }, { label: 'Zmeškané', value: 6 }, { label: 'Odchádzajúce', value: 20 }], caseFlow: [{ label: 'Nové', value: 42 }, { label: 'Ukončené', value: 36 }] }, calls: {}, operators: { rows: [], callsByOperator: [], talkTimeByOperator: [] }, cases: {} },
};
Object.assign(window, { guideResponses: responses });
const call: PhoneBarCall = { sessionId: 'session-demo', callId: 'call-demo', kind: 'active', state: 'talking', direction: 'inbound', lineLabel: 'Hlavná linka — ukážka', partnerName: 'Ukážková asistencia', number: '+421900000010', callerName: 'Klient — ukážka A', caseId: cases[0].id, match: null, matchCount: 0, participants: [], timerSince: '2026-09-11T09:27:45Z', answered: true, held: false, parked: false, consulting: false, conference: false, mine: true, operatorProfileId: me, operatorName: names[0], offeredProfileIds: [], offeredOperatorNames: [], offeredToMe: false };
const phone: WebphoneSnapshot = { status: 'registered', registration: { status: 'registered', label: 'Pripojené', tone: 'ok', detail: 'Telefón je pripojený a pripravený na hovory.' }, sipUsername: null, deviceSessionId: null, message: null, call: { id: 'browser-demo', state: 'active', direction: 'inbound', number: call.number, callerName: call.callerName, telnyxCallControlId: 'control-demo', sessionId: call.sessionId, muted: false, ringing: false, active: true } };
const model: PhoneBarModel = { checkedAt: now, configured: true, active: call, offers: [], waiting: [], otherActiveCount: 0, others: [], teamCalls: [], supervising: null, ownPresenceStatus: 'on_call', presence: { actorProfileId: me, canManageAssignments: true, checkedAt: now, devices: [], presence: [] } };
const scenario = new URLSearchParams(location.search).get('scenario') ?? 'console';
const isolated = !['console', 'login'].includes(scenario);
const titles: Record<string, string> = { 'incoming-call': 'Prichádzajúci hovor', 'active-call': 'Ovládanie prebiehajúceho hovoru', transfer: 'Prepojenie hovoru na kolegu', queue: 'Čakáreň', callbacks: 'Spätné volania', pause: 'Prestávka a zastupovanie', sms: 'SMS k prípadu', 'phone-status': 'Telefón a dostupnosť' };
const incoming = scenario === 'incoming-call';
function TelephonyScenario() {
 if (scenario === 'queue') return <CallQueuePanel variant="embedded" now={Date.parse(now)} calls={[
  { call: { ...data.callCenterCalls[0], id: 'waiting-1', callerName: 'Klient — ukážka A', callerNumber: '+421900000010', startedAt: '2026-09-11T09:28:45Z', lineLabel: 'Hlavná linka — ukážka', status: 'ringing_agent' }, station: { extension: '102', name: names[1] } },
  { call: { ...data.callCenterCalls[0], id: 'waiting-2', callerName: 'Klient — ukážka B', callerNumber: '+421900000011', startedAt: '2026-09-11T09:29:10Z', lineLabel: 'Hlavná linka — ukážka', status: 'incoming' } },
 ]} onPickup={noop} pickupState={() => ({ disabled: false, label: 'Vyzdvihnúť' })} />;
 if (scenario === 'callbacks') return <CallbackQueuePanel configured onCallBack={async () => {}} />;
 if (scenario === 'pause') return <PauseRoutingDialog open profileId={me} operators={operators} pauseReasons={doc.pauseReasons} presences={operators.map(op => ({ profileId: op.id, operatorName: op.name, extensions: [op.extension], state: 'available' as const, available: true, queueMember: true, queueNumbers: [], availableQueues: [], paused: false, inUse: false, registered: true, detail: 'Dostupný', checkedAt: now }))} onClose={noop} onActivate={async () => false} />;
 if (scenario === 'sms') return <SmsComposerDialog initialTemplate="custom" caseId={cases[0].id} caseNumber={cases[0].caseNumber} initialPhone="+421900000010" open onClose={noop} />;
 if (scenario === 'phone-status') return <div className="flex justify-end"><HeaderPhoneStatusMenu busy={false} onChange={noop} onRequestPause={noop} onDismissNotice={noop} onTakeover={noop} notice={null} phone={{ ...phone, call: null }} status="available" readiness={{ status: 'ready', message: null }} onPreparePhone={async () => true} outboundPending={false} /></div>;
 return <><PhoneBar model={{ ...model, active: incoming ? null : call }} phone={{ ...phone, call: { ...phone.call!, active: !incoming, ringing: incoming, state: incoming ? 'ringing' : 'active', sessionId: incoming ? null : call.sessionId } }} outboundPending={false} degradedSessionIds={new Set()} busyAction={null} notice={null} onDismissNotice={noop} onCallAction={noop} onPartyAction={noop} canSupervise={false} onSupervise={noop} onStopSupervise={noop} onAnswer={noop} onHangupBrowser={noop} onToggleMute={noop} onDtmf={noop} onNewCase={noop} onLinkCase={noop} onOpenCase={noop} onResumeAudio={noop} />{scenario === 'transfer' && <div className="flex justify-end pt-5"><CallTransferPicker sessionId="session-demo" mode="transfer" busy={false} onCancel={noop} onSubmit={noop} /></div>}</>;
}
createRoot(document.getElementById('root')!).render(scenario === 'login' ? <MotoristLogin message="Prihláste sa svojím pracovným účtom." /> : isolated ? <main className="min-h-screen bg-zinc-100 p-8 text-zinc-950"><div className="mx-auto max-w-5xl"><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">Pomoc motoristom · ukážkové údaje</p><h1 className="mb-6 text-2xl font-semibold">{titles[scenario]}</h1><TelephonyScenario /></div></main> : <DispatchConsole initialData={data} viewerOrganizationId={doc.organizationId} viewerProfileId={me} viewerDisplayName={names[0]} viewerRole="manager" appVersion="guide-demo" />);
