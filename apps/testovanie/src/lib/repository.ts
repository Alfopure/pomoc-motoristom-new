import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { get, put, BlobError, BlobPreconditionFailedError } from "@vercel/blob";
import { emptyStore } from "./service";
import type { Store } from "./model";
import { InputError } from "./validation";

export type Snapshot = { value: Store; etag: string | null };
export interface Repository {
  read(): Promise<Snapshot>;
  write(value: Store, etag: string | null): Promise<void>;
}
export class WriteConflict extends Error {}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

export class BlobRepository implements Repository {
  constructor(
    private token: string,
    private prefix: string,
  ) {
    if (!/^[a-z0-9_-]{1,60}$/.test(prefix))
      throw new Error("Invalid tracker storage prefix");
  }
  private get pathname() {
    return `${this.prefix}/tracker-v1.json`;
  }
  async read(): Promise<Snapshot> {
    const blob = await get(this.pathname, {
      access: "private",
      token: this.token,
      useCache: false,
    });
    if (!blob) return { value: emptyStore(), etag: null };
    if (!blob.stream || blob.statusCode !== 200)
      throw new Error("Blob read failed");
    const value: Store = await new Response(blob.stream).json();
    if (
      value.schema !== 1 ||
      !Array.isArray(value.events) ||
      !Array.isArray(value.runs)
    )
      throw new Error("Unsupported tracker store");
    return { value, etag: blob.blob.etag };
  }
  async write(value: Store, etag: string | null) {
    try {
      await put(this.pathname, JSON.stringify(value), {
        access: "private",
        token: this.token,
        addRandomSuffix: false,
        allowOverwrite: etag !== null,
        ...(etag ? { ifMatch: etag } : {}),
        contentType: "application/json",
      });
    } catch (error) {
      if (
        error instanceof BlobPreconditionFailedError ||
        (etag === null &&
          error instanceof BlobError &&
          /already exists/i.test(error.message))
      )
        throw new WriteConflict();
      throw error;
    }
  }
}

// Local development and E2E only. Never silently fall back to ephemeral disk in a deployment.
let fileQueue: Promise<unknown> = Promise.resolve();
export class FileRepository implements Repository {
  constructor(private filename: string) {}
  async read(): Promise<Snapshot> {
    try {
      const data = await readFile(this.filename, "utf8");
      return { value: JSON.parse(data), etag: digest(data) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { value: emptyStore(), etag: null };
      throw error;
    }
  }
  async write(value: Store, etag: string | null) {
    const work = fileQueue.then(async () => {
      const latest = await this.read();
      if (latest.etag !== etag) throw new WriteConflict();
      await mkdir(path.dirname(this.filename), { recursive: true });
      await writeFile(`${this.filename}.tmp`, JSON.stringify(value));
      await rename(`${this.filename}.tmp`, this.filename);
    });
    fileQueue = work.catch(() => {});
    await work;
  }
}

export function repository(): Repository {
  if (process.env.TRACKER_LOCAL_FILE && !process.env.VERCEL)
    return new FileRepository(process.env.TRACKER_LOCAL_FILE);
  if (!process.env.BLOB_READ_WRITE_TOKEN)
    throw new InputError(
      "Spoločné úložisko ešte nie je pripravené. Zápis nebol uložený.",
      503,
    );
  return new BlobRepository(
    process.env.BLOB_READ_WRITE_TOKEN,
    process.env.TRACKER_STORAGE_PREFIX ??
      (process.env.VERCEL_ENV === "production" ? "production" : "preview"),
  );
}

export async function mutate(
  repo: Repository,
  transform: (store: Store) => Store,
): Promise<Store> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const snapshot = await repo.read();
    const next = transform(snapshot.value);
    if (next === snapshot.value) return next;
    // Never drop old audit entries to stay under a limit.
    if (Buffer.byteLength(JSON.stringify(next)) > 12_000_000)
      throw new InputError(
        "Evidencia dosiahla kapacitu. Kontaktujte správcu; história zostáva zachovaná.",
        507,
      );
    try {
      await repo.write(next, snapshot.etag);
      return next;
    } catch (error) {
      if (!(error instanceof WriteConflict)) throw error;
    }
  }
  throw new InputError(
    "Práve ukladá viac kolegov. Vaše údaje zostali zachované, skúste uloženie znova.",
    409,
  );
}
