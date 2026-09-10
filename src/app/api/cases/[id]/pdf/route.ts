import { requireDefaultMotoristActor } from "@/server/api-auth";
import { generateCasePdf, loadCasePdfSnapshot } from "@/server/case-pdf";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
export const maxDuration = 60;
const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireDefaultMotoristActor(["dispatcher", "senior_dispatcher", "manager", "admin"]);
    const { id } = await params;
    const snapshot = await loadCasePdfSnapshot(actor, id);
    const pdf = await generateCasePdf(snapshot);
    const name = `${snapshot.case.case_number.replace(/[^a-zA-Z0-9._-]/g, "_")}.pdf`;
    return new Response(new Uint8Array(pdf), { headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "X-Content-Type-Options": "nosniff" } });
  } catch (error) {
    return Response.json({ error: error instanceof MutationError ? error.message : "PDF sa nepodarilo vytvoriť. Údaje prípadu zostali uložené." }, { status: error instanceof MutationError ? error.status : 503, headers });
  }
}
