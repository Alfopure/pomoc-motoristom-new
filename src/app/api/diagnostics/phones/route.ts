import { readDiagnosticPhoneStatus } from '@/server/diagnostics/phone-status';
import { runDiagnosticEndpoint } from '@/server/diagnostics/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() { return runDiagnosticEndpoint(readDiagnosticPhoneStatus); }
