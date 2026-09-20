import "server-only";

import type { CallerCase } from "./caller-case";
import { describeAfterVerification } from "./caller-case";
import type { TranscriptEntry } from "./greeting";
import { normalizePlate, plateCandidates, speechMatchesPlate } from "./plate";

/**
 * The plate gate, as a small machine fed by the transcript.
 *
 * It is deliberately not a tool the model can call. The listener hands it what
 * the caller said; it compares server-side and, only on a match, produces the
 * sentence that unlocks the case. Until then the model has never been told
 * anything to leak.
 *
 * It also decides nothing about *when* she asks — that is in her instructions.
 * This only watches for an answer.
 */

export type VerificationState = "waiting" | "verified" | "exhausted";

export type VerificationOutcome = {
  state: VerificationState;
  /** Sent through `session.instructions.append`, or null when nothing changed. */
  instruction: string | null;
  /** True on the transition that used up an attempt, so the caller can be counted once. */
  attemptSpent: boolean;
};

export type VerificationLimits = {
  /** Attempts per case per day, shared across calls. */
  maxAttempts: number;
};

export const VERIFICATION_DEFAULTS: VerificationLimits = { maxAttempts: 3 };

/**
 * How much of the caller's speech is kept for matching.
 *
 * Long enough to hold a plate spelled out one character at a time with filler
 * around it; short enough that two different plates said minutes apart cannot
 * be spliced into a third.
 */
const WINDOW_CHARS = 120;

/**
 * Anything that looks like an attempt at an answer.
 *
 * Without this every "áno", "prosím" and "moment" would burn an attempt and a
 * caller would be locked out by politeness. A plate has at least four letters
 * and digits together, so that is the bar for having tried.
 */
/**
 * The letter/digit silhouette of a plate: "BL123AB" becomes "LLDDDLL".
 *
 * Comparing silhouettes rather than a fixed pattern is what makes the counter
 * work for a plate this office has never seen. An earlier version hard-coded
 * the Slovak two-three-two shape, so a four-digit or foreign plate matched
 * nothing, no guess was ever charged, and the gate could be hammered forever.
 */
function silhouette(text: string): string {
  return normalizePlate(text).replace(/[A-Z]/g, "L").replace(/[0-9]/g, "D");
}

/**
 * Whether a run of characters is a plausible guess at *this* plate.
 *
 * It has to look like the thing on file — same silhouette — which is narrow
 * enough that ordinary speech never qualifies. Earlier attempts at this test
 * asked for four letters (so "prosím" was a wrong plate) and then for any
 * digit (so "o 15 minút" was too), and both spent the caller's tries on
 * nothing.
 */
export function looksLikePlateShaped(text: string, storedPlate: string | null | undefined): boolean {
  const shape = silhouette(storedPlate ?? "");
  if (shape.length < 5) return false;
  return silhouette(text) === shape;
}

export class PlateGate {
  private state: VerificationState = "waiting";
  private consumed = 0;
  private readonly seen = new Set<string>();
  /** Plate-shaped guesses already charged for, so the same wrong answer costs once. */
  private readonly counted = new Set<string>();
  /**
   * Everything the caller has said, joined.
   *
   * The transcript arrives as raw deltas — "BL", " 123", " AB" are three
   * entries — so matching them one at a time would never find a plate and
   * would spend an attempt on every fragment that happened to carry a digit.
   * The words are therefore glued back together and the window is matched as
   * a whole.
   */
  private heard = "";

  constructor(
    private readonly found: CallerCase,
    private readonly fullDisclosure: boolean,
    private readonly attemptsAlreadyUsed: number,
    private readonly limits: VerificationLimits = VERIFICATION_DEFAULTS,
  ) {
    if (this.attemptsAlreadyUsed >= this.limits.maxAttempts) this.state = "exhausted";
    // A case with no plate can never be verified, so it is never opened.
    if (!found.plateOnFile) this.state = "exhausted";
  }

  get current(): VerificationState {
    return this.state;
  }

  get attemptsUsed(): number {
    return this.attemptsAlreadyUsed + this.consumed;
  }

  /**
   * Feeds everything heard so far and reports what changed.
   *
   * Takes the whole transcript because the probe checkpoints on a timer, not
   * per utterance. Fragments already folded into the window are remembered by
   * content, so being handed the growing list repeatedly costs nothing.
   */
  observe(transcript: readonly TranscriptEntry[] | null): VerificationOutcome {
    if (this.state !== "waiting" || !transcript) {
      return { state: this.state, instruction: null, attemptSpent: false };
    }

    const fresh: string[] = [];
    for (const entry of transcript) {
      if (entry.dir !== "in") continue;
      const key = `${entry.ms}|${entry.text}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      fresh.push(entry.text);
    }
    if (fresh.length === 0) return { state: this.state, instruction: null, attemptSpent: false };

    const added = fresh.join(" ");
    this.heard = `${this.heard} ${added}`.trim().slice(-WINDOW_CHARS);

    // The window, not the fragment: a plate spelled across several deltas is
    // one answer, and it is only found once the last piece has arrived.
    if (speechMatchesPlate(this.heard, this.found.plateOnFile)) {
      this.state = "verified";
      return {
        state: "verified",
        instruction: describeAfterVerification(this.found, this.fullDisclosure),
        attemptSpent: false,
      };
    }

    // An attempt is a *candidate*, not an utterance and not a fragment. The
    // window is searched for runs shaped like a plate; each new one costs one
    // try. Counting fragments let a wrong plate spelled slowly cost nothing at
    // all, and counting utterances let three guesses in one breath cost one.
    let spent = false;
    for (const candidate of plateCandidates(this.heard)) {
      if (!looksLikePlateShaped(candidate, this.found.plateOnFile)) continue;
      const normalized = normalizePlate(candidate);
      if (this.counted.has(normalized)) continue;
      this.counted.add(normalized);
      this.consumed += 1;
      spent = true;
      if (this.attemptsUsed >= this.limits.maxAttempts) {
        this.state = "exhausted";
        return {
          state: "exhausted",
          instruction:
            "Evidenčné číslo nesedí. Ďalej to neoveruj a k prípadu nič nehovor — povedz, že to takto po telefóne overiť nevieš a že sa ozve kolega.",
          attemptSpent: true,
        };
      }
    }

    return { state: this.state, instruction: null, attemptSpent: spent };
  }
}
