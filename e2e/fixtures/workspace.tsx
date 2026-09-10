import { createRoot } from "react-dom/client";
import { DispatchConsole } from "@/components/dispatch/DispatchConsole";
import { attendance, branches, callCenterCalls, dispatchCases, fleetAssets, incomingCall, integrations, metrics, notifications, operators, priceRules } from "@/mock/seed";
import type { DispatchData } from "@/data/dispatch-types";

const enabled = new URLSearchParams(window.location.search).has("workspace");
const archived = new URLSearchParams(window.location.search).has("archive");
const standaloneTask = {
  id: "00000000-0000-4000-8000-000000000010", caseId: "", caseIds: [], caseLinks: [], title: "Samostatná testovacia úloha",
  assignedTo: "00000000-0000-4000-8000-000000000002", dueAt: "", reminderAt: null, status: "open" as const, priority: "normal" as const, kind: "other" as const,
  revision: 1, originLocked: false, provenance: "manual" as const, origins: [], updatedAt: "2026-09-10T10:00:00Z",
};
// The fixture never registers a worker or reaches a provider. Exercise the real
// console receiver through the same message event boundary as an existing tab.
if (enabled) {
  const acknowledgments: unknown[] = [];
  const worker = Object.assign(new EventTarget(), { controller: { postMessage: (message: unknown) => acknowledgments.push(message) }, getRegistration: async () => undefined });
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: worker });
  Object.assign(window, { fixtureAcknowledgments: acknowledgments });
}
const data: DispatchData = {
  attendance, branches, callCenterCalls, dispatchCases, fleetAssets, incomingCall, integrations, metrics, notifications, operators, priceRules,
  ...(archived ? { dispatchCases: dispatchCases.map((item, index) => index === 2 ? { ...item, status: "completed_assisted" as const } : item) } : {}),
  ...(enabled ? { workspaceCapabilities: { notes: true, tasks: true, atomicCaseSave: false, pdf: false }, tasks: [standaloneTask] } : {}),
  users: [], partnerDirectory: [], fleetProviderVehicles: [], commanderVehicles: [], source: "mock",
};
Object.assign(window, { workspaceFixtureData: data });
createRoot(document.getElementById("root")!).render(<DispatchConsole initialData={data} viewerOrganizationId="00000000-0000-4000-8000-000000000001" viewerProfileId="00000000-0000-4000-8000-000000000002" viewerDisplayName="Test dispečer" appVersion="isolated-workspace" />);
