import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";

let script: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: { resolveDir: process.cwd(), sourcefile: "customer-location-map-fixture.tsx", loader: "tsx", contents: `
      import { useState } from "react";
      import { createRoot } from "react-dom/client";
      import DispatchMapGoogle from "./src/components/dispatch/DispatchMapGoogle";
      import { dispatchCases, fleetAssets } from "./src/mock/seed";
      const state = { maps: [], markers: [], actions: [], pickup: null };
      class Autocomplete extends HTMLElement {}
      customElements.define("gps-test-autocomplete", Autocomplete);
      class MapStub {
        constructor(host, options) { this.host = host; this.center = options.center; state.maps.push(this); }
        setOptions() {}
        getDiv() { return this.host; }
        panTo(point) { this.center = point; state.actions.push({ type: "pan", point }); }
        setZoom(zoom) { this.zoom = zoom; state.actions.push({ type: "zoom", zoom }); }
        fitBounds(bounds) { this.center = bounds.points; state.actions.push({ type: "fit", points: bounds.points }); }
      }
      class Marker {
        constructor(options) { Object.assign(this, options); state.markers.push(this); }
        setMap(map) { this.map = map; }
        setPosition(position) { this.position = position; }
        setIcon(icon) { this.icon = icon; }
        setTitle(title) { this.title = title; }
        setZIndex(zIndex) { this.zIndex = zIndex; }
        addListener() { return { remove() {} }; }
      }
      window.google = { maps: {
        Map: MapStub, Marker, marker: { AdvancedMarkerElement: Marker }, SymbolPath: { CIRCLE: 0 }, UnitSystem: { METRIC: 0 },
        LatLngBounds: class { points = []; extend(point) { this.points.push(point); return this; } },
        places: { PlaceAutocompleteElement: Autocomplete }, importLibrary: async () => ({}),
      } };
      const seedCase = { ...dispatchCases[0], id: "gps-case-a", selectedAssetId: undefined };
      const shared = { label: "Poloha klienta", lat: 48.1486, lng: 17.1077, submittedAt: "2026-09-16T10:00:00Z", accuracyMeters: 25 };
      function Fixture() {
        const [active, setActive] = useState(!location.search.includes("inactive"));
        const [caseItem, setCase] = useState(seedCase);
        const [focus, setFocus] = useState(undefined);
        const [assets, setAssets] = useState(fleetAssets.filter(asset => asset.kind === "tow_truck").slice(0, 2));
        state.pickup = caseItem.pickup;
        Object.assign(state, {
          focus: (accuracyMeters = 25) => setFocus(previous => ({ caseId: caseItem.id, requestId: (previous?.requestId ?? 0) + 1, location: { ...shared, accuracyMeters } })),
          activate: () => setActive(true),
          switchCase: () => setCase({ ...seedCase, id: "gps-case-b" }),
          returnCase: () => setCase(seedCase),
          moveFleet: () => setAssets(previous => previous.map(asset => ({ ...asset, point: { lat: asset.point.lat + 0.01, lng: asset.point.lng + 0.01 } }))),
          refreshCase: () => setCase(previous => ({ ...previous, customerSharedLocation: { ...shared, lat: 49 } })),
        });
        return <DispatchMapGoogle active={active} caseItem={caseItem} assets={assets} branches={[]} customerLocationFocus={focus} workspaceMode="split" />;
      }
      window.customerMapTest = state;
      createRoot(document.getElementById("root")).render(<Fixture />);
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env": JSON.stringify({ NODE_ENV: "production", NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY: "isolated-browser-key" }) },
  });
  script = result.outputFiles[0].text;
});

type Point = { lat: number; lng: number };
type Boundary = {
  actions: Array<{ type: string; point?: Point; zoom?: number }>;
  markers: Array<{ map: object | null; title: string; position: Point }>;
  maps: Array<{ center: Point; zoom: number }>;
  pickup: unknown;
  focus: (accuracy?: number) => void;
  activate: () => void;
  switchCase: () => void;
  returnCase: () => void;
  moveFleet: () => void;
  refreshCase: () => void;
};
declare global { interface Window { customerMapTest: Boundary } }
async function boot(page: Page, query = "") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    if (route.request().url() === `https://customer-map.test/${query}`) return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div></body></html>' });
    errors.push(`Unexpected network: ${route.request().url()}`);
    return route.abort();
  });
  await page.goto(`https://customer-map.test/${query}`);
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("toolbar", { name: "Ovládanie mapy" })).toBeVisible();
  return errors;
}
const gpsMarkers = (page: Page) => page.evaluate(() => window.customerMapTest.markers.filter(marker => marker.map && marker.title === "GPS klienta — doplnková poloha").map(marker => marker.position));

