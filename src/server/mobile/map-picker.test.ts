import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "@/test/fake-supabase";
import { MutationError } from "@/server/mutation-error";
import { GET } from "@/app/api/mobile/v1/maps/picker/route";
import { mobileMapPicker } from "./map-picker";

const mocks = vi.hoisted(() => ({ actor: vi.fn(), admin: vi.fn() }));
vi.mock("./auth", () => ({ requireMobileActor: mocks.actor, mobileEnvironment: () => "test" }));
vi.mock("@/lib/supabase/admin", () => ({ createSupabaseAdminClient: mocks.admin }));
const id = (n: number) => `83000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const actor = { organizationId: id(1), profileId: id(2), userId: id(3), role: "dispatcher" as const, displayName: "Jana" };
const canonical = "https://test.dispecing.linkapomoci.sk", path = "/api/mobile/v1/maps/picker";
const headers = { Authorization: "Bearer NEVER_EMBED_USER_JWT", "X-PM-App-Environment": "test", "X-PM-Expected-Organization": actor.organizationId,
  "X-PM-Map-Mode": "pick", "X-PM-Map-Target": "pickup", "X-PM-Map-Nonce": id(4) };
const place = { label: "Miesto", address: "Adresa", lat: 48, lng: 17, provider: "manual" };
const request = (query = "", override: Record<string, string | undefined> = {}, origin = canonical) => new Request(origin + path + query, {
  headers: { ...headers, ...Object.fromEntries(Object.entries(override).filter((entry): entry is [string, string] => entry[1] !== undefined)) },
});
function fixture() {
  const f = createFakeSupabase(); mocks.admin.mockReturnValue(f.admin); return f;
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.actor.mockResolvedValue(actor);
  vi.stubEnv("MOTORIST_APP_ENV", "test"); vi.stubEnv("VERCEL_ENV", "production"); vi.stubEnv("VERCEL_GIT_COMMIT_REF", "dev");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_EZKlWCdDXJQNJuYryc4z1mVDKIhk"); vi.stubEnv("APP_BASE_URL", canonical);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://nzpnqdstvkfncflgqlny.supabase.co"); vi.stubEnv("MOTORIST_TEST_LIVE_INTEGRATIONS", "true");
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY", "fake-public-browser-key");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("protected mobile Google browser surface", () => {
  it("authenticates before query validation, provider guards or case reads", async () => {
    const f = fixture(); mocks.actor.mockRejectedValue(new MutationError("Prihláste sa.", 401));
    const response = await GET(request("?jwt=forged"));
    expect(response.status).toBe(401); expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(response.headers.get("cache-control")).toContain("no-store"); expect(f.db.log).toHaveLength(0);
  });
  it.each(["?token=secret", "?caseId=bad", `?caseId=${id(5)}&caseId=${id(5)}`, "?mode=pick", "?caseId="])("rejects unsupported URL data %s", async query => {
    fixture(); expect((await GET(request(query))).status).toBe(400); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each([{ "X-PM-Map-Mode": "edit" }, { "X-PM-Map-Target": "anything" }, { "X-PM-Map-Nonce": "bad" }, { "X-PM-Map-Nonce": "" }])("rejects malformed map headers %j", async override => {
    fixture(); expect((await GET(request("", override))).status).toBe(400); expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["", id(90)])("requires an already authenticated expected organization: %s", async organization => {
    fixture(); const response = await GET(request("", { "X-PM-Expected-Organization": organization }));
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "expected_organization_mismatch" });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it.each(["http://test.dispecing.linkapomoci.sk", "https://preview.vercel.app", "https://dispecing.linkapomoci.sk", "https://test.dispecing.linkapomoci.sk:444"])("refuses noncanonical map origin %s", async origin => {
    fixture(); expect((await GET(request("", {}, origin))).status).toBe(400);
  });
  it.each([["VERCEL_ENV", "preview"], ["MOTORIST_TEST_LIVE_INTEGRATIONS", "false"], ["VERCEL_PROJECT_ID", "other"], ["NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY", ""],
    ["NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY", "replace-with-key"], ["NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY", "bad<key\"injection"]])("keeps unavailable provider configuration fail-closed %s", async (key, value) => {
    fixture(); vi.stubEnv(key, value);
    const response = await GET(request()); expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "mobile_maps_unavailable" });
    expect(mocks.admin).not.toHaveBeenCalled();
  });
  it("returns private scoped HTML with nonce CSP, origin-only referrer and no auth material", async () => {
    fixture(); const response = await GET(request()), html = await response.text();
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toContain("X-PM-Map-Nonce");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    expect(response.headers.get("permissions-policy")).toContain("geolocation=()");
    const nonce = html.match(/<script nonce="([^"]+)">/)?.[1];
    expect(nonce).toBeTruthy(); expect(html).toContain(`<style nonce="${nonce}">`);
    expect(response.headers.get("content-security-policy")).toContain(`script-src 'nonce-${nonce}'`);
    expect(html).toContain("fake-public-browser-key"); expect(html).toContain(actor.profileId);
    expect(html).not.toMatch(/NEVER_EMBED_USER_JWT|Authorization|Bearer|Cookie|supabase\.co/);
    const second = await (await GET(request())).text(); expect(second).not.toContain(`<script nonce="${nonce}">`);
  });
  it("does not load foreign cases or leak their raw location metadata", async () => {
    const f = fixture(); f.db.seed("motorist_cases", [{ id: id(5), organization_id: id(90) }]);
    expect((await GET(request(`?caseId=${id(5)}`))).status).toBe(404);
  });
  it("safely serializes an authorized malicious label without executable HTML or private location metadata", async () => {
    const f = fixture();
    f.db.seed("motorist_cases", [{ id: id(5), organization_id: actor.organizationId, owner_id: actor.profileId, pickup_location_id: id(6),
      case_number: "PM", status: "open", priority: "normal", created_at: "2026-10-12T18:00:00Z", updated_at: "2026-10-12T18:00:00Z",
      customer_details: {}, vehicle_details: {}, incident_details: {}, location_details: {}, replacement_vehicle_details: {}, payment_details: {}, closure_details: {}, attachments_metadata: [] }]);
    f.db.seed("motorist_locations", [{ id: id(6), organization_id: actor.organizationId, label: "</script><script>globalThis.PWNED=1</script>",
      address: "<img src=x onerror=alert(1)>", lat: 0, lng: 0, provider: "manual", metadata: { token: "PRIVATE_LINK" } }]);
    const html = await (await GET(request(`?caseId=${id(5)}`, { "X-PM-Map-Mode": "view" }))).text();
    expect(html.match(/<script /g)).toHaveLength(1);
    expect(html).not.toContain("<script>globalThis.PWNED"); expect(html).not.toContain("PRIVATE_LINK");
    const h = browser(html); expect(h.global.PWNED).toBeUndefined(); expect(h.messages[0]).toMatchObject({ type: "ready", caseId: id(5) });
    await h.seed(); await h.ready();
    expect(h.maps[0]).toMatchObject({ options: { mapId: "DEMO_MAP_ID" } });
    expect(h.markers[0]).toMatchObject({ position: { lat: 0, lng: 0 }, content: { textContent: "P", className: "pin" }, title: "<img src=x onerror=alert(1)>" });
  });
});

type Handler = (event: Record<string, unknown>) => unknown;
class Element {
  handlers = new Map<string, Handler[]>(); children: Element[] = []; value = ""; textContent = ""; className = ""; disabled = true; nonce = "test-nonce"; src = ""; async = false;
  addEventListener(name: string, handler: Handler) { this.handlers.set(name, [...this.handlers.get(name) ?? [], handler]); }
  dispatch(name: string, event: Record<string, unknown> = {}) { return Promise.all((this.handlers.get(name) ?? []).map(handler => handler(event))); }
  appendChild(element: Element) { this.children.push(element); }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function browser(html: string) {
  const elements = Object.fromEntries(["map", "status", "address", "confirm", "search"].map(key => [key, new Element()]));
  const document = new Element() as Element & { head: Element; getElementById: (id: string) => Element; createElement: () => Element; querySelector: () => Element };
  document.head = new Element(); document.getElementById = key => elements[key]; document.createElement = () => new Element(); document.querySelector = () => new Element();
  const messages: Record<string, unknown>[] = [], maps: Element[] = [], markers: Record<string, unknown>[] = [], timers = new Map<number, () => void>();
  const window = new Element() as Element & Record<string, unknown>;
  let timerId = 0;
  Object.assign(window, { ReactNativeWebView: { postMessage: (data: string) => messages.push(JSON.parse(data)) }, setTimeout: (callback: () => void) => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: (id: number) => timers.delete(id) });
  const geocode = vi.fn();
  const importLibrary = vi.fn().mockResolvedValue({});
  class BrowserMap extends Element {
    constructor(_element: unknown, readonly options: Record<string, unknown>) { super(); maps.push(this); if (!options.mapId) throw new Error("Map ID required"); }
    addListener(name: string, handler: Handler) { this.addEventListener(name, handler); }
    panTo = vi.fn(); setZoom = vi.fn(); setCenter = vi.fn(); fitBounds = vi.fn();
  }
  const google = { maps: { importLibrary, Map: BrowserMap,
    marker: { AdvancedMarkerElement: class {
      constructor(private options: Record<string, unknown>) { if (!importLibrary.mock.calls.some(([library]) => library === "marker")) throw new Error("Marker library required"); markers.push(options); }
      set position(value: unknown) { this.options.position = value; }
      get position() { return this.options.position; }
    } },
    LatLngBounds: class { extend = vi.fn(); getCenter = () => ({ lat: 0, lng: 0 }); },
    places: { PlaceAutocompleteElement: Element } } };
  Object.defineProperty(google.maps, "Geocoder", { get: () => { geocode(); throw new Error("Manual points must not use reverse geocoding"); } });
  const global: Record<string, unknown> = { window, document, google, URLSearchParams };
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Missing emitted browser program");
  runInNewContext(script, global);
  const scope = { ...messages[0] }; delete scope.type;
  const seed = (override: Record<string, unknown> = {}) => document.dispatch("message", { data: JSON.stringify({ ...scope, type: "seed", selection: null, address: "Draft address", ...override }) });
  const ready = () => (window.__pmMapReady as () => Promise<void>)();
  return { elements, document, window, global, messages, maps, markers, geocode, importLibrary, timers, seed, ready,
    click: (lat: number, lng: number) => maps[0].dispatch("click", { latLng: { lat: () => lat, lng: () => lng } }) };
}

describe("actual serialized Google browser program with controlled adapters", () => {
  async function setup(mode = "pick") { fixture(); return browser(await (await mobileMapPicker(request("", { "X-PM-Map-Mode": mode }), actor)).text()); }
  it("keeps manual taps independent of reverse geocoding and uses the current marker library", async () => {
    const h = await setup(); await h.seed(); await h.ready(); await h.click(48, 17); await h.elements.confirm.dispatch("click");
    expect(h.geocode).not.toHaveBeenCalled();
    expect(h.importLibrary).toHaveBeenCalledWith("marker");
    expect(h.messages.at(-1)).toMatchObject({ selection: { provider: "manual", address: "48.000000, 17.000000" } });
  });
  it("keeps recoverable Places failure local so manual map selection remains usable", async () => {
    const h = await setup(); await h.seed(); await h.ready(); await h.elements.search.children[0].dispatch("gmp-error");
    expect(h.messages.some(item => item.type === "error")).toBe(false);
    expect(h.elements.status.textContent).toContain("Bod môžete vybrať");
    await h.click(48, 17); await h.elements.confirm.dispatch("click"); expect(h.messages.at(-1)?.type).toBe("candidate");
  });
  it("remains self-contained after installed Next SWC ES2017 production minification", async () => {
    const swc = await import("next/dist/build/swc"); await swc.loadBindings();
    const output = await swc.transform(readFileSync("src/server/mobile/map-picker-script.ts", "utf8"), {
      filename: "map-picker-script.ts", jsc: { parser: { syntax: "typescript" }, target: "es2017", minify: { compress: true, mangle: true } }, module: { type: "commonjs" }, minify: true,
    });
    const exports: { runMobileMapPicker?: () => void } = {};
    runInNewContext(output.code, { exports });
    const configuration = { version: 1, nonce: id(4), mode: "pick", target: "pickup", environment: "test", profileId: actor.profileId,
      organizationId: actor.organizationId, caseId: null, browserKey: "fake-public-browser-key", mapId: "DEMO_MAP_ID", map: { pickup: null, destination: null, clientLocation: null } };
    const h = browser(`<script nonce="x">(${exports.runMobileMapPicker!.toString()})(${JSON.stringify(configuration)});</script>`);
    await h.seed(); await h.ready(); await h.click(48, 17); await h.elements.confirm.dispatch("click");
    expect(h.messages.at(-1)).toMatchObject({ type: "candidate", selection: { lat: 48, lng: 17 } });
  });
  it("emits exact nonsecret ready and waits for one matching scoped seed before loading any resource", async () => {
    const h = await setup();
    expect(h.messages).toEqual([{ version: 1, nonce: id(4), mode: "pick", target: "pickup", environment: "test", profileId: actor.profileId, organizationId: actor.organizationId, caseId: null, type: "ready" }]);
    for (const changed of [{ nonce: id(90) }, { target: "destination" }, { profileId: id(90) }, { organizationId: id(90) }, { environment: "production" }, { caseId: id(90) },
      { mode: "view" }, { type: "candidate" }, { extra: true }, { selection: { ...place, lat: "48" } }, { address: "x\uD800" }]) await h.seed(changed);
    expect(h.document.head.children).toHaveLength(0);
    await h.seed(); await h.seed(); expect(h.document.head.children).toHaveLength(1);
    expect(h.document.head.children[0].src).toContain("https://maps.googleapis.com/maps/api/js?");
    expect(h.document.head.children[0].src).not.toMatch(/Bearer|NEVER_EMBED|caseId|organization/);
    expect(h.document.head.children[0].nonce).toBe("test-nonce");
  });
  it("requires a valid point and explicit confirm before emitting a candidate, never a save", async () => {
    const h = await setup(); await h.seed(); await h.ready();
    await h.elements.confirm.dispatch("click"); expect(h.messages.filter(item => item.type === "candidate")).toHaveLength(0);
    await h.click(0, 0); expect(h.messages.filter(item => item.type === "candidate")).toHaveLength(0);
    await h.elements.confirm.dispatch("click");
    expect(h.messages.at(-1)).toMatchObject({ type: "candidate", nonce: id(4), target: "pickup", selection: { lat: 0, lng: 0, address: "0.000000, 0.000000", provider: "manual" } });
  });
  it("ignores a late Places result after a later Places selection", async () => {
    const h = await setup(); await h.seed(); await h.ready();
    const older = deferred<void>();
    const event = (latitude: number, promise: Promise<void>) => ({ placePrediction: { toPlace: () => ({ fetchFields: () => promise, displayName: "Place", formattedAddress: "Google address", location: { lat: () => latitude, lng: () => 17 }, id: "place-id" }) } });
    const a = h.elements.search.children[0].dispatch("gmp-select", event(48, older.promise));
    await h.elements.search.children[0].dispatch("gmp-select", event(49, Promise.resolve()));
    older.resolve(); await a;
    await h.elements.confirm.dispatch("click"); expect(h.messages.at(-1)).toMatchObject({ selection: { lat: 49, lng: 17, address: "Google address", provider: "google_places" } });
  });
  it("allows correction after clearing an operator address without changing point/provenance", async () => {
    const h = await setup(); await h.seed(); await h.ready();
    await h.click(48, 17);
    h.elements.address.value = ""; await h.elements.address.dispatch("input"); expect(h.elements.confirm.disabled).toBe(true);
    h.elements.address.value = "Operator address"; await h.elements.address.dispatch("input");
    await h.elements.confirm.dispatch("click"); expect(h.messages.at(-1)).toMatchObject({ selection: { address: "Operator address", lat: 48, lng: 17, provider: "manual" } });
  });
  it("fences a pending Place fetch after a map tap and after page close", async () => {
    const h = await setup(); await h.seed(); await h.ready();
    const fetch = deferred<void>();
    const result = h.elements.search.children[0].dispatch("gmp-select", { placePrediction: { toPlace: () => ({ fetchFields: () => fetch.promise, displayName: "Old", formattedAddress: "Old", location: { lat: () => 1, lng: () => 1 }, id: "place" }) } });
    await h.click(48, 17); fetch.resolve(); await result; await h.elements.confirm.dispatch("click");
    expect(h.messages.at(-1)).toMatchObject({ selection: { lat: 48, lng: 17, provider: "manual" } });
    const later = deferred<void>();
    const pending = h.elements.search.children[0].dispatch("gmp-select", { placePrediction: { toPlace: () => ({ fetchFields: () => later.promise, displayName: "Late", formattedAddress: "Late", location: { lat: () => 49, lng: () => 19 }, id: "later" }) } });
    await h.window.dispatch("pagehide"); const count = h.messages.length;
    later.resolve(); await pending; await h.elements.confirm.dispatch("click"); expect(h.messages).toHaveLength(count);
  });
  it("supports Google place fields without allowing malformed candidates or coercion", async () => {
    const h = await setup(); await h.seed(); await h.ready();
    const event = (lat: unknown) => ({ placePrediction: { toPlace: () => ({ fetchFields: async () => undefined, displayName: "<b>Name</b>", formattedAddress: "Address", location: { lat: () => lat, lng: () => 17 }, id: "place-id" }) } });
    await h.elements.search.children[0].dispatch("gmp-select", event("48")); await h.elements.confirm.dispatch("click");
    expect(h.messages.some(item => item.type === "error" || item.type === "candidate")).toBe(false);
    expect(h.elements.status.textContent).toContain("nepodarilo overiť");
    await h.elements.search.children[0].dispatch("gmp-select", event(48)); await h.elements.confirm.dispatch("click");
    expect(h.messages.at(-1)).toMatchObject({ selection: { label: "<b>Name</b>", address: "Address", provider: "google_places", placeId: "place-id" } });
  });
  it.each(["pagehide", "authentication failure"])("starts no Place lookup from queued events after %s", async reason => {
    const h = await setup(); await h.seed(); await h.ready();
    if (reason === "pagehide") await h.window.dispatch("pagehide");
    else (h.window.gm_authFailure as () => void)();
    const toPlace = vi.fn(() => ({ fetchFields: vi.fn(async () => undefined) }));
    const count = h.messages.length;
    await h.elements.search.children[0].dispatch("gmp-select", { placePrediction: { toPlace } });
    await h.elements.search.children[0].dispatch("input");
    await h.elements.search.children[0].dispatch("gmp-error");
    expect(toPlace).not.toHaveBeenCalled();
    expect(h.messages).toHaveLength(count);
  });
  it("keeps manual point entry available if the Places library fails and never edits in view mode", async () => {
    const h = await setup(); await h.seed(); h.importLibrary.mockImplementation(async library => { if (library === "places") throw new Error("private provider failure"); }); await h.ready();
    expect(h.messages.some(item => item.type === "error")).toBe(false);
    await h.click(48, 17); await h.elements.confirm.dispatch("click");
    expect(h.messages.at(-1)).toMatchObject({ selection: { lat: 48, lng: 17, address: "48.000000, 17.000000" } });
    const view = await setup("view"); await view.seed({ selection: place }); await view.ready();
    await view.elements.confirm.dispatch("click"); await view.click(48, 17);
    expect(view.messages.some(item => item.type === "candidate")).toBe(false); expect(view.elements.search.children).toHaveLength(0);
  });
  it("bounds Places lookup and fences late initialization after timeout or provider authentication failure", async () => {
    const h = await setup(); await h.seed(); await h.ready();
    const lookup = deferred<void>();
    const pending = h.elements.search.children[0].dispatch("gmp-select", { placePrediction: { toPlace: () => ({ fetchFields: () => lookup.promise }) } });
    [...h.timers.values()][0](); await pending;
    expect(h.messages.some(item => item.type === "error")).toBe(false);
    await h.click(48, 17); await h.elements.confirm.dispatch("click"); expect(h.messages.at(-1)).toMatchObject({ selection: { address: "48.000000, 17.000000" } });
    (h.window.gm_authFailure as () => void)(); const count = h.messages.length;
    await h.click(49, 18); await h.elements.confirm.dispatch("click"); expect(h.messages).toHaveLength(count);
    const late = await setup(); await late.seed(); [...late.timers.values()][0](); await late.ready();
    expect(late.maps).toHaveLength(0); expect(late.messages.at(-1)?.type).toBe("error");
  });
});
