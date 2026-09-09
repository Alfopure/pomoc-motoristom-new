import { beforeEach, expect, it, vi } from "vitest";
import { get, put, BlobError, BlobPreconditionFailedError } from "@vercel/blob";
import { BlobRepository, WriteConflict } from "./repository";
import { emptyStore } from "./service";

vi.mock("@vercel/blob", () => ({
  get: vi.fn(),
  put: vi.fn(),
  BlobError: class extends Error {},
  BlobPreconditionFailedError: class extends Error {},
}));
beforeEach(() => vi.resetAllMocks());
function response(etag: string) {
  return {
    statusCode: 200,
    stream: new Response(JSON.stringify(emptyStore())).body,
    headers: new Headers(),
    blob: { etag },
  } as NonNullable<Awaited<ReturnType<typeof get>>>;
}
it("reads an uncached identity representation for a usable strong ETag", async () => {
  vi.mocked(get).mockResolvedValue(response('"strong-version"'));
  const repo = new BlobRepository("test-token", "preview");
  const snapshot = await repo.read();
  expect(get).toHaveBeenCalledWith(
    "preview/tracker-v1.json",
    expect.objectContaining({
      useCache: false,
      headers: { "accept-encoding": "identity" },
    }),
  );
  expect(snapshot.etag).toBe('"strong-version"');
  await repo.write(snapshot.value, snapshot.etag);
  expect(put).toHaveBeenCalledWith(
    "preview/tracker-v1.json",
    expect.any(String),
    expect.objectContaining({
      allowOverwrite: true,
      ifMatch: '"strong-version"',
      access: "private",
    }),
  );
});
it("fails clearly on a weak ETag rather than silently stripping its meaning", async () => {
  vi.mocked(get).mockResolvedValue(response('W/"compressed-version"'));
  await expect(
    new BlobRepository("test-token", "preview").read(),
  ).rejects.toThrow("strong ETag");
  expect(put).not.toHaveBeenCalled();
});
it("translates real storage preconditions into retryable conflicts", async () => {
  const repo = new BlobRepository("test-token", "preview");
  vi.mocked(put).mockRejectedValueOnce(new BlobPreconditionFailedError());
  await expect(
    repo.write(emptyStore(), '"old-version"'),
  ).rejects.toBeInstanceOf(WriteConflict);
  vi.mocked(put).mockRejectedValueOnce(
    new BlobError("The blob already exists"),
  );
  await expect(repo.write(emptyStore(), null)).rejects.toBeInstanceOf(
    WriteConflict,
  );
});
it("does not misreport an actual service outage as a user conflict", async () => {
  vi.mocked(put).mockRejectedValue(new BlobError("Service unavailable"));
  await expect(
    new BlobRepository("test-token", "preview").write(
      emptyStore(),
      '"version"',
    ),
  ).rejects.toThrow("Service unavailable");
});
