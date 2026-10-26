import { MutationError } from '@/server/mutation-error';
import { assertSameOriginRequest, requireDefaultMotoristActor } from '@/server/api-auth';
import { requirePartnerActor } from '@/server/partners/auth';
import { partnerResponse } from '@/server/partners/client';
import { partnerCommand, PARTNER_OFFICE_ROLES, readPartnerOffice, readPartnerOutputs, readPartnerOrigin } from '@/server/partners/service';
import { managePartnerMembership } from '@/server/partners/memberships';
import { emailPartnerOutput } from '@/server/partners/documents';
export const runtime='nodejs';
export async function GET(request:Request){try{const params=new URL(request.url).searchParams;
 if(params.get('portal')==='true')return Response.json({outputs:await readPartnerOutputs(await requirePartnerActor())},{headers:{'Cache-Control':'private, no-store'}});
 const actor=await requireDefaultMotoristActor(PARTNER_OFFICE_ROLES);if(params.get('origin')==='true')return Response.json({origin:await readPartnerOrigin(actor,params.get('lineId'))},{headers:{'Cache-Control':'private, no-store'}});return Response.json(await readPartnerOffice(actor,params.get('caseId'),params.get('lineId')),{headers:{'Cache-Control':'private, no-store'}});
}catch(error){return partnerResponse(error);}}
export async function POST(request:Request){try{assertSameOriginRequest(request);const actor=await requireDefaultMotoristActor(PARTNER_OFFICE_ROLES);const input=await request.json();
 if(['email_intent','email_result'].includes(input.action))throw new MutationError('Interná operácia nie je dostupná.',403);
 const result=input.action?.startsWith('member_')?await managePartnerMembership(actor,input):input.action==='email_output'?await emailPartnerOutput(actor,input):await partnerCommand(actor,input);
 return Response.json(result,{headers:{'Cache-Control':'private, no-store'}});
}catch(error){return partnerResponse(error);}}
