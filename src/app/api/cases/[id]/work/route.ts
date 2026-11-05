import { commandCaseWork, getCaseWorkContext } from "@/server/case-work";
import { handoffError } from "@/server/case-handoff";
import { MutationError } from "@/server/mutation-error";
import {
  assertTowingOrigin,
  boundedJson,
  towingErrorResponse,
  towingJson,
} from "@/server/towing/http";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
function failure(error: unknown) {
  return error instanceof MutationError
    ? handoffError(error)
    : towingErrorResponse(error);
}
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    return towingJson(await getCaseWorkContext((await params).id));
  } catch (e) {
    return failure(e);
  }
}
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    assertTowingOrigin(request);
    return towingJson(
      await commandCaseWork(
        (await params).id,
        await boundedJson(request, 80_000),
      ),
    );
  } catch (e) {
    return failure(e);
  }
}
