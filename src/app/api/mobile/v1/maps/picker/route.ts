import { requireMobileActor } from "@/server/mobile/auth";
import { mobileError } from "@/server/mobile/http";
import { mobileMapPicker } from "@/server/mobile/map-picker";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const actor = await requireMobileActor(request);
    return await mobileMapPicker(request, actor);
  } catch (error) {
    return mobileError(error, "Mapu sa nepodarilo načítať. Adresu môžete naďalej zadať ručne.");
  }
}
