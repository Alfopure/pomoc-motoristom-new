import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ member: vi.fn(), fetch: vi.fn() }));
vi.mock("@/server/api-auth", async original => ({
  ...await original<typeof import("@/server/api-auth")>(),
  requireDefaultMotoristOrgMember: mocks.member,
}));
import { MutationError } from "@/server/motorist-mutations";
import { POST } from "./route";

const origin = { lat: 48.1486, lng: 17.1077 };
const destination = { lat: 50.0755, lng: 14.4378 };
const vienna = { lat: 48.2082, lng: 16.3738 };
const brno = { lat: 49.1951, lng: 16.6068 };
const input = { origin, destination, intermediates: [vienna, brno] };
const googleRoute = { distanceMeters: 420123, duration: "15300.5s", polyline: { encodedPolyline: "test-polyline" }, legs: [{ distanceMeters: 80000, duration: "3600s" }] };
function request(body: unknown = input, requestOrigin = "https://dispatch.example.test") {
  return new Request("https://dispatch.example.test/api/maps/route", {
    method: "POST", headers: { Origin: requestOrigin, Host: "dispatch.example.test", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "test-server-key");
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.member.mockResolvedValue(undefined);
  mocks.fetch.mockResolvedValue(Response.json({ routes: [googleRoute] }));
});
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("routes only the supplied international points, in order, with current traffic", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  const [url, options] = mocks.fetch.mock.calls[0];
  expect(url).toBe("https://routes.googleapis.com/directions/v2:computeRoutes");
  const body = JSON.parse(options.body);
  const waypoint = (point: typeof origin) => ({ location: { latLng: { latitude: point.lat, longitude: point.lng } } });
  expect(body).toMatchObject({
    origin: waypoint(origin), destination: waypoint(destination), intermediates: [waypoint(vienna), waypoint(brno)],
    routingPreference: "TRAFFIC_AWARE_OPTIMAL", travelMode: "DRIVE", optimizeWaypointOrder: false,
  });
  expect(body.departureTime).toBeUndefined(); // Google defaults to the current request time.
  expect(options.cache).toBe("no-store");
  expect(options.signal).toBeInstanceOf(AbortSignal);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ distanceMeters: 420123, durationSeconds: 15300.5, encodedPolyline: "test-polyline", provider: "google-routes", calculatedAt: expect.any(String) });
});

it("accepts a direct journey with no intermediate stops", async () => {
  expect((await POST(request({ origin, destination }))).status).toBe(200);
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body).intermediates).toEqual([]);
});

it.each([null, {}, { origin, destination, intermediates: {} }, { origin, destination, intermediates: null },
  { ...input, origin: { lat: 91, lng: 17 } }, { ...input, destination: { lat: 50, lng: -181 } },
  { ...input, intermediates: [null] }, { ...input, intermediates: Array(26).fill(vienna) },
])("rejects invalid route input before contacting Google (%j)", async body => {
  expect((await POST(request(body))).status).toBe(400);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("rejects a foreign origin before auth or Google", async () => {
  expect((await POST(request(input, "https://foreign.example.test"))).status).toBe(403);
  expect(mocks.member).not.toHaveBeenCalled();
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([401, 403])("preserves access denial (%s)", async status => {
  mocks.member.mockRejectedValue(new MutationError("Access denied", status));
  expect((await POST(request())).status).toBe(status);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it("reports unavailable configuration without requesting a route", async () => {
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
  expect((await POST(request())).status).toBe(503);
  expect(mocks.fetch).not.toHaveBeenCalled();
});

it.each([{ routes: [] }, { routes: [{ ...googleRoute, duration: "invalid" }] }, { routes: [{ ...googleRoute, distanceMeters: -1 }] }, { routes: [{ ...googleRoute, polyline: {} }] }])("does not substitute invented distances for an unusable route", async result => {
  mocks.fetch.mockResolvedValue(Response.json(result));
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: expect.any(String) });
});

it("handles network failure and provider denial as recoverable errors", async () => {
  mocks.fetch.mockRejectedValueOnce(new Error("network failed"));
  expect((await POST(request())).status).toBe(502);
  mocks.fetch.mockResolvedValueOnce(Response.json({ error: { message: "Internal provider details" } }, { status: 403 }));
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(JSON.stringify(await response.json())).not.toContain("Internal provider details");
});

it("accepts a zero-length route without treating it as missing", async () => {
  mocks.fetch.mockResolvedValue(Response.json({ routes: [{ ...googleRoute, distanceMeters: 0, duration: "0s" }] }));
  expect((await POST(request())).status).toBe(200);
});
