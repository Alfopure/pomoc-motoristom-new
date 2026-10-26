import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import type { User } from '@supabase/supabase-js';
import type { MotoristActor } from '@/server/api-auth';
import { buildAppUrl, escapeHtml, getEmailConfig, sendEmailWithOutcome } from '@/server/email-delivery';
import { assertRateLimit, requestIp } from '@/server/rate-limit';
import { resolveDefaultOrganizationId } from '@/server/default-organization';
import { MutationError } from '@/server/mutation-error';
import { partnerAdmin, partnerCheck, uuid } from './client';
function validEmail(value:unknown){if(typeof value!=='string'||value.length>254||!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value))throw new MutationError('Vyplňte platný email.',400);return value.trim().toLowerCase();}
export function partnerProvisioningId(organizationId:string,commandId:string){const b=createHash('sha256').update(JSON.stringify(['partner-invite-v1',organizationId.toLowerCase(),commandId.toLowerCase()])).digest();b[6]=(b[6]&15)|128;b[8]=(b[8]&63)|128;const h=b.toString('hex').slice(0,32);return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export function verifyPartnerProvisioning(user:User,userId:string,email:string,intentId:string,payloadHash:string){if(user.id!==userId||user.email?.toLowerCase()!==email||user.app_metadata?.partner_invite?.intentId!==intentId||user.app_metadata?.partner_invite?.payloadHash!==payloadHash)throw new MutationError('Existujúci účet vyžaduje overenie správcom.',409);return user;}
async function membershipRpc(actor:MotoristActor,action:string,payload:Record<string,unknown>){const r=await partnerAdmin().rpc('motorist_partner_membership_command',{p_user_id:actor.userId,p_organization_id:actor.organizationId,p_action:action,p_payload:payload});partnerCheck(r.error);return r.data;}
async function claimAccessEmail(member:{id:string;organization_id:string;auth_user_id:string;email:string;status:string},intentId:string,invitationId:string){
 const db=partnerAdmin();const claimed=await db.from('motorist_partner_email_intents').insert({id:intentId,organization_id:member.organization_id,invitation_id:invitationId,recipient:member.email,document_hash:invitationId}).select('id').maybeSingle();
 if(claimed.error?.code==='23505'){const prior=await db.from('motorist_partner_email_intents').select('organization_id,invitation_id,recipient,status').eq('id',intentId).single();partnerCheck(prior.error);if(prior.data?.organization_id!==member.organization_id||prior.data?.invitation_id!==invitationId||prior.data?.recipient!==member.email)throw new MutationError('Zámer odoslania má iný obsah.',409);return {status:prior.data.status};}partnerCheck(claimed.error);
 let status='failed';let providerMessageId:string|null=null;
 try{if(getEmailConfig().enabled){const next=`/auth/set-password?module=partner&invitation=${invitationId}`;const link=await db.auth.admin.generateLink({type:'recovery',email:member.email,options:{redirectTo:buildAppUrl(`/auth/callback?next=${encodeURIComponent(next)}`)}});
 if(link.error||link.data.user?.id!==member.auth_user_id||!link.data.properties?.action_link)throw new MutationError('Odkaz nie je dostupný.',503);
 const outcome=await sendEmailWithOutcome({to:member.email,subject:'Partnerský prístup — Pomoc Motoristom',html:`<p><a href="${escapeHtml(link.data.properties.action_link)}">Nastaviť heslo a prijať partnerský prístup</a></p>`,text:`Partnerský prístup: ${link.data.properties.action_link}`,idempotencyKey:`partner-access-${intentId}`});
 status=outcome.status==='sent'?'accepted':outcome.status==='unknown'?'unknown':'failed';providerMessageId=outcome.status==='sent'?outcome.messageId:null;}}
 catch{status='unknown';}
 const saved=await db.from('motorist_partner_email_intents').update({status,provider_message_id:providerMessageId}).eq('id',intentId).eq('organization_id',member.organization_id).eq('status','pending');partnerCheck(saved.error);return {status};
}
export async function managePartnerMembership(actor:MotoristActor,input:Record<string,unknown>){
 if(!['admin','manager'].includes(actor.role))throw new MutationError('Prístupy spravuje správca.',403);
 const membershipId=uuid(input.membershipId);const commandId=uuid(input.commandId);const db=partnerAdmin();
 if(input.action==='member_disable')return membershipRpc(actor,'disable',{membershipId,commandId,expectedVersion:input.expectedVersion});
 assertRateLimit(`partner-access:${actor.userId}`,{limit:20,windowMs:3600000});
 if(input.action==='member_reset'){
 // Current office authorization is repeated even if the caller's profile cache is stale.
 const office=await db.from('motorist_profiles').select('id').eq('organization_id',actor.organizationId).eq('user_id',actor.userId).eq('active',true).in('role',['admin','manager']).maybeSingle();partnerCheck(office.error);if(!office.data)throw new MutationError('Prístup bol odobratý.',403);
 const m=await db.from('motorist_partner_memberships').select('*').eq('id',membershipId).eq('organization_id',actor.organizationId).neq('status','disabled').maybeSingle();partnerCheck(m.error);if(!m.data)throw new MutationError('Členstvo nie je dostupné.',404);
 let invitationQuery=db.from('motorist_partner_invitation_intents').select('id').eq('organization_id',actor.organizationId).eq('membership_id',membershipId).in('state',m.data.status==='active'?['accepted']:['invited']); if(m.data.status!=='active')invitationQuery=invitationQuery.gt('expires_at',new Date().toISOString()); const i=await invitationQuery.order('created_at',{ascending:false}).limit(1).maybeSingle();partnerCheck(i.error);if(!i.data)throw new MutationError('Pozvanie expirovalo. Vytvorte nové pozvanie.',409);
 return claimAccessEmail(m.data,commandId,i.data.id);
 }
 if(input.action!=='member_invite')throw new MutationError('Neplatná operácia prístupu.',400);
 const recipient=validEmail(input.email);const partnerId=uuid(input.partnerId);const name=typeof input.displayName==='string'?input.displayName.trim():'';if(!name||name.length>160)throw new MutationError('Vyplňte meno.',400);
 const deterministicId=partnerProvisioningId(actor.organizationId,commandId);
 const previousIntent=await db.from('motorist_partner_invitation_intents').select('auth_user_id').eq('id',commandId).eq('organization_id',actor.organizationId).maybeSingle();partnerCheck(previousIntent.error);
 const previousMember=await db.from('motorist_partner_memberships').select('auth_user_id').eq('id',membershipId).eq('organization_id',actor.organizationId).maybeSingle();partnerCheck(previousMember.error);
 const known=await Promise.all([
  db.from('motorist_profiles').select('user_id').eq('organization_id',actor.organizationId).eq('active',true).eq('email',recipient).maybeSingle(),
  db.from('motorist_towing_memberships').select('auth_user_id').eq('organization_id',actor.organizationId).eq('active',true).eq('email',recipient).maybeSingle(),
 ]);known.forEach(result=>partnerCheck(result.error));
 const candidates=[known[0].data?.user_id,known[1].data?.auth_user_id].filter(Boolean);if(new Set(candidates).size>1)throw new MutationError('Kontakt má rozpornú identitu. Správca musí overiť účet.',409);
 const userId=previousIntent.data?.auth_user_id ?? previousMember.data?.auth_user_id ?? candidates[0] ?? deterministicId;
 const existing=userId!==deterministicId;

 const payload={commandId,membershipId,partnerId,email:recipient,displayName:name,userId,existing};const payloadHash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
 const intent=await membershipRpc(actor,'prepare',{...payload,payloadHash});
 if(!existing){const lookup=await db.auth.admin.getUserById(userId);if(lookup.error&&lookup.error.status!==404)throw new MutationError('Prípravu účtu sa nepodarilo overiť. Zopakujte rovnaký zámer.',503);
 if(lookup.data.user)verifyPartnerProvisioning(lookup.data.user,userId,recipient,commandId,payloadHash);
 else {let created:Awaited<ReturnType<typeof db.auth.admin.createUser>>|undefined;try{created=await db.auth.admin.createUser({id:userId,email:recipient,email_confirm:true,app_metadata:{partner_invite:{intentId:commandId,payloadHash}},user_metadata:{display_name:name}});}catch{/* Recover only deterministic original intent below. */}
 if(created?.data.user)verifyPartnerProvisioning(created.data.user,userId,recipient,commandId,payloadHash);
 else{const recovered=await db.auth.admin.getUserById(userId);if(!recovered.data.user)throw new MutationError('Účet je nepotvrdený. Zopakujte rovnaký zámer alebo overte existujúci účet.',409);verifyPartnerProvisioning(recovered.data.user,userId,recipient,commandId,payloadHash);}}
 }else{const user=await db.auth.admin.getUserById(userId);if(user.error||user.data.user?.email?.toLowerCase()!==recipient)throw new MutationError('Overený účet a email sa nezhodujú.',409);}
 if(intent.state==='revoked')throw new MutationError('Pozvanie bolo odobraté.',403);
 await membershipRpc(actor,'commit',{commandId,membershipId});
 return {ok:true,delivery:await claimAccessEmail({id:membershipId,organization_id:actor.organizationId,auth_user_id:userId,email:recipient,status:'invited'},commandId,commandId)};
}
export async function sendPartnerForgotPassword(value:unknown,request:Request){const email=validEmail(value);assertRateLimit(`partner-forgot:${requestIp(request)}:${createHash('sha256').update(email).digest('hex')}`,{limit:5,windowMs:3600000});const organizationId=await resolveDefaultOrganizationId();const db=partnerAdmin();const m=await db.from('motorist_partner_memberships').select('*').eq('organization_id',organizationId).eq('email',email).eq('status','active').maybeSingle();partnerCheck(m.error);
 if(m.data){const i=await db.from('motorist_partner_invitation_intents').select('id').eq('membership_id',m.data.id).eq('state','accepted').order('created_at',{ascending:false}).limit(1).maybeSingle();partnerCheck(i.error);if(i.data)await claimAccessEmail(m.data,randomUUID(),i.data.id);}
 return {ok:true,message:'Ak má účet aktívny prístup, pošleme odkaz na obnovu hesla.'};}
