import { createRoot } from "react-dom/client";
import { DispatchConsole } from "@/components/dispatch/DispatchConsole";
import type { DispatchData } from "@/data/dispatch-types";
import * as seed from "@/mock/seed";

const first = seed.dispatchCases[0];
const data: DispatchData = {
  attendance: seed.attendance, users: [], operators: seed.operators, branches: seed.branches, partnerDirectory: [],
  fleetAssets: seed.fleetAssets, fleetProviderVehicles: [], commanderVehicles: [], priceRules: seed.priceRules,
  incomingCall: seed.incomingCall, callCenterCalls: [], notifications: [], metrics: seed.metrics, integrations: seed.integrations, source: "mock",
  dispatchCases: [
    { ...structuredClone(first), id: "fixture-open", caseNumber: "PM-2026-9001", status: "open", contact: { ...first.contact, name: "Otvorený prípad" } },
    { ...structuredClone(first), id: "fixture-completed", caseNumber: "PM-2026-9002", status: "completed_assisted", contact: { ...first.contact, name: "Spoločný kontakt" }, vehicle: { ...first.vehicle, licensePlate: "QA123AB" } },
    { ...structuredClone(first), id: "fixture-cancelled", caseNumber: "PM-2026-9003", status: "cancelled", contact: { ...first.contact, name: "Spoločný kontakt" }, vehicle: { ...first.vehicle, licensePlate: "QB456CD" } },
  ],
};
createRoot(document.getElementById("root")!).render(<DispatchConsole initialData={data} viewerRole="admin" />);
