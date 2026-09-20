/**
 * Matching a licence plate somebody said out loud against one on file.
 *
 * This is the whole verification gate, so it errs towards refusing: a false
 * "no" costs a caller one repetition, a false "yes" hands a stranger somebody
 * else's case. Nothing here ever returns the stored plate — it answers yes or
 * no and nothing more.
 *
 * Speech is not a string. "BA123AB" comes back as "B A 1 2 3 A B", as
 * "BA 123 AB", with a full stop in the middle, or with the letter O where a
 * zero belongs. The normaliser absorbs the punctuation and spacing; the
 * confusable map absorbs the rest.
 */

/** Characters a transcript routinely swaps. Both directions fold to one form. */
const CONFUSABLE: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", Z: "2", B: "8" };

/**
 * Strips everything that is not a letter or a digit, removes diacritics and
 * upper-cases the rest. `"bl-123 ab."` and `"BL 123 AB"` become the same thing.
 */
export function normalizePlate(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/** The form used only for comparison, never for display or storage. */
function foldConfusables(plate: string): string {
  return plate.replace(/[A-Z]/g, (character) => CONFUSABLE[character] ?? character);
}

/**
 * Whether what the caller said is the plate we hold.
 *
 * Compared twice: exactly, then with the confusable letters folded. The second
 * pass is what makes "BA1O3AB" match "BA103AB" — a transcription slip, not a
 * different car. It cannot collapse two real plates into one without them
 * already differing only by an O/0-class character, which the exact pass would
 * have caught first.
 */
export function plateMatches(spoken: string | null | undefined, stored: string | null | undefined): boolean {
  const said = normalizePlate(spoken);
  const held = normalizePlate(stored);
  // An empty answer is not an answer, and a case with no plate cannot be checked.
  if (said.length < 4 || held.length < 4) return false;
  if (said === held) return true;
  return foldConfusables(said) === foldConfusables(held);
}

/**
 * Pulls plate-shaped candidates out of a sentence.
 *
 * A caller says "áno, je to BL 123 AB" or spells it across several words, so
 * the whole utterance is tried as well as each run of letters and digits. The
 * comparison, not this function, decides whether any of them is right.
 */
export function plateCandidates(speech: string | null | undefined): string[] {
  if (typeof speech !== "string" || speech.trim() === "") return [];
  const whole = normalizePlate(speech);
  const candidates = new Set<string>();
  if (whole.length >= 4) candidates.add(whole);

  // Words glued together: "BL 123 AB" also has to be tried as "BL123AB".
  const words = speech.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(normalizePlate).filter(Boolean);
  for (let start = 0; start < words.length; start += 1) {
    let joined = "";
    for (let end = start; end < Math.min(start + 4, words.length); end += 1) {
      joined += words[end];
      if (joined.length >= 4 && joined.length <= 10) candidates.add(joined);
    }
  }
  return [...candidates];
}

/** Whether any part of what was said matches the plate on file. */
export function speechMatchesPlate(speech: string | null | undefined, stored: string | null | undefined): boolean {
  if (normalizePlate(stored).length < 4) return false;
  return plateCandidates(speech).some((candidate) => plateMatches(candidate, stored));
}
