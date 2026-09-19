import type { DispatchCase } from "../../src/domain/types";
export const collaborationCard: DispatchCase = {
  id: "00000000-0000-4000-8000-000000000021", caseNumber: "TEST-001", status: "open", priority: "normal", ownerId: "operator-fixture", ownerName: "Jana",
  jobTypes: [], contact: { id: "contact-fixture", name: "Klient Test", phone: "+421900000001", role: "client" },
  customerDetails: { type: "private_person", firstName: "Klient", lastName: "Test" },
  vehicle: { id: "vehicle-fixture", licensePlate: "TEST001", make: "Škoda", model: "Octavia", category: "", driveable: false, conditionFlags: [], issue: "" },
  incidentDetails: { damageAreas: [], description: "" }, locationDetails: { accessComplications: [] },
  replacementVehicle: { needed: false, preferences: [] }, attachments: [], paymentDetails: {}, closureDetails: {},
  summary: "", mainNote: "Pôvodná poznámka", nextStep: "", createdAt: "2026-09-19T10:00:00Z", updatedAt: "2026-09-19T11:00:00Z", tasks: [], timeline: [],
};
