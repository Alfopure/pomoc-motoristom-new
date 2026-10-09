import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { CallCenterCall } from "../../src/data/dispatch-types";
import { CallDetailDrawer } from "../../src/components/dispatch/CallDetailDrawer";

export const callId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

function call(index: number): CallCenterCall {
  return {
    id: callId(index), providerSessionId: callId(index + 100), status: "ended", direction: "inbound",
    callerNumber: `+42190000000${index}`, calledNumber: "+421900000000", lineLabel: "TEST linka",
    startedAt: "2026-10-07T10:00:00.000Z", endedAt: "2026-10-07T10:02:00.000Z", waitSeconds: 3,
    durationSeconds: 117, recordingStatus: "available", transcriptStatus: "not_requested", history: [],
  };
}

function Fixture() {
  const [selected, setSelected] = useState<CallCenterCall | null>(null);
  const [diagnostics, setDiagnostics] = useState(true);
  useEffect(() => {
    window.callDetailFixture = { select: (index) => setSelected(call(index)), diagnostics: setDiagnostics };
  }, []);
  return <main>
    <h1>História hovorov · TEST</h1>
    {[1, 2, 3].map((index) => <button key={index} type="button" onClick={() => setSelected(call(index))}>Hovor {index}</button>)}
    <CallDetailDrawer call={selected} open={Boolean(selected)} onClose={() => setSelected(null)} onNewCase={() => {}} canViewDiagnostics={diagnostics} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);

declare global {
  interface Window {
    callDetailFixture: { select(index: number): void; diagnostics(enabled: boolean): void };
  }
}
