import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTE_AUTH_REGISTRY, PUBLIC_ROUTES } from "./route-auth-registry";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../app/api");

/** Rekurzívne nájde všetky `route.ts` pod `src/app/api` a vráti ich kľúče (cesta bez /route.ts). */
function discoverRouteKeys(dir: string, prefix = ""): string[] {
  const keys: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      keys.push(...discoverRouteKeys(path.join(dir, entry.name), relative));
    } else if (entry.isFile() && entry.name === "route.ts") {
      keys.push(prefix);
    }
  }

  return keys;
}

describe("route-auth-registry", () => {
  const discovered = discoverRouteKeys(API_ROOT).sort();
  const registered = Object.keys(ROUTE_AUTH_REGISTRY).sort();

  it("covers 100% of discovered src/app/api/**/route.ts (no route missing)", () => {
    const missing = discovered.filter((route) => !(route in ROUTE_AUTH_REGISTRY));
    expect(missing, `routes present on disk but absent from registry: ${missing.join(", ")}`).toEqual([]);
  });

  it("has no stale entries (every registry key exists on disk)", () => {
    const discoveredSet = new Set(discovered);
    const stale = registered.filter((route) => !discoveredSet.has(route));
    expect(stale, `registry keys with no route.ts on disk: ${stale.join(", ")}`).toEqual([]);
  });

  it("classifies commander sync/import-all as bearer (inline authorize + safeEquals)", () => {
    expect(ROUTE_AUTH_REGISTRY["integrations/commander/sync"].class).toBe("bearer");
    expect(ROUTE_AUTH_REGISTRY["integrations/commander/import-all"].class).toBe("bearer");
  });

  it("PUBLIC_ROUTES contains exactly the intentional public routes", () => {
    expect([...PUBLIC_ROUTES].sort()).toEqual([
      "auth/forgot-password",
      "health/live",
      "health/ready",
      "public/location-links/[token]",
      // Telnyx webhooky — autentifikáciou je Ed25519 podpis, nie session.
      "sms/telnyx/webhook",
      "telephony/telnyx/webhook",
    ].sort());
  });
});
