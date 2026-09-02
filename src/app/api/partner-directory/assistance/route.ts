import { loadDispatchData } from "@/data/dispatch-repository";
import { motoristAccessGuard, requireMotoristOrgMember } from "@/server/api-auth";
import { createPartnerDirectoryEntry, MutationError } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const denied = await motoristAccessGuard({ request });
  if (denied) return denied;

  try {
    const body = (await request.json()) as { name?: unknown };
    await createPartnerDirectoryEntry(
      {
        active: true,
        kind: "assistance",
        name: typeof body.name === "string" ? body.name : "",
      },
      (organizationId) => requireMotoristOrgMember(organizationId),
    );
    const dispatchData = await loadDispatchData();

    return Response.json({ dispatchData });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json({ error: error.message }, { status: error.status });
    }

    console.error("Assistance directory quick-add failed:", error);
    return Response.json({ error: "Asistenčnú službu sa nepodarilo uložiť." }, { status: 500 });
  }
}
