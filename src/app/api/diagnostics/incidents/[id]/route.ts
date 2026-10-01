import { runDiagnosticEndpoint, readDiagnostics, updateDiagnosticStatus } from '@/server/diagnostics/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request:Request,context:{params:Promise<{id:string}>}){const {id}=await context.params;return runDiagnosticEndpoint(()=>readDiagnostics(request,id));}
export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){const {id}=await context.params;return runDiagnosticEndpoint(()=>updateDiagnosticStatus(request,id));}
