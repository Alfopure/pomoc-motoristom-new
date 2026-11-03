import { describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';
vi.mock('server-only',()=>({}));
import { partnerProvisioningId, verifyPartnerProvisioning } from './memberships';
import { renderPartnerOutput } from './documents';
import type { PartnerOutput } from '@/domain/partners';
describe('partner access provisioning provenance',()=>{
 it('recovers only the original deterministic intent and normalizes UUID casing',()=>{
  const id=partnerProvisioningId('A0000000-0000-4000-8000-000000000001','B0000000-0000-4000-8000-000000000001');
  expect(id).toBe(partnerProvisioningId('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001'));
  expect(id).not.toBe(partnerProvisioningId('a0000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000002'));
  const user={id,email:'test@example.invalid',app_metadata:{partner_invite:{intentId:'original',payloadHash:'hash'}}} as unknown as User;
  expect(verifyPartnerProvisioning(user,id,'test@example.invalid','original','hash')).toBe(user);
  expect(()=>verifyPartnerProvisioning(user,id,'test@example.invalid','different','hash')).toThrow();
  expect(()=>verifyPartnerProvisioning({...user,app_metadata:{}} as User,id,'test@example.invalid','original','hash')).toThrow();
 });
 it('escapes explicit published content in the isolated output template',()=>{
  const output={id:'x',title:'<img src=x>',result:'<script>alert(1)</script>',partnerName:'Partner',caseNumber:'C1',recipient:'test@example.invalid',publishedAt:'2026-10-26',hash:'hash',version:1} as PartnerOutput;
  const rendered=renderPartnerOutput(output);
  expect(rendered).toContain('&lt;script&gt;');expect(rendered).not.toContain('<script>');expect(rendered).not.toContain('<img');
 });
});
