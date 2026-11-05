import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { ContainerClient } from "@azure/storage-blob";

/**
 * Object storage for uploaded Solidity sources. Postgres keeps the metadata
 * and the sha256; the bytes live here. The local-disk implementation backs
 * dev, tests and the compose stack; on AKS the Blob implementation lets the
 * analysis worker read what the API wrote. Keys are relative POSIX paths
 * (`contracts/<id>/<sha256>.sol`, `pocs/<id>/<sha256>.t.sol`).
 */
export interface SourceStorage {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

/** Holds objects in process memory. Default for tests and for `buildApp()`
 * when no storage is configured. */
export class MemorySourceStorage implements SourceStorage {
  private readonly objects = new Map<string, Buffer>();

  async put(key: string, bytes: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(bytes));
  }

  async get(key: string): Promise<Buffer | null> {
    const bytes = this.objects.get(key);
    return bytes ? Buffer.from(bytes) : null;
  }
}

/** Writes objects under a root directory. Keys are relative paths, so a key
 * that escapes the root is refused. */
export class LocalSourceStorage implements SourceStorage {
  constructor(private readonly rootDir: string) {}

  async put(key: string, bytes: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private resolve(key: string): string {
    const root = path.resolve(this.rootDir);
    const target = path.resolve(root, key);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`Storage key escapes the storage root: ${key}`);
    }
    return target;
  }
}

/** The one blob operation pair the Blob storage needs. `ContainerClient`
 * from @azure/storage-blob satisfies it; tests pass a fake. */
export interface BlobContainer {
  getBlockBlobClient(blobName: string): {
    upload(
      body: Buffer,
      contentLength: number,
      options?: { blobHTTPHeaders?: { blobContentType?: string } },
    ): Promise<unknown>;
    downloadToBuffer(): Promise<Buffer>;
  };
}

/** Rejects keys that are not plain relative paths. Blob names have no
 * directory semantics, but the same keys are read by the worker and by the
 * local-disk storage, so `..`, absolute paths and backslashes are refused
 * here too. */
export function assertStorageKey(key: string): void {
  const segments = key.split("/");
  const bad =
    key === "" ||
    key.startsWith("/") ||
    key.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (bad) throw new Error(`Storage key escapes the storage root: ${key}`);
}

/** Stores objects as block blobs in one container. Authenticates with the
 * ambient Azure identity (workload identity on AKS), never with a key. */
export class BlobSourceStorage implements SourceStorage {
  constructor(private readonly container: BlobContainer) {}

  /** `containerUrl` is `https://<account>.blob.core.windows.net/<container>`. */
  static fromContainerUrl(containerUrl: string): BlobSourceStorage {
    return new BlobSourceStorage(new ContainerClient(containerUrl, new DefaultAzureCredential()));
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    assertStorageKey(key);
    await this.container.getBlockBlobClient(key).upload(bytes, bytes.byteLength, {
      blobHTTPHeaders: { blobContentType: "text/plain; charset=utf-8" },
    });
  }

  async get(key: string): Promise<Buffer | null> {
    assertStorageKey(key);
    try {
      return await this.container.getBlockBlobClient(key).downloadToBuffer();
    } catch (err) {
      if (isBlobNotFound(err)) return null;
      throw err;
    }
  }
}

/** Only a missing blob is "not found". A missing container (also a 404,
 * `ContainerNotFound`) is a deployment error and is rethrown. */
function isBlobNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rest = err as { statusCode?: unknown; details?: { errorCode?: unknown } };
  return rest.statusCode === 404 && rest.details?.errorCode === "BlobNotFound";
}

export type SourceStorageChoice =
  | { kind: "blob"; containerUrl: string }
  | { kind: "local"; dir: string }
  | { kind: "memory" };

/**
 * Picks the storage from the environment. `SOURCE_STORAGE_BLOB_CONTAINER_URL`
 * wins over `SOURCE_STORAGE_DIR` (the api image sets a default directory),
 * and with neither sources are held in memory.
 */
export function chooseSourceStorage(
  env: Record<string, string | undefined> = process.env,
): SourceStorageChoice {
  const containerUrl = env.SOURCE_STORAGE_BLOB_CONTAINER_URL?.trim();
  if (containerUrl) return { kind: "blob", containerUrl };
  const dir = env.SOURCE_STORAGE_DIR?.trim();
  if (dir) return { kind: "local", dir };
  return { kind: "memory" };
}

export function createSourceStorage(choice: SourceStorageChoice): SourceStorage {
  switch (choice.kind) {
    case "blob":
      return BlobSourceStorage.fromContainerUrl(choice.containerUrl);
    case "local":
      return new LocalSourceStorage(choice.dir);
    case "memory":
      return new MemorySourceStorage();
  }
}

/** One line for the startup log. */
export function describeSourceStorage(choice: SourceStorageChoice): string {
  switch (choice.kind) {
    case "blob":
      return `Blob container ${choice.containerUrl}`;
    case "local":
      return `local directory ${choice.dir}`;
    case "memory":
      return "memory (uploads are lost on restart)";
  }
}
