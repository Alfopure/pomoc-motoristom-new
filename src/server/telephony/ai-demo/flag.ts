/**
 * The only AI-demo module the Telnyx webhook hot path may import statically.
 *
 * `webhook-import-graph.test.ts` caps that path at 53 modules, and everything
 * else in `ai-demo/` is loaded with `await import()` from inside the branch so
 * a deployment with the demo switched off pays nothing for it. Keep this file
 * dependency-free.
 */

export const AI_DEMO_INTENT_PREFIX = "ai_demo:";

export type AiDemoLeg = "sip" | "mobile";

/** `sip` / `mobile` for one of our own demo legs, otherwise `null`. */
export function aiDemoLegOf(intent: string | null | undefined): AiDemoLeg | null {
  if (typeof intent !== "string" || !intent.startsWith(AI_DEMO_INTENT_PREFIX)) return null;
  const leg = intent.slice(AI_DEMO_INTENT_PREFIX.length);
  return leg === "sip" || leg === "mobile" ? leg : null;
}

/** `true` when the environment explicitly opts in; anything else is off. */
export function aiDemoEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AI_DEMO_ENABLED?.trim().toLowerCase() === "true";
}
