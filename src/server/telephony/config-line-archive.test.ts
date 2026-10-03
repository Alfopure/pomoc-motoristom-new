import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelephonyHarness, LINES, NUMBERS, ORG, PROFILES } from "@/test/telephony-harness";
import { buildRoutingSummary } from "@/lib/telephony/routing-summary";
import { loadTelephonyCallHistory } from "./call-history";
import {
  getCoherentRoutingDocument,
  getRoutingDocument,
  updateOperatorTelephonySettings,
  updateTelephonyLine,
  type LinePatchInput,
} from "./config-service";
import { isArchivedLine } from "./line-archive";

const actor = { profileId: PROFILES.o4, role: "manager" as const };
const archivedAt = "2026-10-03T12:00:00.000Z";

afterEach(() => vi.restoreAllMocks());

function archive(h: ReturnType<typeof createTelephonyHarness>) {
  const row = h.db.find("motorist_telephony_lines", line => line.id === LINES.neutral)!;
  h.db.update("motorist_telephony_lines", {
    active: false,
    metadata: { ...row.metadata as Record<string, unknown>, archived_at: archivedAt, archive_reason: "transferred_to_test" },
  }, line => line.id === LINES.neutral);
}

describe("archived line configuration", () => {
  it.each([getRoutingDocument, getCoherentRoutingDocument])("hides archived lines in %s while retaining inactive lines and the original row", async read => {
    const h = createTelephonyHarness();
    archive(h);
    h.db.update("motorist_telephony_lines", { active: false }, row => row.id === LINES.allianz);

    const document = await read({ admin: h.admin }, { organizationId: ORG, includeSettings: true });
    expect(document.lines.map(line => line.id)).toEqual([LINES.allianz]);
    expect(document.lines[0].active).toBe(false);
    expect(buildRoutingSummary(document, new Date(archivedAt), true).lines.map(line => line.id)).toEqual([LINES.allianz]);
    expect(h.db.find("motorist_telephony_lines", row => row.id === LINES.neutral)).toMatchObject({
      phone_number: NUMBERS.neutral, label: "Neutrálna linka", metadata: { archived_at: archivedAt },
    });
  });

  it("preserves the line label and relation on existing calls", async () => {
    const h = createTelephonyHarness();
    h.db.insert("motorist_calls", { id: "historic-call", organization_id: ORG, line_id: LINES.neutral,
      direction: "inbound", status: "ended", started_at: archivedAt, ended_at: archivedAt,
      caller_number: NUMBERS.customer, called_number: NUMBERS.neutral });
    archive(h);

    const calls = await loadTelephonyCallHistory(ORG, 10, h.admin);
    expect(calls).toHaveLength(1);
    expect(calls[0].lineLabel).toBe("Neutrálna linka");
    expect(h.rows("motorist_calls")[0].line_id).toBe(LINES.neutral);
  });

  it("rejects direct reactivation and choosing the archive as an operator default", async () => {
    const h = createTelephonyHarness();
    archive(h);

    await expect(updateTelephonyLine({ admin: h.admin }, {
      organizationId: ORG, actor, lineId: LINES.neutral, patch: { active: true },
    })).rejects.toMatchObject({ status: 404, code: "line_not_found" });
    await expect(updateOperatorTelephonySettings({ admin: h.admin }, {
      organizationId: ORG, actor, profileId: PROFILES.o1, patch: { defaultFromLineId: LINES.neutral },
    })).rejects.toMatchObject({ status: 400, code: "config_invalid" });
    expect(h.rows("motorist_audit_log")).toHaveLength(0);
  });

  it("keeps an ordinary inactive line editable and preserves its metadata", async () => {
    const h = createTelephonyHarness();
    h.db.update("motorist_telephony_lines", { active: false, metadata: { archived_at: null, custom: "preserve" } }, row => row.id === LINES.allianz);

    const result = await updateTelephonyLine({ admin: h.admin }, {
      organizationId: ORG, actor, lineId: LINES.allianz, patch: { active: true, label: "Reopened line" },
    });
    expect(result.line).toMatchObject({ active: true, label: "Reopened line" });
    expect(h.db.find("motorist_telephony_lines", row => row.id === LINES.allianz)?.metadata).toEqual({ archived_at: null, custom: "preserve" });
  });

  it("rejects an archive created after the routing read but before the write preflight", async () => {
    const h = createTelephonyHarness();
    const select = h.db.select.bind(h.db);
    let lineReads = 0;
    vi.spyOn(h.db, "select").mockImplementation((table, filter) => {
      if (table === "motorist_telephony_lines" && ++lineReads === 2) archive(h);
      return select(table, filter);
    });

    await expect(updateTelephonyLine({ admin: h.admin }, {
      organizationId: ORG, actor, lineId: LINES.neutral, patch: { active: true },
    })).rejects.toMatchObject({ status: 404, code: "line_not_found" });
    expect(h.db.find("motorist_telephony_lines", row => row.id === LINES.neutral)?.active).toBe(false);
  });

  it.each<LinePatchInput>([{ active: true }, { label: "Stale editor" }, { inboundCallMode: "ring_ordered" }])(
    "refuses a stale %j write when archival races with the final UPDATE, even at the same timestamp", async patch => {
      const h = createTelephonyHarness();
      const update = h.db.update.bind(h.db);
      let racing = true;
      vi.spyOn(h.db, "update").mockImplementation((table, values, filter) => {
        if (table === "motorist_telephony_lines" && racing) {
          racing = false;
          const row = h.db.find(table, line => line.id === LINES.neutral)!;
          update(table, { active: false, updated_at: row.updated_at, metadata: { ...row.metadata as Record<string, unknown>, archived_at: archivedAt } }, line => line.id === LINES.neutral);
        }
        return update(table, values, filter);
      });

      await expect(updateTelephonyLine({ admin: h.admin }, {
        organizationId: ORG, actor, lineId: LINES.neutral, patch,
      })).rejects.toMatchObject({ status: 409, code: "config_conflict" });
      expect(h.db.find("motorist_telephony_lines", row => row.id === LINES.neutral)).toMatchObject({
        active: false, label: "Neutrálna linka", metadata: { archived_at: archivedAt },
      });
      expect(h.rows("motorist_audit_log")).toHaveLength(0);
    },
  );

  it("only treats a nonempty string archival marker as an archive", () => {
    for (const metadata of [null, [], {}, { archived_at: null }, { archived_at: " " }, { archived_at: 123 }]) {
      expect(isArchivedLine(metadata)).toBe(false);
    }
    expect(isArchivedLine({ archived_at: archivedAt })).toBe(true);
    expect(isArchivedLine({ archived_at: "legacy archive" })).toBe(true);
  });
});
