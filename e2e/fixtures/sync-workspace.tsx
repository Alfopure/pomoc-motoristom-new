import { createRoot } from "react-dom/client";
import { DispatchConsole } from "../../src/components/dispatch/DispatchConsole";
import { attendance, branches, callCenterCalls, fleetAssets, incomingCall, integrations, metrics, operators, priceRules } from "../../src/mock/seed";
import type { DispatchData } from "../../src/data/dispatch-types";
import { syncCard } from "./sync-workspace-data";
const data: DispatchData = {
  attendance, branches, callCenterCalls, fleetAssets, incomingCall, integrations, metrics, operators, priceRules,
  dispatchCases: [syncCard], notifications: [], tasks: [], users: [], partnerDirectory: [], fleetProviderVehicles: [], commanderVehicles: [],
  workspaceCapabilities: { notes: true, tasks: true, atomicCaseSave: false, pdf: false }, source: "supabase",
};
createRoot(document.getElementById("root")!).render(<DispatchConsole layoutPreviewEnabled initialData={data}
  viewerOrganizationId="00000000-0000-4000-8000-000000000001" viewerProfileId="00000000-0000-4000-8000-000000000002"
  viewerRole="manager" viewerDisplayName="Test dispečer" appVersion="sync-isolated" />);
