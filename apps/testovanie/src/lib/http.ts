import { NextRequest, NextResponse } from "next/server";
import { InputError } from "./validation";
import { cookieName, decodeActor } from "./session";

export function actorFor(request: NextRequest) {
  const actor = decodeActor(request.cookies.get(cookieName)?.value);
  if (!actor) throw new InputError("Najprv zadajte svoje meno.", 401);
  return actor;
}
export function json(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store", Vary: "Cookie" },
  });
}
export async function body(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (
    !origin ||
    origin !== request.nextUrl.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new InputError("Požiadavka musí pochádzať z tejto stránky.", 403);
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new InputError("Očakáva sa JSON.", 415);
  if (Number(request.headers.get("content-length")) > 24_000)
    throw new InputError("Požiadavka je príliš veľká.", 413);
  // Bound streamed/chunked requests as well as requests with Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("Chýba obsah požiadavky.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 24_000) {
      await reader.cancel();
      throw new InputError("Požiadavka je príliš veľká.", 413);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new InputError("Neplatný JSON.");
  }
}
export function failure(error: unknown) {
  if (error instanceof InputError)
    return json({ error: error.message }, error.status);
  console.error(
    "Tracker request failed",
    error instanceof Error ? error.name : "unknown",
  );
  return json(
    {
      error:
        "Spoločné úložisko sa nepodarilo načítať alebo uložiť. Skúste to znova; rozpracovaný text zostáva zachovaný.",
    },
    503,
  );
}
