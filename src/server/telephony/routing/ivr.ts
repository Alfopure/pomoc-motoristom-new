import type { GatherSpec, IvrMenuRow, IvrOptionRow, MediaRef } from "../state/types";

/**
 * IVR menu engine (pure). See design §2.5 (`ivr` state) and §4 Phase 4.
 *
 * The caller hears the menu prompt, presses one digit and is routed to the
 * option mapped to that digit: a ring plan, an external number, the waiting
 * room, the callback offer or a closing message. Three rules make the menu
 * survivable for the caller:
 *
 * - an unmapped digit re-plays the prompt (`invalid_media_url` first), but only
 *   while the menu's own `max_tries` budget allows it;
 * - silence is not an error: the caller may have a rotary phone or no idea what
 *   to press, so it routes to the line's own ring plan instead of hanging up;
 * - a `repeat` option shares the same budget, so a caller pressing it forever
 *   cannot keep a leg (and a Telnyx charge) alive indefinitely.
 *
 * Telnyx's own `maximum_tries` only re-plays the file when there is *no* input
 * within one `gather_using_audio` (verified against the published Call Control
 * API), so the invalid-digit and repeat loops have to be counted here.
 */

/** Actions a digit can map to (`motorist_ivr_options.action`). */
export const IVR_ACTIONS = ["ring_plan", "callback", "external_number", "waiting_room", "repeat", "hangup"] as const;
export type IvrAction = (typeof IVR_ACTIONS)[number];

/** Digits a DTMF keypad can send; the schema constrains `digit` to exactly one of them. */
export const IVR_DIGITS = "0123456789*#";

export const MIN_IVR_TRIES = 1;
export const MAX_IVR_TRIES = 5;
export const MIN_IVR_TIMEOUT_SECS = 1;
export const MAX_IVR_TIMEOUT_SECS = 30;

export type IvrConfig = { menu: IvrMenuRow; options: IvrOptionRow[] };

/**
 * How the caller's input ended.
 *
 * Telnyx reports `valid | invalid | call_hangup | cancelled | cancelled_amd |
 * timeout`, and the two the menu has to tell apart are `invalid` and
 * `timeout`. `valid_digits` is derived from the menu's own options, so a caller
 * pressing an unmapped key never produces a `valid` gather with an unknown
 * digit — it produces `invalid`. Collapsing that into "nothing pressed" would
 * route a wrong key straight to the ring plan and make the re-prompt
 * unreachable, so the status is carried here explicitly.
 */
export type IvrGatherOutcome = {
  digits: string;
  /** True for Telnyx status `invalid`: a key was pressed and it is not on the menu. */
  invalid?: boolean;
};

export type IvrDecision =
  /** Route to a ring plan; `planId === null` means "the line's own plan". */
  | { kind: "ring_plan"; option: IvrOptionRow; planId: string | null; targetMissing: boolean }
  | { kind: "callback"; option: IvrOptionRow; prompt: MediaRef | null }
  | { kind: "external_number"; option: IvrOptionRow; number: string }
  | { kind: "waiting_room"; option: IvrOptionRow }
  | { kind: "hangup"; option: IvrOptionRow; prompt: MediaRef | null }
  /** Play the menu again; `tries` is the number of prompts played after this one. */
  | { kind: "retry"; tries: number; reason: "invalid_digit" | "repeat" }
  /** No usable choice: fall through to the line's ring plan. */
  | { kind: "default"; reason: "silence" | "tries_exhausted" | "no_options" | "option_incomplete" };

export type IvrDecisionInput = {
  config: IvrConfig | null;
  outcome: IvrGatherOutcome;
  /** Prompts already played, i.e. `metadata.ivr.tries` (1 while the first gather runs). */
  tries: number;
  /** Ring plan ids that could actually be materialised for this call. */
  availablePlanIds: ReadonlySet<string> | readonly string[];
};

// ---------------------------------------------------------------------------
// Menu shape
// ---------------------------------------------------------------------------

/** How many times the menu may be played in total (schema bounds re-applied). */
export function ivrMaxTries(menu: Pick<IvrMenuRow, "max_tries">): number {
  const value = Number.isFinite(menu.max_tries) ? Math.trunc(menu.max_tries) : MIN_IVR_TRIES;
  return Math.min(MAX_IVR_TRIES, Math.max(MIN_IVR_TRIES, value));
}

export function ivrTimeoutSecs(menu: Pick<IvrMenuRow, "timeout_secs">): number {
  const value = Number.isFinite(menu.timeout_secs) ? Math.trunc(menu.timeout_secs) : MIN_IVR_TIMEOUT_SECS;
  return Math.min(MAX_IVR_TIMEOUT_SECS, Math.max(MIN_IVR_TIMEOUT_SECS, value));
}

/** Digits Telnyx should accept; empty when the menu has no options (the caller cannot choose anything). */
export function ivrValidDigits(options: readonly IvrOptionRow[]): string {
  const digits = new Set<string>();
  for (const option of options) {
    const digit = option.digit?.trim();
    if (digit && digit.length === 1 && IVR_DIGITS.includes(digit)) digits.add(digit);
  }
  return [...digits].join("");
}

/**
 * The gather that plays the menu.
 *
 * The recorded prompt wins whenever the menu has one; speech is the fallback
 * for a menu whose prompt was never recorded (`effects.ts` picks
 * `gather_using_speak` when the media reference resolves to no URL). A menu
 * with neither is played with the shipped Slovak main-menu recording rather
 * than in silence.
 */
