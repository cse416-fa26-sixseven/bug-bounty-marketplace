import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BlobContainer,
  BlobSourceStorage,
  LocalSourceStorage,
  assertStorageKey,
  chooseSourceStorage,
  createSourceStorage,
  MemorySourceStorage,
} from "./storage.js";

describe("LocalSourceStorage", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "bbm-storage-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips bytes under a nested key", async () => {
    const storage = new LocalSourceStorage(root);
    const bytes = Buffer.from("contract Vault {}");

    await storage.put("contracts/contract_1/abc.sol", bytes);

    expect(await storage.get("contracts/contract_1/abc.sol")).toEqual(bytes);
    expect(await readFile(path.join(root, "contracts/contract_1/abc.sol"))).toEqual(bytes);
  });

  it("returns null for a missing key", async () => {
    const storage = new LocalSourceStorage(root);
    expect(await storage.get("contracts/nope.sol")).toBeNull();
  });

  it("refuses a key that escapes the storage root", async () => {
    const storage = new LocalSourceStorage(root);
    await expect(storage.put("../outside.sol", Buffer.from("x"))).rejects.toThrow(
      /escapes the storage root/,
    );
  });
});

/** In-memory stand-in for @azure/storage-blob's ContainerClient. Records
 * the upload options and throws a 404-shaped RestError for missing blobs. */
class FakeContainer implements BlobContainer {
  readonly blobs = new Map<string, Buffer>();
  readonly uploads: Array<{ name: string; length: number; contentType?: string }> = [];
  failWith: unknown = null;

  getBlockBlobClient(name: string) {
    return {
      upload: async (
        body: Buffer,
        contentLength: number,
        options?: { blobHTTPHeaders?: { blobContentType?: string } },
      ) => {
        this.blobs.set(name, Buffer.from(body));
        this.uploads.push({
          name,
          length: contentLength,
          contentType: options?.blobHTTPHeaders?.blobContentType,
        });
        return {};
      },
      downloadToBuffer: async () => {
        if (this.failWith) throw this.failWith;
        const bytes = this.blobs.get(name);
        if (!bytes)
          throw Object.assign(new Error("BlobNotFound"), {
            statusCode: 404,
            details: { errorCode: "BlobNotFound" },
          });
        return Buffer.from(bytes);
      },
    };
  }
}

describe("BlobSourceStorage", () => {
  it("uploads a block blob under the key and reads it back", async () => {
    const container = new FakeContainer();
    const storage = new BlobSourceStorage(container);
    const bytes = Buffer.from("contract Vault {}");

    await storage.put("contracts/contract_1/abc.sol", bytes);

    expect(container.uploads).toEqual([
      {
        name: "contracts/contract_1/abc.sol",
        length: bytes.byteLength,
        contentType: "text/plain; charset=utf-8",
      },
    ]);
    expect(await storage.get("contracts/contract_1/abc.sol")).toEqual(bytes);
  });

  it("returns null when the blob does not exist", async () => {
    const storage = new BlobSourceStorage(new FakeContainer());
    expect(await storage.get("contracts/nope.sol")).toBeNull();
  });

  it("rethrows errors other than a missing blob", async () => {
    const container = new FakeContainer();
    const storage = new BlobSourceStorage(container);
    container.failWith = Object.assign(new Error("AuthorizationFailure"), { statusCode: 403 });
    await expect(storage.get("contracts/a.sol")).rejects.toThrow(/AuthorizationFailure/);
    // A missing container is a 404 too, but a deployment error, not a missing source.
    container.failWith = Object.assign(new Error("ContainerNotFound"), {
      statusCode: 404,
      details: { errorCode: "ContainerNotFound" },
    });
    await expect(storage.get("contracts/a.sol")).rejects.toThrow(/ContainerNotFound/);
  });

  it("refuses keys that are not plain relative paths", async () => {
    const container = new FakeContainer();
    const storage = new BlobSourceStorage(container);
    for (const key of ["../outside.sol", "/abs.sol", "a//b.sol", "a/./b.sol", "a\\b.sol", ""]) {
      await expect(storage.put(key, Buffer.from("x"))).rejects.toThrow(/escapes the storage root/);
      await expect(storage.get(key)).rejects.toThrow(/escapes the storage root/);
    }
    expect(container.uploads).toEqual([]);
  });
});

describe("assertStorageKey", () => {
  it("accepts the keys the api produces", () => {
    expect(() => assertStorageKey("contracts/contract_1/abc.sol")).not.toThrow();
    expect(() => assertStorageKey("pocs/poc_1/abc.t.sol")).not.toThrow();
  });
});

describe("chooseSourceStorage", () => {
  it("prefers the Blob container URL over the local directory", () => {
    expect(
      chooseSourceStorage({
        SOURCE_STORAGE_BLOB_CONTAINER_URL: "https://acct.blob.core.windows.net/sources",
        SOURCE_STORAGE_DIR: "/data/sources",
      }),
    ).toEqual({ kind: "blob", containerUrl: "https://acct.blob.core.windows.net/sources" });
  });

  it("uses the local directory when only SOURCE_STORAGE_DIR is set", () => {
    expect(chooseSourceStorage({ SOURCE_STORAGE_DIR: "/data/sources" })).toEqual({
      kind: "local",
      dir: "/data/sources",
    });
  });

  it("ignores blank values and falls back to memory", () => {
    expect(
      chooseSourceStorage({ SOURCE_STORAGE_BLOB_CONTAINER_URL: "  ", SOURCE_STORAGE_DIR: "" }),
    ).toEqual({ kind: "memory" });
    expect(chooseSourceStorage({})).toEqual({ kind: "memory" });
  });

  it("creates the matching storage without touching the network", () => {
    expect(createSourceStorage({ kind: "memory" })).toBeInstanceOf(MemorySourceStorage);
    expect(createSourceStorage({ kind: "local", dir: os.tmpdir() })).toBeInstanceOf(
      LocalSourceStorage,
    );
    // Building the client only parses the URL; no request is made.
    expect(
      createSourceStorage({
        kind: "blob",
        containerUrl: "https://acct.blob.core.windows.net/sources",
      }),
    ).toBeInstanceOf(BlobSourceStorage);
  });
});
