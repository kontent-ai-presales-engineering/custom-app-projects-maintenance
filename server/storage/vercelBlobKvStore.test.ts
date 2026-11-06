import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  del: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@vercel/blob", () => blob);

const { createVercelBlobKvStore } = await import("./vercelBlobKvStore.js");

beforeEach(() => {
  vi.resetAllMocks();
});

describe("Vercel Blob KV store", () => {
  it("writes private JSON without a random suffix and allows overwrite", async () => {
    await createVercelBlobKvStore("ns").setJson("audit/1", { a: 1 });

    expect(blob.put).toHaveBeenCalledWith("ns/audit/1", '{"a":1}', {
      access: "private",
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  });

  it("reads JSON from origin, and returns null when missing", async () => {
    blob.get.mockResolvedValueOnce({ statusCode: 200, stream: new Response('{"a":1}').body });
    blob.get.mockResolvedValueOnce(null);
    const store = createVercelBlobKvStore("ns");

    expect(await store.getJson("k")).toEqual({ a: 1 });
    expect(await store.getJson("missing")).toBeNull();
    expect(blob.get).toHaveBeenCalledWith("ns/k", { access: "private", useCache: false });
  });

  it("lists keys across pages without the namespace", async () => {
    blob.list
      .mockResolvedValueOnce({ blobs: [{ pathname: "ns/audit/2" }], hasMore: true, cursor: "c1" })
      .mockResolvedValueOnce({ blobs: [{ pathname: "ns/audit/1" }], hasMore: false });

    expect(await createVercelBlobKvStore("ns").listKeys("audit/")).toEqual(["audit/1", "audit/2"]);
    expect(blob.list).toHaveBeenLastCalledWith({ prefix: "ns/audit/", cursor: "c1" });
  });
});
