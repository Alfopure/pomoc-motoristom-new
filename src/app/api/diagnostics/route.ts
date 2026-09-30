import { runDiagnosticEndpoint, readDiagnostics } from '@/server/diagnostics/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request:Request){return runDiagnosticEndpoint(() => readDiagnostics(request));}
