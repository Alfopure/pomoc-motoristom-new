import { downloadOperationFile, uploadOperationFile } from '@/server/operations/files';
import { assertTowingOrigin, towingErrorResponse, towingJson, uuid } from '@/server/towing/http';
type Context = { params: Promise<{ id: string }> };
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: Context) {
  try { return await downloadOperationFile(uuid((await context.params).id), new URL(request.url).searchParams.get('reference') ?? ''); }
  catch (error) { return towingErrorResponse(error); }
}

export async function POST(request: Request, context: Context) {
  try { assertTowingOrigin(request); return towingJson(await uploadOperationFile(uuid((await context.params).id), request), 201); }
  catch (error) { return towingErrorResponse(error); }
}
