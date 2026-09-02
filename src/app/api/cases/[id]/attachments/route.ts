import { loadDispatchData } from "@/data/dispatch-repository";
import { motoristAccessGuard, requireMotoristOrgMember } from "@/server/api-auth";
import { createCaseAttachmentSignedUrl, MutationError, uploadCaseAttachments } from "@/server/motorist-mutations";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await motoristAccessGuard({ request });
  if (denied) return denied;

  try {
    const { id } = await params;
    const formData = await request.formData();
    const files = formData.getAll("files").filter((item): item is File => item instanceof File);
    const note = stringFormValue(formData.get("note"));

    const attachments = await uploadCaseAttachments(id, files, note, requireMotoristOrgMember);
    const dispatchData = await loadDispatchData();

    return Response.json({ caseId: id, attachments, dispatchData });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await motoristAccessGuard();
  if (denied) return denied;

  try {
    const { id } = await params;
    const attachmentId = new URL(request.url).searchParams.get("attachmentId") ?? "";
    const link = await createCaseAttachmentSignedUrl(id, attachmentId, requireMotoristOrgMember);

    return Response.json(link);
  } catch (error) {
    return mutationErrorResponse(error);
  }
}

function stringFormValue(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mutationErrorResponse(error: unknown) {
  if (error instanceof MutationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  console.error("Case attachment mutation failed:", error);
  return Response.json({ error: "Prílohu sa nepodarilo spracovať." }, { status: 500 });
}
