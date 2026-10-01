import { runDiagnosticEndpoint, ingestDiagnostics } from '@/server/diagnostics/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(request:Request){return runDiagnosticEndpoint(() => ingestDiagnostics(request));}
