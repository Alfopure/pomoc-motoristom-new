import { assertSameOriginRequest, requireDefaultMotoristActor } from "@/server/api-auth";
import { MutationError } from "@/server/motorist-mutations";
import { listTelephonyExtensionAssignments, setTelephonyExtensionAssignment } from "@/server/telephony-extensions";
import { assertTelephonyLiveMutationEnabled } from "@/server/telephony/live-mutation-gate";

export const runtime = "nodejs";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

type AssignmentBody = {
  extensionId?: unknown;
  initialProvisioningAttested?: unknown;
  profileId?: unknown;
  rotationAttested?: unknown;
  rotationReference?: unknown;
};

export async function GET() {
  try {
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    const extensions = await listTelephonyExtensionAssignments(actor);

    return Response.json(
      {
        ok: true,
        actorProfileId: actor.profileId,
        extensions,
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json(
        { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }

    return Response.json(
      { ok: false, error: "Priradenia klapiek sa nepodarilo načítať." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    assertSameOriginRequest(request);
    const actor = await requireDefaultMotoristActor(["manager", "admin"]);
    assertTelephonyLiveMutationEnabled("extension.assignment.update");
    const body = (await request.json().catch(() => null)) as AssignmentBody | null;

    if (!body) {
      throw new MutationError("Údaje priradenia sú povinné.", 400);
    }

    const assignment = await setTelephonyExtensionAssignment(
      actor,
      body.extensionId,
      body.profileId,
      body.rotationReference,
      body.rotationAttested,
      body.initialProvisioningAttested,
    );
    return Response.json({ ok: true, assignment }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof MutationError) {
      return Response.json(
        { ok: false, error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status, headers: NO_STORE_HEADERS },
      );
    }

    return Response.json(
      { ok: false, error: "Priradenie klapky sa nepodarilo uložiť." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
