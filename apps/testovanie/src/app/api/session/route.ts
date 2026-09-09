import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { body, failure, json } from "@/lib/http";
import {
  cookieName,
  decodeActor,
  encodeActor,
  sessionSeconds,
} from "@/lib/session";
import { record, text } from "@/lib/validation";
import { mutate, repository } from "@/lib/repository";
import { applyCommand } from "@/lib/service";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    return json({ actor: decodeActor(request.cookies.get(cookieName)?.value) });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: NextRequest) {
  try {
    const input = record(await body(request));
    const name = text(input.name, "Meno", 80, 2).replace(/\s+/g, " ");
    const actor = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
    };
    const cookie = encodeActor(actor);
    await mutate(repository(), (store) =>
      applyCommand(store, { kind: "entry", requestId: actor.id }, actor),
    );
    const response = json({ actor });
    response.cookies.set(cookieName, cookie, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "strict",
      path: "/",
      maxAge: sessionSeconds,
    });
    return response;
  } catch (error) {
    return failure(error);
  }
}
