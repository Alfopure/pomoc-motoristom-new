import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { JOB_DEFINITIONS } from "@/server/jobs/registry";
import { JOB_NAMES } from "@/server/jobs/types";

describe("scheduler job name recognition", () => {
  it("recognises every job the registry defines", () => {
    // enabledJobs() filters control rows through a JobName guard. When that
    // guard had its own hand-maintained copy of the list, a job added to the
    // registry but missed there was silently dropped: its control row said
    // enabled, the scheduler never enqueued it, and nothing logged an error.
    expect(Object.keys(JOB_DEFINITIONS).sort()).toEqual([...JOB_NAMES].sort());
  });

  it("derives the guard from JOB_NAMES instead of duplicating it", () => {
    const source = readFileSync(resolve(process.cwd(), "src/worker/run-ledger.ts"), "utf8");
    const guard = source.slice(source.indexOf("function isJobNameValue"));
    const body = guard.slice(0, guard.indexOf("}"));
    expect(body).toContain("JOB_NAMES");
    // No inline job-name string literals may reappear in the guard.
    expect(body).not.toMatch(/"(fleet|telephony|notifications|infra)\./);
  });
});
