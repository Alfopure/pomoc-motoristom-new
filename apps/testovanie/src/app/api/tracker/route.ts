import { NextRequest } from "next/server";
import { actorFor, body, failure, json } from "@/lib/http";
import { InputError, parseCommand, record } from "@/lib/validation";
import { mutate, repository } from "@/lib/repository";
import { applyCommand } from "@/lib/service";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const actor = actorFor(request);
    const snapshot = await repository().read();
    const known = request.nextUrl.searchParams.get("revision");
    if (known !== null && Number(known) === snapshot.value.revision)
      return json({
        unchanged: true,
        revision: snapshot.value.revision,
        actor,
      });
    return json({ store: snapshot.value, actor });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    const actor = actorFor(request);
    const input = record(await body(request));
    if (input.actorId !== actor.id)
      throw new InputError(
        "V inom okne sa zmenilo meno testera. Obnovte prehľad a skontrolujte meno pred uložením.",
        409,
      );
    const command = parseCommand(input);
    const store = await mutate(repository(), (current) =>
      applyCommand(current, command, actor),
    );
    return json({ store, actor, requestId: command.requestId });
  } catch (error) {
    return failure(error);
  }
}
