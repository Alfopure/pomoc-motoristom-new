import type { CreateBranchInput } from "@/data/case-inputs";
import { loadDispatchData } from "@/data/dispatch-repository";
import { createBranch, MutationError } from "@/server/motorist-mutations";
import { assertSameOriginRequest, requireDefaultMotoristOrgRole } from "@/server/api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOriginRequest(request);
    await requireDefaultMotoristOrgRole(["manager", "admin"]);
    const input = (await request.json()) as CreateBranchInput;
    const branch = await createBranch(input);
    const dispatchData = await loadDispatchData();

    return Response.json({ branchId: branch.id, dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Branch mutation failed:", error);
    return Response.json({ error: "Pobočku sa nepodarilo uložiť." }, { status: 500 });
  }
}
