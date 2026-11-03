import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only',()=>({}));
import { partnerContactTimeLabel, partnerPeriod } from '@/domain/partners';
import { isMissingFollowupRpc, parsePartnerFollowupCommand, parsePartnerInsuranceCommand } from './followups';
const caseId='a0000000-0000-4000-8000-000000000001'; const commandId='b0000000-0000-4000-8000-000000000001';
describe('partner follow-up command parsing',()=>{
 it('forwards only the allowlisted action fields',()=>{
  expect(parsePartnerFollowupCommand({action:'take',caseId,commandId,expectedRevision:1,status:'contacted',partnerId:'x'})).toEqual({action:'take',commandId,expectedRevision:1,payload:{caseId}});
  expect(parsePartnerFollowupCommand({action:'note',caseId,commandId,body:'  Volané  ',expectedRevision:7})).toEqual({action:'note',commandId,expectedRevision:0,payload:{caseId,body:'Volané'}});
 });
 it('rejects unknown actions, bad identifiers, revisions and note sizes',()=>{
  expect(()=>parsePartnerFollowupCommand({action:'set_insurance',caseId,commandId,expectedRevision:0})).toThrow('Nepovolená operácia.');
  expect(()=>parsePartnerFollowupCommand({action:'take',caseId:'1',commandId,expectedRevision:0})).toThrow('Neplatný identifikátor.');
  expect(()=>parsePartnerFollowupCommand({action:'contacted',caseId,commandId,expectedRevision:-1})).toThrow('Neplatná revízia.');
  expect(()=>parsePartnerFollowupCommand({action:'contacted',caseId,commandId,expectedRevision:'1'})).toThrow('Neplatná revízia.');
  expect(()=>parsePartnerFollowupCommand({action:'note',caseId,commandId,body:'   '})).toThrow('Poznámka');
  expect(()=>parsePartnerFollowupCommand({action:'note',caseId,commandId,body:'x'.repeat(2001)})).toThrow('Poznámka');
  expect(()=>parsePartnerFollowupCommand(null)).toThrow('Nepovolená operácia.');
 });
 it('treats only a missing RPC as an unavailable follow-up section',()=>{
  expect(isMissingFollowupRpc({code:'PGRST202'})).toBe(true);expect(isMissingFollowupRpc({code:'42883'})).toBe(true);
  expect(isMissingFollowupRpc({code:'42501'})).toBe(false);expect(isMissingFollowupRpc({code:'40001'})).toBe(false);expect(isMissingFollowupRpc(null)).toBe(false);
 });
 it('normalizes the office insurance flag and drops the label when unmarked',()=>{
  expect(parsePartnerInsuranceCommand({commandId,expectedRevision:0,payload:{caseId,insuranceEvent:true,label:' Kasko '}})).toEqual({commandId,expectedRevision:0,payload:{caseId,insuranceEvent:true,label:'Kasko'}});
  expect(parsePartnerInsuranceCommand({commandId,expectedRevision:2,payload:{caseId,insuranceEvent:false,label:'Kasko'}}).payload.label).toBeNull();
  expect(()=>parsePartnerInsuranceCommand({commandId,expectedRevision:0,payload:{caseId,insuranceEvent:'true'}})).toThrow('poistnú udalosť');
  expect(()=>parsePartnerInsuranceCommand({commandId,expectedRevision:0,payload:{caseId,insuranceEvent:true,label:'x'.repeat(81)}})).toThrow('80');
 });
});
describe('partner follow-up period and stats labels',()=>{
 it('maps inclusive Bratislava days to half-open instants across DST',()=>{
  expect(partnerPeriod('2026-10-01','2026-10-31')).toEqual({fromDate:'2026-10-01',toDate:'2026-10-31',from:'2026-09-30T22:00:00.000Z',to:'2026-10-31T23:00:00.000Z'});
  expect(partnerPeriod(null,null,new Date('2026-10-28T23:30:00Z'))).toMatchObject({fromDate:'2026-09-30',toDate:'2026-10-29'});
 });
 it('resolves Bratislava midnight on both DST transition days as from and to',()=>{
  // Spring forward 2026-03-29 (midnight still +01:00), fall back 2026-10-25 (midnight still +02:00).
  expect(partnerPeriod('2026-03-29','2026-03-29')).toMatchObject({from:'2026-03-28T23:00:00.000Z',to:'2026-03-29T22:00:00.000Z'});
  expect(partnerPeriod('2026-03-28','2026-03-28')).toMatchObject({from:'2026-03-27T23:00:00.000Z',to:'2026-03-28T23:00:00.000Z'});
  expect(partnerPeriod('2026-10-25','2026-10-25')).toMatchObject({from:'2026-10-24T22:00:00.000Z',to:'2026-10-25T23:00:00.000Z'});
  expect(partnerPeriod('2026-10-24','2026-10-24')).toMatchObject({from:'2026-10-23T22:00:00.000Z',to:'2026-10-24T22:00:00.000Z'});
 });
 it('rejects reversed, malformed and over-long periods',()=>{
  expect(partnerPeriod('2026-10-02','2026-10-01')).toBeNull();
  expect(partnerPeriod('2026-02-30','2026-03-01')).toBeNull();
  expect(partnerPeriod('2026/10/01','2026-10-02')).toBeNull();
  expect(partnerPeriod('2025-01-01','2026-10-01')).toBeNull();
 });
 it('shows unknown contact time instead of zero and reports the sample',()=>{
  expect(partnerContactTimeLabel({contactMedianMinutes:null,contactSample:0,contactPending:2,contactUnknown:0})).toBe('neznámy (0 meraní) · čaká na kontakt: 2');
  expect(partnerContactTimeLabel({contactMedianMinutes:0,contactSample:1,contactPending:0,contactUnknown:0})).toBe('medián 0 min (1 meranie)');
  expect(partnerContactTimeLabel({contactMedianMinutes:150,contactSample:3,contactPending:1,contactUnknown:1})).toBe('medián 2,5 h (3 merania) · čaká na kontakt: 1 · kontakt bez merateľného času: 1');
 });
});
