import { handleAiDemoRead, handleAiDemoWrite } from "@/server/telephony/ai-demo/http";
import {
  AI_DEMO_INTRO_CUSTOM_MAX_CHARS, AI_DEMO_NAME_MAX_CHARS, AI_DEMO_NAME_MIN_CHARS,
  AI_DEMO_STANDING_RULES_MAX_CHARS, assertCoherentSettings, mergeAgentSettings, readAgentSettings,
  validateAgentPatch, writeAgentSettings,
} from "@/server/telephony/ai-demo/agent-settings";
import { AI_DEMO_ALLOWED_VOICES, AI_DEMO_NATURAL_VOICES } from "@/server/telephony/ai-demo/config";

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

/** The panel renders these; sending them keeps the client off the server-only config. */
const VOICES = { all: AI_DEMO_ALLOWED_VOICES, natural: AI_DEMO_NATURAL_VOICES } as const;

export async function GET() {
  return handleAiDemoRead(async ({ deps }) => {
    const settings = await readAgentSettings(deps);
    return Response.json({ settings, limits: LIMITS, voices: VOICES }, { headers: { "Cache-Control": "private, no-store" } });
  }, "Nastavenia sa nepodarilo načítať.");
}

export async function PATCH(request: Request) {
  return handleAiDemoWrite(request, async ({ deps, body }) => {
    const patch = validateAgentPatch(body);
    // Cross-field rules need the row as it will be, not the fragment that came in.
    assertCoherentSettings(mergeAgentSettings(await readAgentSettings(deps), patch));
    const settings = await writeAgentSettings(deps, patch);
    return Response.json({ settings, limits: LIMITS, voices: VOICES });
  }, "Nastavenia sa nepodarilo uložiť.");
}
