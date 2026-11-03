import { operationGrantError, operationGrantJson, publicOperationGrant } from '@/server/operations/grants';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return operationGrantJson(await publicOperationGrant(request, 'read')); } catch (error) { return operationGrantError(error); }
}