export function ivrGatherSpec(config: IvrConfig): GatherSpec {
  const { menu, options } = config;
  const media: MediaRef | null = menu.prompt_media_url ? { file: menu.prompt_media_url } : menu.tts_text ? null : { key: "ivrMain" };
  const validDigits = ivrValidDigits(options);
  return {
    media,
    invalidMedia: menu.invalid_media_url ? { file: menu.invalid_media_url } : { key: "invalidInput" },
    ttsText: menu.tts_text,
    purpose: "ivr",
    // No options → nothing is a valid choice; the gather then just times out and
    // the caller falls through to the ring plan instead of pressing into a void.
    validDigits: validDigits || IVR_DIGITS,
    maximumDigits: 1,
    minimumDigits: 1,
    // Telnyx re-plays the file inside one gather only while the caller stays
    // silent (`maximum_tries`); an unmapped digit ends the gather and the
    // re-prompt is issued by `decideIvr`, against the same budget. Worst case
    // the caller hears the menu `max_tries` times per round and at most
    // `max_tries` rounds — bounded, and the same number in both places.
    maximumTries: ivrMaxTries(menu),
    timeoutMillis: ivrTimeoutSecs(menu) * 1000,
  };
}

/** The option the caller's digits map to, or `null`. */
export function findIvrOption(options: readonly IvrOptionRow[], digits: string): IvrOptionRow | null {
  const pressed = digits.trim();
  if (!pressed) return null;
  return options.find((option) => option.digit === pressed) ?? null;
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

function promptOf(option: IvrOptionRow, fallback: MediaRef | null): MediaRef | null {
  return option.prompt_media_url ? { file: option.prompt_media_url } : fallback;
}

/**
 * Maps one `call.gather.ended` onto the next routing step.
 *
 * `tries` counts the prompts already played, so the check is "may we play
 * another one": with the seeded `max_tries: 2` the caller hears the menu twice
 * and the second invalid digit falls through to the ring plan.
 */
export function decideIvr(input: IvrDecisionInput): IvrDecision {
  const config = input.config;
  if (!config || config.options.length === 0) return { kind: "default", reason: "no_options" };

  const digits = input.outcome.digits.trim();
  const mayRetry = input.tries < ivrMaxTries(config.menu);
  const option = digits ? findIvrOption(config.options, digits) : null;

  // A key that is not on the menu: re-play it while the budget allows. Telnyx's
  // own `invalid` status is authoritative here (it compares against the same
  // `valid_digits` the menu produced), and a digit with no option row is the
  // same case for anything that reaches this function without a status.
  if (input.outcome.invalid || (digits && !option)) {
    return mayRetry ? { kind: "retry", tries: input.tries + 1, reason: "invalid_digit" } : { kind: "default", reason: "tries_exhausted" };
  }

  if (!option) return { kind: "default", reason: "silence" };

  switch (option.action as IvrAction) {
    case "ring_plan": {
      const planIds = input.availablePlanIds instanceof Set ? input.availablePlanIds : new Set(input.availablePlanIds);
      const targetId = option.target_ring_plan_id;
      // The plan the digit points at can be gone (deleted, switched off, or with
      // no reachable member): the caller must still reach somebody, so the call
      // falls back to the line's own plan and the transition says so.
      if (!targetId || !planIds.has(targetId)) return { kind: "ring_plan", option, planId: null, targetMissing: Boolean(targetId) };
      return { kind: "ring_plan", option, planId: targetId, targetMissing: false };
    }
    case "callback":
      return { kind: "callback", option, prompt: promptOf(option, { key: "callbackConfirmed" }) };
    case "external_number": {
      const number = option.target_number?.trim();
      if (!number) return { kind: "default", reason: "option_incomplete" };
      return { kind: "external_number", option, number };
    }
    case "waiting_room":
      return { kind: "waiting_room", option };
    case "repeat":
      return mayRetry ? { kind: "retry", tries: input.tries + 1, reason: "repeat" } : { kind: "default", reason: "tries_exhausted" };
    case "hangup":
      return { kind: "hangup", option, prompt: promptOf(option, null) };
    default:
      // An action the engine does not know (a newer row than this deployment):
      // routing to the line's plan is the only safe reading.
      return { kind: "default", reason: "option_incomplete" };
  }
}

/** Short note for the transition log (`motorist_call_events.normalized_payload`, never shown to a user). */
export function describeIvrDecision(decision: IvrDecision): string {
  switch (decision.kind) {
    case "ring_plan":
      return decision.targetMissing
        ? `IVR ${decision.option.digit}: target plan is gone → line plan`
        : `IVR ${decision.option.digit}: ${decision.option.label} → ring plan`;
    case "callback":
      return `IVR ${decision.option.digit}: ${decision.option.label} → callback`;
    case "external_number":
      return `IVR ${decision.option.digit}: ${decision.option.label} → ${decision.number}`;
    case "waiting_room":
      return `IVR ${decision.option.digit}: ${decision.option.label} → waiting room`;
    case "hangup":
      return `IVR ${decision.option.digit}: ${decision.option.label} → closing message`;
    case "retry":
      return decision.reason === "repeat" ? `IVR: repeat requested (prompt ${decision.tries})` : `IVR: invalid digit, prompt ${decision.tries}`;
    case "default":
      return `IVR: no choice (${decision.reason}) → line plan`;
  }
}
