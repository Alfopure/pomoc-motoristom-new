import { handleAiDemoRead, handleAiDemoWrite } from "@/server/telephony/ai-demo/http";
import {
  AI_DEMO_INTRO_CUSTOM_MAX_CHARS, AI_DEMO_NAME_MAX_CHARS, AI_DEMO_NAME_MIN_CHARS,
  AI_DEMO_STANDING_RULES_MAX_CHARS, readAgentSettings, validateAgentPatch, writeAgentSettings,
} from "@/server/telephony/ai-demo/agent-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * How the assistant behaves. Admin only, reads included — "who may see what she
 * is allowed to do" is the same question as "who may change it".
 *
 * The limits travel with the payload so the panel can show a character counter
 * that agrees with the server instead of hard-coding its own number.
 */
const LIMITS = {
  nameMin: AI_DEMO_NAME_MIN_CHARS,
  nameMax: AI_DEMO_NAME_MAX_CHARS,
  introCustomMax: AI_DEMO_INTRO_CUSTOM_MAX_CHARS,
  standingRulesMax: AI_DEMO_STANDING_RULES_MAX_CHARS,
} as const;

export async function GET() {
  return handleAiDemoRead(async ({ deps }) => {
    const settings = await readAgentSettings(deps);
    return Response.json({ settings, limits: LIMITS }, { headers: { "Cache-Control": "private, no-store" } });
  }, "Nastavenia sa nepodarilo načítať.");
}

export async function PATCH(request: Request) {
  return handleAiDemoWrite(request, async ({ deps, body }) => {
    const patch = validateAgentPatch(body);
    const settings = await writeAgentSettings(deps, patch);
    return Response.json({ settings, limits: LIMITS });
  }, "Nastavenia sa nepodarilo uložiť.");
}
