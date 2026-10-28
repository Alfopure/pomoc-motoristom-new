import { assertSameOriginRequest } from '@/server/api-auth';
import { requirePartnerActor } from '@/server/partners/auth';
import { partnerResponse } from '@/server/partners/client';
import { partnerFollowupCommand, readPartnerPortal } from '@/server/partners/followups';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
export async function GET(request:Request){try{const params=new URL(request.url).searchParams;return Response.json(await readPartnerPortal(await requirePartnerActor(),params.get('from'),params.get('to')),{headers});}catch(error){return partnerResponse(error);}}
export async function POST(request:Request){try{assertSameOriginRequest(request);const actor=await requirePartnerActor();return Response.json(await partnerFollowupCommand(actor,await request.json()),{headers});}catch(error){return partnerResponse(error);}}
