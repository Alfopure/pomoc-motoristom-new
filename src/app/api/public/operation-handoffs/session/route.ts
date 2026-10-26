import { operationGrantError, operationGrantJson, publicOperationGrant } from '@/server/operations/grants';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try { return operationGrantJson(await publicOperationGrant(request, 'session')); } catch (error) { return operationGrantError(error); }
}
