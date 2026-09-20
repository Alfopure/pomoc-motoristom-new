import "server-only";

import type { CallerCase } from "./caller-case";
import { describeAfterVerification } from "./caller-case";
import type { TranscriptEntry } from "./greeting";
import { speechMatchesPlate } from "./plate";

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
 * Anything that looks like an attempt at an answer.
 *
 * Without this every "áno", "prosím" and "moment" would burn an attempt and a
 * caller would be locked out by politeness. A plate has at least four letters
 * and digits together, so that is the bar for having tried.
 */
function looksLikeAnAttempt(text: string): boolean {
  const plain = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // A digit is what separates a plate from a spoken word: ordinary Slovak has
  // none, every Slovak plate has three. An earlier version counted any four
  // letters, so "prosím" burned an attempt and politeness locked people out.
  if (!/[0-9]/.test(plain)) return false;
  return (plain.match(/[A-Za-z0-9]/g) ?? []).length >= 4;
}

export class PlateGate {
  private state: VerificationState = "waiting";
  private consumed = 0;
  private readonly seen = new Set<string>();

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
   * Takes the whole transcript rather than the newest line because the probe
   * checkpoints on a timer, not per utterance — several turns can arrive at
   * once. Entries already examined are skipped, so an attempt is counted once.
   */
  observe(transcript: readonly TranscriptEntry[] | null): VerificationOutcome {
    if (this.state !== "waiting" || !transcript) {
      return { state: this.state, instruction: null, attemptSpent: false };
    }

    // The probe hands over the whole transcript at every checkpoint, so the
    // same utterance arrives again and again. Remembering what has been looked
    // at by its content rather than by a position makes the counting correct
    // whether the caller passes the growing list or only the newest lines —
    // an index would have quietly stopped counting on the second style.
    const fresh = transcript.filter((entry) => {
      const key = `${entry.ms}|${entry.dir}|${entry.text}`;
      if (this.seen.has(key)) return false;
      this.seen.add(key);
      return true;
    });
    let spent = false;

    for (const entry of fresh) {
      if (entry.dir !== "in") continue;

      if (speechMatchesPlate(entry.text, this.found.plateOnFile)) {
        this.state = "verified";
        return {
          state: "verified",
          instruction: describeAfterVerification(this.found, this.fullDisclosure),
          attemptSpent: spent,
        };
      }

      if (!looksLikeAnAttempt(entry.text)) continue;
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
