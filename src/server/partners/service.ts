import 'server-only';
import type { MotoristActor } from '@/server/api-auth';
import type { PartnerActor, PartnerOutput } from '@/domain/partners';
import { partnerAdmin, partnerCheck, uuid } from './client';
import { MutationError } from '@/server/mutation-error';
export const PARTNER_OFFICE_ROLES: MotoristActor['role'][] = ['dispatcher','senior_dispatcher','manager','admin'];
export async function assertPartnerOffice(actor: MotoristActor) {
 const result=await partnerAdmin().from('motorist_profiles').select('id').eq('user_id',actor.userId).eq('organization_id',actor.organizationId).eq('active',true).in('role',PARTNER_OFFICE_ROLES).maybeSingle(); partnerCheck(result.error);
 if (!result.data) throw new MutationError('Partnerské záznamy nie sú dostupné.',403);
}
export async function partnerCommand(actor: MotoristActor, input: Record<string,unknown>) {
 const result=await partnerAdmin().rpc('motorist_partner_command',{p_user_id:actor.userId,p_organization_id:actor.organizationId,p_command_id:uuid(input.commandId),p_expected_revision:input.expectedRevision ?? 0,p_action:input.action,p_payload:input.payload}); partnerCheck(result.error); return result.data;
}
export async function readPartnerOffice(actor:MotoristActor,caseId?:string|null,lineId?:string|null) {
 await assertPartnerOffice(actor); const db=partnerAdmin();
 const results=await Promise.all([
  db.from('motorist_partner_directory').select('id,name').eq('organization_id',actor.organizationId).eq('active',true).order('name'),
  db.from('motorist_telephony_lines').select('id,label,phone_number').eq('organization_id',actor.organizationId).eq('active',true),
  db.from('motorist_partner_line_origins').select('*').eq('organization_id',actor.organizationId),
  db.from('motorist_partner_case_contexts').select('*').eq('organization_id',actor.organizationId).order('updated_at',{ascending:false}).limit(100),
  db.from('motorist_partner_memberships').select('id,partner_id,display_name,email,status,membership_version').eq('organization_id',actor.organizationId),
  db.rpc('motorist_partner_report',{p_user_id:actor.userId,p_organization_id:actor.organizationId}),
 ]); results.forEach(r=>partnerCheck(r.error));
 let detail=null;
 if(caseId){uuid(caseId); const queries=await Promise.all([
  db.from('motorist_partner_case_contexts').select('*').eq('organization_id',actor.organizationId).eq('case_id',caseId).maybeSingle(),
  db.from('motorist_partner_case_links').select('id,parent_case_id,child_case_id').eq('organization_id',actor.organizationId).or(`parent_case_id.eq.${caseId},child_case_id.eq.${caseId}`),
  db.from('motorist_partner_outputs').select('snapshot').eq('organization_id',actor.organizationId).eq('case_id',caseId).order('version',{ascending:false}),
  db.from('motorist_partner_shares').select('output_id,revoked_at').eq('organization_id',actor.organizationId),
  db.from('motorist_partner_email_intents').select('output_id,status,created_at').eq('organization_id',actor.organizationId).not('output_id','is',null).order('created_at',{ascending:false}).limit(100),
 ]); queries.forEach(r=>partnerCheck(r.error)); detail={context:queries[0].data,links:queries[1].data,outputs:queries[2].data?.map(row=>({...row.snapshot,revoked:queries[3].data?.some(s=>s.output_id===row.snapshot.id&&s.revoked_at),emailStatus:queries[4].data?.find(e=>e.output_id===row.snapshot.id)?.status??null}))};}
 return {partners:results[0].data,lines:results[1].data,mappings:results[2].data,consultations:results[3].data,members:results[4].data,report:results[5].data,origin:lineId?results[2].data?.find(m=>m.line_id===lineId):null,detail};
}
export async function readPartnerOutputs(actor:PartnerActor,outputId?:string):Promise<PartnerOutput[]> {
 const result=await partnerAdmin().rpc('motorist_partner_read',{p_user_id:actor.userId,p_organization_id:actor.organizationId,p_membership_version:actor.version,p_output_id:outputId?uuid(outputId):null}); partnerCheck(result.error); return result.data as PartnerOutput[];
}
export async function readOfficeOutput(actor:MotoristActor,outputId:string):Promise<PartnerOutput> {
 await assertPartnerOffice(actor); const result=await partnerAdmin().from('motorist_partner_outputs').select('snapshot').eq('organization_id',actor.organizationId).eq('id',uuid(outputId)).maybeSingle();partnerCheck(result.error);
 const share=await partnerAdmin().from('motorist_partner_shares').select('output_id').eq('organization_id',actor.organizationId).eq('output_id',outputId).is('revoked_at',null).maybeSingle();partnerCheck(share.error);
 if(!result.data || !share.data)throw new MutationError('Výstup nie je dostupný.',404); return result.data.snapshot as PartnerOutput;
}

export async function readPartnerOrigin(actor:MotoristActor,lineId:string|null){await assertPartnerOffice(actor);if(!lineId)return null;const result=await partnerAdmin().from('motorist_partner_line_origins').select('line_id,partner_id,revision').eq('organization_id',actor.organizationId).eq('line_id',uuid(lineId)).maybeSingle();partnerCheck(result.error);return result.data;}
