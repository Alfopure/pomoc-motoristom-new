/** All session bytes stay in Keychain/Keystore; large sessions are chunked. */
export type StorageDriver = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};
type Manifest = { generation: string; count: number };

export function createSessionStorage(driver: StorageDriver, generation: () => string): StorageDriver {
  let pending: Promise<unknown> = Promise.resolve();
  function queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation, operation);
    pending = result.catch(() => undefined);
    return result;
  }
  async function manifest(key: string): Promise<Manifest | null> {
    const raw = await driver.getItem(key);
    if (raw === null) return null;
    const data: Manifest = JSON.parse(raw);
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(data.generation) || !Number.isInteger(data.count) || data.count < 1 || data.count > 256) throw new Error("Invalid session storage");
    return data;
  }
  const chunkKey = (key: string, data: Manifest, index: number) => key + "." + data.generation + "." + index;
  async function cleanup(key: string, data: Manifest | null) {
    if (data) await Promise.allSettled(Array.from({ length: data.count }, (_, index) => driver.removeItem(chunkKey(key, data, index))));
  }
  return {
    getItem: key => queue(async () => {
      const data = await manifest(key);
      if (!data) return null;
      const chunks = await Promise.all(Array.from({ length: data.count }, (_, index) => driver.getItem(chunkKey(key, data, index))));
      if (chunks.some(chunk => chunk === null)) throw new Error("Incomplete session storage");
      return chunks.join("");
    }),
    setItem: (key, value) => queue(async () => {
      const old = await manifest(key);
      // 400 Unicode code points <= 1600 UTF-8 bytes, below old iOS 2 KiB limits.
      const points = Array.from(value);
      const count = Math.max(1, Math.ceil(points.length / 400));
      if (count > 256) throw new Error("Session is too large");
      const next = { generation: generation(), count };
      try {
        for (let index = 0; index < count; index++) {
          await driver.setItem(chunkKey(key, next, index), points.slice(index * 400, (index + 1) * 400).join(""));
        }
        // Commit only after every chunk; a failed refresh keeps the old session.
        await driver.setItem(key, JSON.stringify(next));
      } catch (error) { await cleanup(key, next); throw error; }
      await cleanup(key, old);
    }),
    removeItem: key => queue(async () => {
      // Explicit reset must also remove a corrupt manifest. Unknown orphan
      // chunks remain encrypted and cannot hydrate without the manifest.
      let data: Manifest | null = null;
      try { data = await manifest(key); } catch { /* Remove the authority key below. */ }
      await driver.removeItem(key);
      await cleanup(key, data);
    }),
  };
}

/** Browser previews keep sessions in memory only; no plaintext persistence. */
export function memoryStorage(): StorageDriver {
  const values = new Map<string, string>();
  return {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async key => { values.delete(key); },
  };
}