test("customer GPS focuses repeatedly without replacing pickup or following fleet and location refreshes", async ({ page }) => {
  const errors = await boot(page);
  const pickup = await page.evaluate(() => window.customerMapTest.pickup);
  await page.getByRole("button", { name: "Odťahovky", exact: true }).click();
  await page.evaluate(() => window.customerMapTest.focus());
  await expect.poll(() => gpsMarkers(page)).toEqual([{ lat: 48.1486, lng: 17.1077 }]);
  await expect.poll(() => page.evaluate(() => window.customerMapTest.maps[0].center)).toEqual({ lat: 48.1486, lng: 17.1077 });
  await page.evaluate(() => { window.customerMapTest.moveFleet(); window.customerMapTest.refreshCase(); });
  await expect(page.getByRole("status")).toContainText("48.14860, 17.10770");
  expect(await page.evaluate(() => window.customerMapTest.maps[0].center)).toEqual({ lat: 48.1486, lng: 17.1077 });
  expect(await page.evaluate(() => window.customerMapTest.pickup)).toEqual(pickup);
  const pans = await page.evaluate(() => window.customerMapTest.actions.filter(action => action.type === "pan").length);
  await page.evaluate(() => window.customerMapTest.focus());
  await expect.poll(() => page.evaluate(() => window.customerMapTest.actions.filter(action => action.type === "pan").length)).toBe(pans + 1);
  await page.getByRole("button", { name: "Skryť GPS klienta na mape" }).click();
  await expect.poll(() => gpsMarkers(page)).toEqual([]);
  await page.evaluate(() => window.customerMapTest.focus());
  await expect.poll(() => gpsMarkers(page)).toHaveLength(1);
  await page.evaluate(() => window.customerMapTest.switchCase());
  await expect.poll(() => gpsMarkers(page)).toEqual([]);
  await expect(page.getByRole("button", { name: "Skryť GPS klienta na mape" })).toHaveCount(0);
  await page.evaluate(() => window.customerMapTest.returnCase());
  await expect(page.getByRole("button", { name: "Skryť GPS klienta na mape" })).toHaveCount(0);
  expect(await gpsMarkers(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test("customer GPS waits for an active map and dismisses a covering planner", async ({ page }) => {
  const errors = await boot(page, "?inactive");
  await page.evaluate(() => window.customerMapTest.focus(2_500));
  expect(await page.evaluate(() => window.customerMapTest.maps)).toEqual([]);
  await page.evaluate(() => window.customerMapTest.activate());
  await expect.poll(() => page.evaluate(() => window.customerMapTest.maps[0]?.zoom)).toBe(11);
  await page.getByRole("button", { name: "Plánovač", exact: true }).click();
  await expect(page.getByRole("region", { name: "Plánovač trasy" })).toBeVisible();
  await expect.poll(() => gpsMarkers(page)).toEqual([]);
  await page.evaluate(() => window.customerMapTest.focus());
  await expect(page.getByRole("region", { name: "Plánovač trasy" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.customerMapTest.maps[0].zoom)).toBe(16);
  await expect.poll(() => gpsMarkers(page)).toEqual([{ lat: 48.1486, lng: 17.1077 }]);
  expect(errors).toEqual([]);
});
