import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { DispatchCall, DispatchCase, PriceRule } from "@/domain/types";
import type { DispatchData } from "@/data/dispatch-types";
import type { PlaceSelectionInput } from "@/data/case-inputs";
import { createDispatchMapModel } from "@/lib/map-adapter";
import { CaseCockpitPanel } from "./CaseCockpitPanel";
import { CaseDrawer } from "./CaseDrawer";
import { ExpandedCasePanel } from "./ExpandedCasePanel";
import { LocationPicker } from "./LocationPicker";

// Browser-only fixture: the real components use a Google boundary stub and blocked network.
const state = { maps: [] as MapStub[], geocodes: [] as unknown[], markers: [] as MarkerStub[] };
Object.assign(window, { caseCardTest: state });
class Autocomplete extends HTMLElement { value = ""; }
customElements.define("gmp-place-autocomplete", Autocomplete);
class MapStub {
  center: unknown;
  zoom: number;
  constructor(host: HTMLElement, public options: google.maps.MapOptions) {
    this.center = options.center;
    this.zoom = options.zoom ?? 7;
    state.maps.push(this);
    host.style.background = "#e7ede7";
    host.addEventListener("wheel", () => { if (options.scrollwheel !== false) this.zoom += 1; });
  }
  addListener() { return { remove() {} }; }
  getCenter() { return this.center; }
  setCenter(center: unknown) { this.center = center; }
  getZoom() { return this.zoom; }
  setZoom(zoom: number) { this.zoom = zoom; }
}
class MarkerStub {
  position: unknown;
  constructor() { state.markers.push(this); }
  setPosition(point: unknown) { this.position = point; }
  setMap() {}
}
Object.assign(window, { google: { maps: {
  Map: MapStub, Marker: MarkerStub, UnitSystem: { METRIC: 0 },
  Geocoder: class { async geocode(request: unknown) {
    state.geocodes.push(request);
    return { results: [{ formatted_address: "Nitra, Slovensko", geometry: { location: { lat: () => 48.3064, lng: () => 18.0764 } } }] };
  } },
  importLibrary: async () => ({}), event: { trigger() {} }, places: { PlaceAutocompleteElement: Autocomplete },
} } });

const populated = new URLSearchParams(location.search).get("filled") !== "false";
const description = "Dlhý opis prípadu so všetkými podrobnosťami. ".repeat(15) + "KONIEC CELÉHO OPISU";
const caseItem: DispatchCase = {
  id: "case-fixture", caseNumber: "TEST-001", status: "open", priority: "normal", ownerId: "operator-fixture", ownerName: "Test Operátor",
  jobTypes: populated ? ["tow"] : [], contact: { id: "contact-fixture", name: populated ? "Test Klient" : "", phone: populated ? "+421900000001" : "", role: "client" },
  customerDetails: populated ? { type: "private_person", firstName: "Test", lastName: "Klient" } : {},
  vehicle: { id: "vehicle-fixture", licensePlate: populated ? "TEST001" : "", make: populated ? "Škoda" : "", model: populated ? "Octavia" : "", category: "", driveable: false, conditionFlags: [], issue: "" },
  incidentDetails: { damageAreas: [], description: populated ? description : "" },
  pickup: populated ? { id: "pickup-fixture", label: "Nitra", address: "Dlhá ulica 1, Nitra", lat: 48.3064, lng: 18.0764, kind: "pickup" } : undefined,
  customerSharedLocation: populated ? { label: "Testovacia GPS poloha", lat: 48.1486, lng: 17.1077, submittedAt: "2026-09-10T10:55:00Z", accuracyMeters: 22 } : undefined,
  locationDetails: { accessComplications: [] }, replacementVehicle: { needed: false, preferences: [] }, attachments: [],
  paymentDetails: populated ? { method: "card", status: "unpaid" } : {}, closureDetails: {},
  summary: populated ? description : "", mainNote: "", nextStep: populated ? "Overiť príjazd" : "",
  createdAt: "2026-09-10T10:00:00Z", updatedAt: "2026-09-10T11:00:00Z",
  tasks: populated ? [{ id: "task-fixture", caseId: "case-fixture", title: "Zavolať technikovi", assignedTo: "unassigned", dueAt: "2020-01-01T10:00:00Z", status: "open", priority: "normal", kind: "other" }] : [],
  timeline: populated ? [{ id: "event-fixture", caseId: "case-fixture", time: "2026-09-10T11:00:00Z", actor: "Test Operátor", title: "Poznámka", body: description, type: "note" }] : [],
};
Object.assign(window, { caseCardFixture: caseItem });
const priceRule: PriceRule = { id: "price-fixture", name: "Test", sourceType: "samoplatca", baseFee: 0, pricePerKm: 0, minimumPrice: 0, vatRate: 0 };
const call: DispatchCall = { id: "call-fixture", status: "ended", callerNumber: "+421900000001", calledNumber: "+421900000002", lineLabel: "Testovacia linka", startedAt: "2026-09-10T10:00:00Z", waitSeconds: 0, history: [] };
const noop = () => {};
function Fixture() {
  const [currentCase, setCurrentCase] = useState(caseItem);
  const [mode, setMode] = useState<"expanded" | "split" | "collapsed">("split");
  const [open, setOpen] = useState(true);
  const [point, setPoint] = useState<PlaceSelectionInput | null>(null);
  const onDataChange = (data: DispatchData) => {
    const next = data.dispatchCases.find(item => item.id === currentCase.id);
    if (next) setCurrentCase(next);
  };
  const view = new URLSearchParams(location.search).get("view");
  if (view === "location") return <div style={{ maxWidth: 600, margin: "auto", paddingBottom: 1000 }}><LocationPicker value={point} onSelect={setPoint} /><output data-testid="selected-point">{JSON.stringify(point)}</output></div>;
  if (view === "drawer") return <><button onClick={() => setOpen(true)}>Otvoriť drawer</button><CaseDrawer caseItem={currentCase} assets={[]} branches={[]} partnerDirectory={[]} priceRule={priceRule} open={open} onClose={() => setOpen(false)} /></>;
  if (view === "detail") return <div style={{ height: "100dvh" }}><ExpandedCasePanel assets={[]} branches={[]} call={call} caseItem={currentCase} commanderVehicles={[]} kind="detail" operators={[]} partnerDirectory={[]} onBackToCockpit={noop} onCaseCreated={noop} onDataChange={onDataChange} /></div>;
  return <div style={{ height: "100dvh", display: "flex", flexDirection: "column" }}><CaseCockpitPanel assets={[]} branches={[]} caseItem={currentCase} commanderVehicles={[]} focusedTaskId={new URLSearchParams(location.search).get("task") ?? undefined} mode={mode} model={createDispatchMapModel(currentCase, [], [])} operators={[]} partnerDirectory={[]} onCollapse={() => setMode("collapsed")} onExpand={() => setMode("expanded")} onRestore={() => setMode("split")} onDataChange={onDataChange} onDirtyChange={noop} onSaveDraftChange={noop} onSavingChange={noop} /></div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
