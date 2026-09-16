import { createRoot } from "react-dom/client";
import { DispatchConsole } from "@/components/dispatch/DispatchConsole";
import { attendance, branches, callCenterCalls, dispatchCases, fleetAssets, incomingCall, integrations, metrics, notifications, operators, priceRules } from "@/mock/seed";
import type { DispatchData } from "@/data/dispatch-types";

declare global {
  interface Window { compactLocationReceived: boolean }
}

Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: Object.assign(new EventTarget(), {
  controller: { postMessage: () => {} }, getRegistration: async () => undefined,
}) });
const data: DispatchData = {
  attendance, branches, callCenterCalls,
  dispatchCases: dispatchCases.map(caseItem => ({ ...caseItem, updatedAt: "2026-09-16T10:00:00.000Z", customerSharedLocation: window.compactLocationReceived ? {
    lat: 48.1486, lng: 17.1077, label: "GPS klienta", address: "Pribinova 8, Bratislava", accuracyMeters: 12,
    submittedAt: "2026-09-16T10:05:00.000Z",
  } : undefined })),
  fleetAssets, incomingCall, integrations, metrics, notifications, operators, priceRules,
  workspaceCapabilities: { notes: true, tasks: true, atomicCaseSave: false, pdf: false }, tasks: [],
  users: [], partnerDirectory: [], fleetProviderVehicles: [], commanderVehicles: [], source: "mock",
};
createRoot(document.getElementById("root")!).render(<DispatchConsole initialData={data}
  viewerOrganizationId="00000000-0000-4000-8000-000000000001"
  viewerProfileId="00000000-0000-4000-8000-000000000002" viewerDisplayName="Test dispečer" appVersion="isolated-compact-location" />);
