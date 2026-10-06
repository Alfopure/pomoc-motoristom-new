import { afterEach, expect, it, vi } from "vitest";
const capture = vi.hoisted(() => vi.fn(async () => ({ accepted: true, eventId: "event" })));
vi.mock("./server/diagnostics/server-errors", () => ({ captureServerError: capture }));
import { onRequestError } from "./instrumentation";
afterEach(() => { vi.unstubAllEnvs(); capture.mockClear(); });
const context = { routerKind: "App Router", routePath: "/api/calls/[id]", routeType: "route", revalidateReason: undefined } as const;
it("awaits bounded server capture using framework template, without raw request metadata", async () => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); vi.stubEnv("DIAGNOSTICS_SERVER_ERRORS_ENABLED", "true");
  const error = new Error("private");
  await onRequestError(error, { path: "/api/calls/private?token=secret", method: "POST", headers: { authorization: "secret" } }, context);
  expect(capture).toHaveBeenCalledWith(error, { source: "next", route: "/api/calls/[id]", status: 500 });
});
it("does not load a Node client for Edge/disabled and preserves framework failure on collector error", async () => {
  vi.stubEnv("NEXT_RUNTIME", "edge"); vi.stubEnv("DIAGNOSTICS_SERVER_ERRORS_ENABLED", "true");
  await onRequestError(new Error(), { path: "/", method: "GET", headers: {} }, context);
  expect(capture).not.toHaveBeenCalled();
  vi.stubEnv("NEXT_RUNTIME", "nodejs"); capture.mockRejectedValueOnce(new Error("collector down"));
  await expect(onRequestError(new Error(), { path: "/", method: "GET", headers: {} }, context)).resolves.toBeUndefined();
});
