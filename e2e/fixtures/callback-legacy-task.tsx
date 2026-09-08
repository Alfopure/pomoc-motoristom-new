import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CallCenterModule } from "../../src/components/dispatch/CallCenterModule";
import { TaskPanel } from "../../src/components/dispatch/TaskPanel";
import type { CallCenterCall } from "../../src/data/dispatch-types";
import { dispatchCases, operators } from "../../src/mock/seed";

const noop = () => {};
// A pre-migration obligation: only a CaseTask, deliberately no callback request ID.
const legacyCase = {
  ...dispatchCases[0],
  id: "legacy-case",
  caseNumber: "LEGACY-CB-14",
  tasks: [{
    id: "legacy-task-only", caseId: "legacy-case", title: "Staršia úloha: zavolať klientovi",
    assignedTo: operators[0].id, dueAt: "2026-09-07T08:30:00Z", status: "open" as const,
    priority: "normal" as const, kind: "callback" as const,
  }],
};
const call: CallCenterCall = {
  id: "00000000-0000-4000-8000-000000000901", status: "missed", direction: "inbound",
  callerNumber: "+421900000001", calledNumber: "+421900000002", lineLabel: "Testovacia linka",
  startedAt: "2026-09-07T08:00:00Z", endedAt: "2026-09-07T08:01:00Z", waitSeconds: 60,
  recordingStatus: "not_requested", transcriptStatus: "not_requested", history: [],
};

function Fixture() {
  const [tasksVisible, setTasksVisible] = useState(true);
  const [opened, setOpened] = useState("");
  const variant = new URLSearchParams(location.search).get("variant") === "sidebar" ? "sidebar" : "page";
  return <>
    <button onClick={() => setTasksVisible(true)}>Prehľad úloh</button>
    <button onClick={() => setTasksVisible(false)}>Telefónna fronta</button>
    <output data-testid="opened-task">{opened}</output>
    {tasksVisible ? <TaskPanel cases={[legacyCase]} operators={operators} notifications={[]}
      variant={variant} viewerProfileId={operators[0].id} onMarkNotificationRead={noop}
      onOpenTask={(taskId, caseId) => setOpened(`${taskId}:${caseId}`)} /> : <CallCenterModule
      telephonyConfigured onCallAction={noop} onAnswer={noop} onRejectOffer={noop} canManageCalls={false}
      onSupervise={noop} onStopSupervise={noop} calls={[call]} cases={[legacyCase]} dataSource="supabase"
      metrics={{totalCalls: 1, answeredCalls: 0, missedCalls: 1, newCases: 0, openTasks: 1, futileTrips: 0, answerRate: 0, serviceLevel: 0}}
      operatorPresences={[]} operators={operators} onDataChange={noop} onDial={async () => {}}
      onNewCase={noop} onNewCaseFromLiveCall={noop} onOpenCase={noop} onAvailabilityAction={noop} onTelephonyChanged={noop}
    />}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
