import type { MobileDeliveryTrackReceipt } from "@/lib/mobile-api";
import { assertAppEnvironment } from "@/lib/app-environment";
import { mobileEnvironment } from "@/server/mobile/auth";
import { readMobileJsonBody } from "@/server/mobile/body";
import { readTrackerToken, trackDeliveryPositions } from "@/server/mobile/delivery";
import { deliveryUnavailable, mobileDeliveryEnabled } from "@/server/mobile/field-auth";
import { mobileError, mobileJson } from "@/server/mobile/http";
import { MutationError } from "@/server/mutation-error";

export const runtime = "nodejs";
/** Positions the phone sends in the background, identified only by the delivery's
 * secret (no sign-in session): an ended delivery answers `active: false`. */
export async function POST(request: Request) {
  try {
    const token = readTrackerToken(request);
    if (!mobileDeliveryEnabled()) throw deliveryUnavailable();
    assertAppEnvironment();
    if (request.headers.get("x-pm-app-environment") !== mobileEnvironment()) throw new MutationError("Aplikácia je pripojená k nesprávnemu prostrediu.", 409);
    const result = await trackDeliveryPositions(token, await readMobileJsonBody(request));
    const payload: MobileDeliveryTrackReceipt = { ok: true, apiVersion: 1, environment: mobileEnvironment(), ...result };
    return mobileJson(payload);
  } catch (error) { return mobileError(error, "Polohu sa nepodarilo odoslať."); }
}
