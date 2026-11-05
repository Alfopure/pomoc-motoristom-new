import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { dispatchCases } from "@/mock/seed";
import { CaseWorkspace } from "./CaseWorkspace";

describe("case workspace", () => {
  it("counts only open and overdue tasks in its navigation badge", () => {
    const base = dispatchCases[0];
    const task = base.tasks[0];
    const caseItem = { ...base, tasks: [
      { ...task, id: "done", status: "done" as const },
      { ...task, id: "open", status: "open" as const },
      { ...task, id: "overdue", status: "overdue" as const },
    ] };
    const html = renderToStaticMarkup(<CaseWorkspace caseItem={caseItem} assets={[]} operators={[]} handoff={null} work={null} tasks={null} partner={null} sms={null} />);
    expect(html).toMatch(/Úlohy<span>2<\/span>/);
  });
});
