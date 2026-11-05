import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { MemoryContractRepository } from "./memory-repository.js";
import { MemorySourceStorage } from "./storage.js";
import { CONTRACT_SOURCE_MAX_BYTES } from "@bbm/shared";

const boundary = "----bbmtestboundary";
const address = "0x1234567890123456789012345678901234567890";
const deadline = "2030-01-01T00:00:00.000Z";
const source = Buffer.from("pragma solidity ^0.8.19;\ncontract Vault {}\n");

function multipartBody(
  fields: Record<string, string>,
  file?: { name: string; content: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n`,
      ),
      file.content,
      Buffer.from("\r\n"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

const validFields = {
  developerAddress: address,
  bountyAmount: "2",
  currency: "ETH",
  deadline,
};

function setup() {
  const storage = new MemorySourceStorage();
  const repository = new MemoryContractRepository();
  const app = buildApp({ repository, storage });
  return { app, storage, repository };
}

describe("POST /api/contracts", () => {
  it("stores the source, records the contract, and returns it with a sha256", async () => {
    const { app, storage } = setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(validFields, { name: "Vault.sol", content: source }),
    });

    expect(response.statusCode).toBe(201);
    const contract = response.json();
    const expectedHash = createHash("sha256").update(source).digest("hex");
    expect(contract).toMatchObject({
      developerAddress: address,
      filename: "Vault.sol",
      sourceHash: expectedHash,
      sourceReference: `contracts/${contract.id}/${expectedHash}.sol`,
      status: "Open",
      deadline,
    });
    expect(await storage.get(contract.sourceReference)).toEqual(source);
  });

  it("makes the new contract retrievable by id", async () => {
    const { app } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(validFields, { name: "Vault.sol", content: source }),
    });
    const id = created.json().id;

    const fetched = await app.inject({ method: "GET", url: `/api/contracts/${id}` });

    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toEqual(created.json());
  });

  it("returns 404 for an unknown contract id", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/api/contracts/contract_missing" });
    expect(response.statusCode).toBe(404);
  });

  it("accepts a source exactly at the size limit", async () => {
    const { app } = setup();
    const atLimit = Buffer.alloc(CONTRACT_SOURCE_MAX_BYTES, "a");

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(validFields, { name: "Big.sol", content: atLimit }),
    });

    expect(response.statusCode).toBe(201);
  });

  it("rejects a source one byte over the limit with 413", async () => {
    const { app } = setup();
    const overLimit = Buffer.alloc(CONTRACT_SOURCE_MAX_BYTES + 1, "a");

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(validFields, { name: "Big.sol", content: overLimit }),
    });

    expect(response.statusCode).toBe(413);
  });

  it("rejects a non-.sol filename with 400", async () => {
    const { app } = setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(validFields, { name: "notes.txt", content: source }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues).toContain("Filename must end in .sol");
  });

  it("rejects an empty file with 400", async () => {
    const { app } = setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(validFields, { name: "Empty.sol", content: Buffer.alloc(0) }),
    });

    expect(response.statusCode).toBe(400);
  });

  it("rejects a request with no file part with 400", async () => {
    const { app } = setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(validFields),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "file is required" });
  });

  it("reports every invalid field together", async () => {
    const { app } = setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(
        { ...validFields, developerAddress: "0x123", bountyAmount: "0", deadline: "soon" },
        { name: "Vault.sol", content: source },
      ),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().issues.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a non-multipart body with 400", async () => {
    const { app } = setup();

    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { "content-type": "application/json" },
      payload: { developerAddress: address },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("GET /api/contracts/:id/bounty", () => {
  it("returns the bounty terms entered at upload, and 404 for an unknown contract", async () => {
    const { app } = setup();
    const created = await app.inject({
      method: "POST",
      url: "/api/contracts",
      ...multipartBody(validFields, { name: "Vault.sol", content: source }),
    });
    const id = created.json().id as string;

    const bounty = await app.inject({ method: "GET", url: `/api/contracts/${id}/bounty` });
    expect(bounty.statusCode).toBe(200);
    expect(bounty.json()).toMatchObject({ contractId: id, amount: "2", currency: "ETH", deadline });

    const missing = await app.inject({ method: "GET", url: "/api/contracts/contract_missing/bounty" });
    expect(missing.statusCode).toBe(404);
  });
});
