import { afterEach, describe, expect, it, vi } from "vitest";

import { telephonyJson } from "@/lib/telephony/client-request";
import { loadRoutingConfig, saveRoutingConfig } from "./config-client";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const routing = (version: number) => ({ document: { routingVersion: version, ringGroups: [] }, canEdit: true, canManageSettings: false });

/** A fetch whose responses the test releases one by one. */
function controlledFetch() {
  const pending: Array<{ url: string; method: string; resolve: (body: unknown) => void }> = [];
  const fetch = vi.fn((url: string, init?: RequestInit) => new Promise<Response>((resolve) => {
    pending.push({ url, method: init?.method ?? "GET", resolve: (body) => resolve(Response.json(body)) });
  }));
  vi.stubGlobal("fetch", fetch);
  return { fetch, pending };
}

const settle = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

describe("routing config reads", () => {
  it("shares one request between panels that read the same section at the same time", async () => {
    const { fetch, pending } = controlledFetch();
    const first = loadRoutingConfig("ringGroups");
    const second = loadRoutingConfig("ringGroups");
    const other = loadRoutingConfig("incoming");
    await settle();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/telephony/config/ring-groups", "/api/telephony/config/incoming"]);

    pending[0].resolve(routing(1));
    pending[1].resolve(routing(1));
    await expect(first).resolves.toMatchObject({ document: { routingVersion: 1 } });
    await expect(second).resolves.toMatchObject({ document: { routingVersion: 1 } });
    await other;

    // Once settled, the next read is a fresh request.
    const later = loadRoutingConfig("ringGroups");
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    pending[2].resolve(routing(2));
    await expect(later).resolves.toMatchObject({ document: { routingVersion: 2 } });
  });

  it("never hands a read started after a save the document from before it", async () => {
    const { fetch, pending } = controlledFetch();
    const before = loadRoutingConfig("ringGroups");
    await settle();
    const save = saveRoutingConfig("ringGroups", { version: 1 });
    await settle();
    pending[1].resolve(routing(2));
    await save;
    const after = loadRoutingConfig("ringGroups");
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    pending[0].resolve(routing(1));
    pending[2].resolve(routing(2));
    await expect(before).resolves.toMatchObject({ document: { routingVersion: 1 } });
    await expect(after).resolves.toMatchObject({ document: { routingVersion: 2 } });
  });

  it("does not share across a write made by another panel's telephony request", async () => {
    const { fetch, pending } = controlledFetch();
    const before = loadRoutingConfig("ringGroups");
    await settle();
    const pause = telephonyJson("/api/telephony/presence", { method: "POST", body: "{}", label: "test", timeoutMs: 1_000 });
    await settle();
    pending[1].resolve({ ok: true });
    await pause;
    const after = loadRoutingConfig("ringGroups");
    await settle();
    expect(fetch).toHaveBeenCalledTimes(3);
    pending[0].resolve(routing(1));
    pending[2].resolve(routing(2));
    await expect(before).resolves.toMatchObject({ document: { routingVersion: 1 } });
    await expect(after).resolves.toMatchObject({ document: { routingVersion: 2 } });
  });

  it("lets one caller abort without cancelling the read another panel waits for", async () => {
    const { fetch, pending } = controlledFetch();
    const controller = new AbortController();
    const leaving = loadRoutingConfig("ringGroups", { signal: controller.signal });
    const staying = loadRoutingConfig("ringGroups");
    await settle();
    controller.abort();
    await expect(leaving).rejects.toMatchObject({ name: "AbortError" });
    pending[0].resolve(routing(3));
    await expect(staying).resolves.toMatchObject({ document: { routingVersion: 3 } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
