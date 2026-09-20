/**
 * Noticing that the conversation is over.
 *
 * She has no way to hang up by herself: GPT-Live has no such tool, and giving
 * her one would need a process listening for its result. But something *is*
 * listening now — the probe holds the sideband for the whole call — so the
 * conversation can be watched for its ending and the call closed from here.
 *
 * Two conditions, and both are needed:
 *
 *  - she said something that closes a call, and
 *  - neither side has said anything since.
 *
 * Either alone gets it wrong. "Ďakujem za váš čas" appears in the middle of
 * calls, and a caller who pauses to look something up has not hung up. A model
 * asked to judge would be a third thing to wait for during a live call, which
 * is the one cost this feature may not have.
 */

/** Closings, lowercased and without diacritics so a transcript spelling cannot miss them. */
const FAREWELLS = [
  "dovidenia",
  "do videnia",
  "dopocutia",
  "do pocutia",
  "pekny den",
  "pekny zvysok dna",
  "prajem pekny",
  "majte sa",
  "dakujem za vas cas",
  "dakujem za rozhovor",
  "budem sa lucit",
  "vsetko dobre",
];

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does this stretch of her speech read like the end of a call? */
export function isFarewell(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return FAREWELLS.some((phrase) => normalized.includes(phrase));
}

export type FarewellInput = {
  /** Her speech, in order, with the offset each stretch began. */
  turns: ReadonlyArray<{ ms: number; dir: "in" | "out"; text: string }>;
  /** Offset of the last thing said by anybody. */
  lastSpeechMs: number;
  /** Offset now. */
  nowMs: number;
  silenceMs: number;
};

/**
 * `true` once she has said goodbye and the line has been quiet since.
 *
 * The farewell must be the last thing she said: if the caller asked something
 * after it, the call carried on and the goodbye was premature.
 */
export function callIsOver(input: FarewellInput): boolean {
  const spoken = input.turns.filter((turn) => turn.text.trim().length > 0);
  const last = spoken[spoken.length - 1];
  if (!last || last.dir !== "out" || !isFarewell(last.text)) return false;
  return input.nowMs - input.lastSpeechMs >= input.silenceMs;
}
