/**
 * Turning stored deltas into turns.
 *
 * The model emits a fragment at a time. Both the review and the settings tab
 * want whole turns, and they must agree on what a turn is, so the grouping
 * lives here rather than in either of them.
 */

export type TranscriptTurn = { ms: number; dir: "in" | "out"; text: string };

export function transcriptTurns(stored: unknown): TranscriptTurn[] {
  if (!Array.isArray(stored)) return [];
  const turns: TranscriptTurn[] = [];
  for (const raw of stored) {
    // The column is `jsonb`: it holds whatever was written, including nulls and
    // scalars from an older shape.
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as { ms?: unknown; dir?: unknown; text?: unknown };
    if (typeof entry.text !== "string" || (entry.dir !== "in" && entry.dir !== "out")) continue;
    const ms = typeof entry.ms === "number" && Number.isFinite(entry.ms) ? entry.ms : 0;
    const current = turns[turns.length - 1];
    if (current && current.dir === entry.dir) current.text += entry.text;
    else turns.push({ ms, dir: entry.dir, text: entry.text });
  }
  return turns.map((turn) => ({ ...turn, text: turn.text.trim() })).filter((turn) => turn.text.length > 0);
}
