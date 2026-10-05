import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { CaseCollaborationProvider, useCaseCollaborationStore } from "../../src/components/dispatch/CaseCollaborationProvider";
import type { CaseCollaborationStore } from "../../src/components/dispatch/case-collaboration-store";
import type { DispatchCase, DispatchNotification } from "../../src/domain/types";
import { collaborationCard } from "./case-collaboration-data";

export const observation = {
  renders: 0, stalePublishes: 0, failures: [] as string[],
  cases: [] as DispatchCase[], notifications: [] as string[],
  publications: [] as { kind: "cases" | "notifications"; ids: string[]; denied: boolean }[],
};
declare global { interface Window { caseProviderObservation: typeof observation } }
window.caseProviderObservation = observation;
let store: CaseCollaborationStore | null = null;
function Observer() {
  const currentStore = useCaseCollaborationStore();
  useEffect(() => { store = currentStore; }, [currentStore]);
  return <label>Rozpísaný text<input defaultValue="Môj draft" /></label>;
}
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { observation.failures.push(error.message); }
  render() { return this.state.failed ? <p role="alert">Pád synchronizácie</p> : this.props.children; }
}
function Fixture() {
  const mode = new URLSearchParams(location.search).get("mode");
  const [cases, setCases] = useState<DispatchCase[]>([collaborationCard]);
  const [metadata, setMetadata] = useState({ available: null as boolean | null, hidden: true, denied: false, stale: true });
  const reentry = useRef(false);
  useEffect(() => { observation.renders++; observation.cases = cases; });
  const onCases = useCallback((next: DispatchCase[]) => {
    const snapshot = store!.getSnapshot();
    if (next.length && snapshot.cases !== next) observation.stalePublishes++;
    observation.publications.push({ kind: "cases", ids: next.map(item => item.id), denied: snapshot.denied });
    setCases(current => current === next ? current : next);
    if (reentry.current && mode === "cases-revoke" && next.length) { reentry.current = false; store!.revoke(); }
  }, [mode]);
  const onNotifications = useCallback((next: DispatchNotification[]) => {
    observation.notifications = next.map(item => item.id);
    observation.publications.push({ kind: "notifications", ids: observation.notifications, denied: store!.getSnapshot().denied });
  }, []);
  const onState = useCallback((next: typeof metadata) => {
    setMetadata(current => current.available === next.available && current.hidden === next.hidden && current.denied === next.denied && current.stale === next.stale ? current : next);
    if (reentry.current && mode === "state-revoke") { reentry.current = false; store!.revoke(); }
    if (reentry.current && mode === "state-change") {
      reentry.current = false;
      store!.acceptCases(store!.getSnapshot().cases.map(item => ({ ...item, mainNote: "Detail z callbacku" })));
    }
  }, [mode]);
  function update() {
    observation.publications = [];
    if (mode?.startsWith("state-") || mode === "cases-revoke") {
      reentry.current = true;
      store!.setConnected(false);
      return;
    }
    // One parent detail update races with one external-store update in the
    // same React batch. Both objects can legitimately have the same revision.
    setCases(current => mode === "array-only" ? [...current] : current.map(item => ({ ...item,
      mainNote: "Úplný detail", jobTypes: ["replacement_vehicle"],
      customerDetails: { ...item.customerDetails, firstName: "Detail" },
      tasks: [{ id: "task-fixture", caseId: item.id, title: "Zachovať úlohu", assignedTo: "operator-fixture",
        dueAt: "2026-09-19T12:00:00Z", status: "open", priority: "normal", kind: "other" }],
      ...(mode === "newer" ? { updatedAt: "2026-09-19T11:00:01Z" } : {}),
    })));
    if (mode !== "array-only") store!.acceptCases(store!.getSnapshot().cases.map(item => ({ ...item })));
  }
  return <CaseCollaborationProvider actorKey="fixture-org:fixture-profile" enabled initialCases={cases} onCasesChange={onCases} onNotificationsChange={onNotifications} onStateChange={onState}>
    <Observer />
    <button disabled={!metadata.available || metadata.hidden} onClick={update}>Súbežná aktualizácia</button>
    <p data-testid="access">{metadata.denied ? "denied" : metadata.available && !metadata.hidden ? "ready" : "pending"}</p>
  </CaseCollaborationProvider>;
}
createRoot(document.getElementById("root")!).render(<Boundary><Fixture /></Boundary>);
