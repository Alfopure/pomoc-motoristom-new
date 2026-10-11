import { describe, expect, it } from "vitest";
import { createSessionStorage, memoryStorage } from "./session-storage";

describe("protected session persistence", () => {
  function setup() {
    const values = new Map<string, string>(); let generation = 0;
    const driver = { getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => { values.set(key, value); },
      removeItem: async (key: string) => { values.delete(key); } };
    return { values, driver, storage: createSessionStorage(driver, () => "generation-" + ++generation) };
  }
  it("roundtrips a large Unicode session within secure-store size limits", async () => {
    const { values, storage } = setup(); const session = JSON.stringify({ token: "a".repeat(6000), name: "Žofia 🚗".repeat(800) });
    await storage.setItem("session", session); expect(await storage.getItem("session")).toBe(session);
    expect([...values.values()].every(value => new TextEncoder().encode(value).length < 2048)).toBe(true);
    await storage.removeItem("session"); expect(values.size).toBe(0); expect(await storage.getItem("session")).toBeNull();
  });
  it("keeps the previous committed session when a refresh write fails", async () => {
    const { storage, driver, values } = setup(); await storage.setItem("session", "old-session");
    const write = driver.setItem; driver.setItem = async (key, value) => { if (key.endsWith(".1")) throw new Error("Keychain unavailable"); await write(key, value); };
    await expect(storage.setItem("session", "new-session".repeat(100))).rejects.toThrow("Keychain unavailable");
    expect(await storage.getItem("session")).toBe("old-session"); expect([...values.keys()].some(key => key.includes("generation-2"))).toBe(false);
  });
  it("serializes refresh and logout without resurrecting the session", async () => {
    const { storage, values } = setup();
    const write = storage.setItem("session", "new-session"); const logout = storage.removeItem("session");
    await Promise.all([write, logout]); expect(await storage.getItem("session")).toBeNull(); expect(values.size).toBe(0);
  });
  it("does not hydrate partial or malformed sessions", async () => {
    const { storage, values } = setup(); await storage.setItem("session", "data");
    values.delete("session.generation-1.0"); await expect(storage.getItem("session")).rejects.toThrow();
    values.set("session", "plaintext-session"); await expect(storage.getItem("session")).rejects.toThrow();
    await storage.removeItem("session"); expect(await storage.getItem("session")).toBeNull();
  });
  it("cleans the previous generation after successful replacement", async () => {
    const { storage, values } = setup(); await storage.setItem("session", "one"); await storage.setItem("session", "two");
    expect(await storage.getItem("session")).toBe("two"); expect([...values.keys()]).not.toContain("session.generation-1.0");
  });
  it("keeps browser-preview sessions in memory only", async () => {
    const storage = memoryStorage(); await storage.setItem("session", "data");
    expect(await storage.getItem("session")).toBe("data"); expect(await memoryStorage().getItem("session")).toBeNull();
  });
});
