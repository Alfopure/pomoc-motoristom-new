import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Call-speed S5 invariants that no single behavioural test can see, checked
 * over the source itself.
 *
 * The API region of a call lives in `metadata.start_mode.apiRegion`, and the
 * database replaces `metadata` as a whole on every patch
 * (`20261004100000_apply_critical_rows.sql`). A patch that rebuilt metadata
 * without the session's existing keys would silently move a live EU call to
 * `.com`. A database trigger that keeps `start_mode` is the follow-up that
 * would enforce this in the database (not part of this change: no migration).
 */

const ROOT = join(__dirname, "..", "..");
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "test" && directory === ROOT ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
const files = sources(ROOT).map((path) => ({ name: relative(ROOT, path), text: readFileSync(path, "utf8") }));
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

describe("Telnyx API hosts", () => {
  it("are built only by the client, the recording helper and their configuration", () => {
    const building = files.filter(({ text }) => /api\.telnyx\.(com|eu)|\bapiBaseUrl\b|\beuApiBaseUrl\b|apiBaseUrlFor\(/.test(text)).map(({ name }) => name).sort();
    expect(building).toEqual([
      "server/telephony/latency-flags.ts", // `providerRegionOf` reads the configured host's region; it builds no URL.
      "server/telephony/recording-jobs.ts",
      "server/telephony/telnyx/client.ts",
      "server/telephony/telnyx/env.ts",
    ]);
  });
});

describe("session start mode", () => {
  it("is written only when a session is created", () => {
    // A `.contains("metadata", { start_mode: … })` read filter writes nothing (the alert evidence finds S6 B′ sessions so).
    const READ_FILTER = /\.contains\(\s*["']metadata["']\s*,\s*\{\s*start_mode\s*:/;
    expect(files.filter(({ text }) => READ_FILTER.test(text)).map(({ name }) => name)).toEqual(["server/telephony/alert-evidence.ts"]);
    const written = files.map(({ name, text }) => ({ name, text: text.replace(new RegExp(READ_FILTER, "g"), ".contains(") }));
    const writers = written.filter(({ text }) => /\bstart_mode\s*:/.test(text)).map(({ name }) => name).sort();
    expect(writers).toEqual(["server/telephony/call-actions.ts", "server/telephony/telnyx/event-processor.ts"]);
    for (const { name, text } of written.filter(({ name }) => writers.includes(name))) {
      for (const match of text.matchAll(/\bstart_mode\s*:\s*([^,}]+)/g)) expect(`${name}: ${match[1].trim()}`).toMatch(/: freezeStartMode\(/);
    }
  });

  it("survives every session metadata patch: each one spreads the existing metadata or is a reviewed merge", () => {
    // Reviewed expressions that are themselves built from the session's full metadata.
    const reviewed = [
      /^mergeMeta\(/, // `state/types.ts`: { ...readMeta(session), ...patch }
      /^session\.metadata$/,
      /^withGap\.metadata$/, // `patched(restored, …)` over the full metadata
      /^changed\.metadata$/, // `recordingCommandOutcome`: { ...meta, recording }
      /^toJson\(ivrOutcome\)$/, // `ivrDispatchOutcome`: { ...meta, ivr_dispatch, gather }
      /^snapshot\.session\.metadata$/, // a fresh read of the row
    ];
    const patches: string[] = [];
    for (const { name, text } of files.filter(({ name }) => name.startsWith("server/"))) {
      for (const match of text.matchAll(/\bsession\.metadata\s*=(?!=)\s*([^;]+);/g)) {
        const value = squash(match[1]);
        patches.push(`${name}: ${value.slice(0, 60)}`);
        expect(/^toJson\(\{ ?\.\.\./.test(value) || reviewed.some((pattern) => pattern.test(value)), `${name}: session.metadata = ${value}`).toBe(true);
      }
      for (const match of text.matchAll(/from\(["']motorist_call_sessions["']\)([^;]*);/g)) {
        const statement = squash(match[1]);
        if (!/\.(update|upsert)\(/.test(statement) || !/\bmetadata\s*:/.test(statement)) continue;
        const value = /\bmetadata\s*:\s*(.*)$/.exec(statement)![1];
        patches.push(`${name}: ${value.slice(0, 60)}`);
        expect(/^toJson\(\{ ?\.\.\./.test(value), `${name}: update metadata: ${value}`).toBe(true);
      }
    }
    // The scan really found the patch builders (19 when written).
    expect(patches.length).toBeGreaterThan(15);
  });
});
