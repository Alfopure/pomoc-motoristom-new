import type { RoutingDiagnostic } from './routing';
/** Browser-safe closed schema. Never add messages, URLs, stacks or arbitrary metadata. */
export const DIAGNOSTIC_LIMITS = { queueEvents: 200, queueBytes: 128 * 1024, ttlMs: 86_400_000, batchEvents: 16, batchBytes: 16 * 1024, eventBytes: 1024, flushMs: 30_000, criticalFlushMs: 5_000, attemptsPerMinute: 12, sampleRate: 0.05, maxCount: 10_000 } as const;
export const DIAGNOSTIC_MODULES = ['app','auth','cases','telephony','sms','documents','fleet','integrations'] as const;
export const DIAGNOSTIC_OPERATIONS = ['case.open','case.create','case.save','case.assign','case.action','call.start','call.pickup','call.hangup','call.transfer','call.hold','sms.send','document.upload','document.download','document.generate','fleet.refresh','integration.lookup','auth.login','app.refresh'] as const;
export const DIAGNOSTIC_OUTCOMES = ['ok','failed','conflict','cancelled','timeout','unknown','committed_refresh_failed'] as const;
export const DIAGNOSTIC_EVENT_TYPES = ['ui_error','unhandled_rejection','chunk_error','user_report','operation','page_lifecycle','phone_lifecycle','app_update','call_timing','coverage'] as const;
export const DIAGNOSTIC_REASONS = ['online','offline','pagehide','pageshow','update_detected','update_requested','update_blocked','registered','registering','unregistered','reconnect','takeover','dispose','logout','hangup_intent','provider_disconnect','transport_error','chunk_load','boundary','global_error','global_rejection','user_requested','slow','request_failed','validation','refresh_failed','unknown','incoming_event','answer_clicked','sdk_answer_invoked','sdk_active','remote_audio_attached','server_answered','component_unmount','ownership_release','mobile_standby','superseded','recovery_timeout','auth_failure','disconnected','reconnecting','ownership_acquired','takeover_requested','hangup_requested','sdk_warning','sdk_socket_error','sdk_recoverable_error','visible','hidden','queue_drop'] as const;
export const DIAGNOSTIC_ERROR_CLASSES = ['Error','TypeError','RangeError','ReferenceError','SyntaxError','AbortError','NetworkError','ChunkLoadError','TimeoutError','UnknownError'] as const;
export type DiagnosticModule = typeof DIAGNOSTIC_MODULES[number];
export type DiagnosticOperation = typeof DIAGNOSTIC_OPERATIONS[number];
export type DiagnosticOutcome = typeof DIAGNOSTIC_OUTCOMES[number];
export type DiagnosticReason = typeof DIAGNOSTIC_REASONS[number];
export type DiagnosticErrorClass = typeof DIAGNOSTIC_ERROR_CLASSES[number];
export type DiagnosticEventType = typeof DIAGNOSTIC_EVENT_TYPES[number];
export type DiagnosticEvent = {
  id: string; pageId: string; sequence: number; occurredAt: string; monotonicMs: number;
  type: DiagnosticEventType; module: DiagnosticModule; outcome: DiagnosticOutcome; buildId: string;
  sampled: boolean; sampleRate: number; operation?: DiagnosticOperation; durationMs?: number;
  requestId?: string; operationId?: string; caseId?: string; callSessionId?: string; deviceSessionId?: string;
  reason?: DiagnosticReason; errorClass?: DiagnosticErrorClass; errorId?: string; count?: number;
};
export type DiagnosticEventInput = Omit<DiagnosticEvent, 'id'|'pageId'|'sequence'|'occurredAt'|'monotonicMs'|'buildId'|'sampled'|'sampleRate'> & {sampled?:boolean;sampleRate?:number};
export type DiagnosticAck = {acceptedIds:string[]; rejectedIds?:string[]; degraded?:boolean};
export function isDiagnosticUuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
export function isDiagnosticSafeId(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value); }
const fields = new Set(['id','pageId','sequence','occurredAt','monotonicMs','type','module','outcome','buildId','sampled','sampleRate','operation','durationMs','requestId','operationId','caseId','callSessionId','deviceSessionId','reason','errorClass','errorId','count']);
const includes = (values: readonly string[], value: unknown) => typeof value === 'string' && values.includes(value);
const bounded = (v:unknown,min:number,max:number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
/** Reject unknown fields rather than accepting a payload which accidentally contains private data. */
export function parseDiagnosticEvent(value:unknown):DiagnosticEvent|null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const e = value as Record<string,unknown>;
  if (Object.keys(e).some(k=>!fields.has(k))) return null;
  if (!isDiagnosticUuid(e.id)||!isDiagnosticUuid(e.pageId)||!Number.isInteger(e.sequence)||!bounded(e.sequence,0,2_147_483_647)||!bounded(e.monotonicMs,0,31_536_000_000)) return null;
  if (typeof e.occurredAt !== 'string'|| !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(e.occurredAt)|| !Number.isFinite(Date.parse(e.occurredAt)) || new Date(e.occurredAt).toISOString() !== e.occurredAt) return null;
  if (!includes(DIAGNOSTIC_EVENT_TYPES,e.type)||!includes(DIAGNOSTIC_MODULES,e.module)||!includes(DIAGNOSTIC_OUTCOMES,e.outcome)||!isDiagnosticSafeId(e.buildId)) return null;
  if (typeof e.sampled !== 'boolean'||!bounded(e.sampleRate,0,1)|| (e.sampled && !(Number(e.sampleRate)>0))) return null;
  for (const key of ['requestId','operationId','caseId','callSessionId','deviceSessionId']) if (e[key]!==undefined&&!isDiagnosticUuid(e[key])) return null;
  if ((e.type==='operation' && e.operation===undefined)||(e.operation!==undefined&&!includes(DIAGNOSTIC_OPERATIONS,e.operation))) return null;
  if (e.reason!==undefined&&!includes(DIAGNOSTIC_REASONS,e.reason)) return null;
  if (e.errorClass!==undefined&&!includes(DIAGNOSTIC_ERROR_CLASSES,e.errorClass)) return null;
  if (e.errorId!==undefined&&!isDiagnosticSafeId(e.errorId)) return null;
  if (e.durationMs!==undefined&&!bounded(e.durationMs,0,86_400_000)) return null;
  if (e.count!==undefined&&(!Number.isInteger(e.count)||!bounded(e.count,1,DIAGNOSTIC_LIMITS.maxCount))) return null;
  if (new TextEncoder().encode(JSON.stringify(e)).byteLength>DIAGNOSTIC_LIMITS.eventBytes) return null;
  return {...e} as DiagnosticEvent;
}
export type DiagnosticIncidentStatus = 'new'|'acknowledged'|'resolved';
export type DiagnosticIncident = {id:string; firstSeenAt:string; lastSeenAt:string; module:DiagnosticModule; operation:DiagnosticOperation|null; kind:'ui_error'|'user_report'|'operation'|'call_interruption'; status:DiagnosticIncidentStatus; count:number; buildId:string|null; profileId:string|null; callSessionId:string|null; caseId:string|null; classification:'observation'|'candidate'|'interruption_observed'|'expected_end'|'unknown'; cause:'unknown'; evidenceIds:string[]};
export type DiagnosticStoredEvent = DiagnosticEvent & {receivedAt:string; profileId:string|null; source:'browser'|'server'|'cron'; serverBuild:string};
export type DiagnosticOperationSummary = {operation:DiagnosticOperation;sampleRate:number;samples:number;failedSamples:number;p50Ms:number|null;p95Ms:number|null;insufficientData:boolean};
export type DiagnosticCallSummary = {direction:'inbound'|'outbound'|'internal';total:number;answered:number;unanswered:number;active:number;averageWaitSeconds:number|null;averageAnsweredToEndSeconds:number|null};
export type DiagnosticStorage = {chargedBytes:number;eventCount:number;incidentCount:number;dropped:number;physicalBytes:number|null;physicalBudgetBytes:number;physicalCheckedAt:string|null;blocked:boolean;cleanupBacklog:boolean};
export type DiagnosticOverview = {checkedAt:string;enabled:boolean;environment:'production'|'test'|'development';coverage:'unknown'|'limited';since:string;until:string;incidents:DiagnosticIncident[];nextCursor:string|null;operations:DiagnosticOperationSummary[];builds:{buildId:string;lastSeenAt:string;events:number}[];calls:DiagnosticCallSummary[];storage:DiagnosticStorage|null};
export type DiagnosticTimeline = {callSessionId:string;checkedAt:string;events:DiagnosticStoredEvent[];legs:{id:string;role:string;answeredAt:string|null;bridgedAt:string|null;endedAt:string|null}[];nextCursor:string|null;cause:'unknown';routing?:RoutingDiagnostic[];routingTruncated?:boolean;routingUnavailable?:boolean;routingProfiles?:Record<string,string>};
export type DiagnosticIncidentDetail = {incident:DiagnosticIncident;events:DiagnosticStoredEvent[];checkedAt:string};
