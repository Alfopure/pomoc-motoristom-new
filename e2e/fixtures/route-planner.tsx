import { useState } from "react";
import { RoutePlannerProvider } from "../../src/components/dispatch/map/RoutePlannerProvider";
import { RoutePlanner } from "../../src/components/dispatch/map/RoutePlanner";
import { createRoot } from "react-dom/client";
import DispatchMapGoogle from "../../src/components/dispatch/DispatchMapGoogle";

// The real map UI runs against a small Google boundary stub; no provider or database is contacted.
const state = { markers: [] as Marker[], polylines: [] as Polyline[], autocompleteOptions: [] as Record<string, unknown>[], clickableIcons: true, mapCreations: 0, viewportChanges: 0 };
Object.assign(window, { routePlannerTest: state });
const places = [
  { label: "Bratislava, Slovensko", lat: 48.1486, lng: 17.1077 },
  { label: "Wien, Österreich", lat: 48.2082, lng: 16.3738 },
  { label: "Brno, Česko", lat: 49.1951, lng: 16.6068 },
  { label: "Praha, Česko", lat: 50.0755, lng: 14.4378 },
];

class Autocomplete extends HTMLElement {
  private input: HTMLInputElement;
  constructor(options: Record<string, unknown> = {}) {
    super();
    state.autocompleteOptions.push(options);
    this.input = document.createElement("input");
    this.input.setAttribute("part", "input");
    this.input.style.cssText = "width:100%;padding:10px;border:0;box-sizing:border-box;font:inherit";
    this.input.value = String(options.value ?? "");
    this.input.placeholder = String(options.placeholder ?? "");
    this.attachShadow({ mode: "open" }).append(this.input);
    this.input.addEventListener("keydown", event => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const selection = places.find(place => place.label.toLowerCase().includes(this.input.value.toLowerCase()));
      if (!selection) return;
      // Google replaces the typed query with the selected prediction before
      // gmp-select, without requiring an additional input event.
      this.input.value = selection.label;
      const select = new Event("gmp-select");
      const delay = Number(this.dataset.delay ?? 0);
      const failure = this.dataset.placeFailure;
      Object.assign(select, { placePrediction: { toPlace: () => {
        if (failure === "conversion") throw new Error("Isolated prediction conversion failure");
        return {
          formattedAddress: selection.label, displayName: selection.label,
          location: { lat: () => failure === "coordinates" ? 91 : selection.lat, lng: () => selection.lng },
          fetchFields: () => new Promise((resolve, reject) => setTimeout(() => {
            if (failure === "fetch") reject(new Error("Isolated place lookup failure"));
            else resolve({});
          }, delay)),
        };
      } } });
      this.dispatchEvent(select);
      if (this.dataset.selectionInput === "true") this.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  override setAttribute(name: string, value: string) {
    super.setAttribute(name, value);
    if (name === "aria-label") this.input.setAttribute(name, value);
  }
  get value() { return this.input.value; }
  set value(value: string) { this.input.value = value; }
}
customElements.define("gmp-place-autocomplete", Autocomplete);

class MapStub {
  constructor(private host: HTMLElement) { state.mapCreations += 1; host.style.background = "#e7ede7"; }
  getDiv() { return this.host; }
  fitBounds() { state.viewportChanges += 1; }
  panTo() { state.viewportChanges += 1; }
  setZoom() { state.viewportChanges += 1; }
  setOptions(options: { clickableIcons: boolean }) { state.clickableIcons = options.clickableIcons; }
}
class Marker {
  map: MapStub | null;
  title: string;
  constructor(options: { map: MapStub | null; title: string }) {
    this.map = options.map;
    this.title = options.title;
    state.markers.push(this);
  }
  setMap(map: MapStub | null) { this.map = map; }
  setPosition() {}
  setIcon() {}
  setZIndex() {}
  setTitle() {}
  addListener() { return { remove() {} }; }
}
class Polyline {
  map: MapStub | null;
  constructor(options: { map: MapStub | null }) { this.map = options.map; state.polylines.push(this); }
  setMap(map: MapStub | null) { this.map = map; }
}
Object.assign(window, { google: { maps: {
  Map: MapStub, Marker, Polyline,
  Point: class {}, Size: class {},
  LatLngBounds: class { extend() { return this; } },
  UnitSystem: { METRIC: 0 },
  SymbolPath: { CIRCLE: 0 },
  marker: { AdvancedMarkerElement: Marker },
  places: { PlaceAutocompleteElement: Autocomplete },
  geometry: { encoding: { decodePath: () => places } },
  importLibrary: async () => ({}),
} } });

const point = { lat: 48.1, lng: 17.1 };
function Fixture() {
  const [view, setView] = useState<"map" | "widget">(() => new URL(window.location.href).searchParams.has("widget") ? "widget" : "map");
  return <RoutePlannerProvider>
    <nav><button onClick={() => setView("map")}>Mapa skúšky</button><button onClick={() => setView("widget")}>Nástroj bez mapy</button></nav>
    <div style={{ height: "calc(100dvh - 30px)", padding: 8 }} hidden={view !== "map"}>
      <DispatchMapGoogle active={view === "map"}
        branches={[{ id: "branch", name: "Testovacia pobočka", address: "Adresa", phone: "", point, availableReplacementCars: 0 }]}
        assets={[{ id: "tow", kind: "tow_truck", label: "Testovacia odťahovka", licensePlate: "TEST", status: "available", branchId: "branch", point, lastSeen: "2026-09-09T10:00:00Z", capabilities: [] }]}
      />
    </div>
    {view === "widget" && <div style={{ padding: 8 }}><RoutePlanner embedded /></div>}
  </RoutePlannerProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
