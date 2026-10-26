import { requireDefaultMotoristActor } from '@/server/api-auth';
import { requirePartnerActor } from '@/server/partners/auth';
import { partnerResponse } from '@/server/partners/client';
import { partnerPdf, renderPartnerOutput } from '@/server/partners/documents';
import { PARTNER_OFFICE_ROLES, readOfficeOutput, readPartnerOutputs } from '@/server/partners/service';
export const runtime='nodejs';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){try{const {id}=await params;const query=new URL(request.url).searchParams;let output,organizationId;
 if(query.get('portal')==='true'){const actor=await requirePartnerActor();organizationId=actor.organizationId;[output]=await readPartnerOutputs(actor,id);}else{const actor=await requireDefaultMotoristActor(PARTNER_OFFICE_ROLES);organizationId=actor.organizationId;output=await readOfficeOutput(actor,id);}
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'"};
 if(query.get('preview')==='true')return new Response(renderPartnerOutput(output),{headers:{...headers,'Content-Type':'text/html; charset=utf-8'}});
 const bytes=await partnerPdf(organizationId,output);
 // Repeat authorization after potentially slow rendering before releasing bytes.
 if(query.get('portal')==='true')await readPartnerOutputs(await requirePartnerActor(),id);else await readOfficeOutput(await requireDefaultMotoristActor(PARTNER_OFFICE_ROLES),id);
 return new Response(new Uint8Array(bytes),{headers:{...headers,'Content-Type':'application/pdf','Content-Disposition':`inline; filename="vystup-${output.version}.pdf"`}});
}catch(error){return partnerResponse(error);}}
export const maxDuration = 60;
