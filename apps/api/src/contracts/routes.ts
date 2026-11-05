import type { FastifyInstance } from "fastify";
import { AddressSchema, CONTRACT_SOURCE_MAX_BYTES } from "@bbm/shared";
import { readMultipart } from "../http/multipart.js";
import type { ContractRepository } from "./repository.js";
import type { SourceStorage } from "./storage.js";
import { ContractValidationError, submitContract } from "./service.js";
import { resolveActor, type Auth } from "../auth/session.js";

export interface ContractRouteDeps {
  repository: ContractRepository;
  storage: SourceStorage;
  /** Injectable clock for tests; defaults to the real time. */
  now?: () => Date;
  /** With a chain configured: uploads are made by the signed-in developer. */
  identity?: Auth | null;
}

/** Limits passed to @fastify/multipart. `fileSize` is the server-side cap on
 * the .sol upload (and, being the same 100 KB, on PoC uploads); the services
 * re-check the byte length. */
export const CONTRACT_MULTIPART_LIMITS = {
  fileSize: CONTRACT_SOURCE_MAX_BYTES,
  files: 1,
  fields: 10,
} as const;

/** Registers `POST /api/contracts`, `GET /api/contracts`,
 * `GET /api/contracts/:id` and `GET /api/contracts/:id/bounty`. The app must already have @fastify/multipart
 * registered with CONTRACT_MULTIPART_LIMITS. */
export function registerContractRoutes(app: FastifyInstance, deps: ContractRouteDeps): void {
  const now = deps.now ?? (() => new Date());

  app.post("/api/contracts", async (request, reply) => {
    const body = await readMultipart(request);
    if (!body.ok) {
      return body.reason === "too_large"
        ? reply.code(413).send({ error: "Source file exceeds the 100 KB limit" })
        : reply.code(400).send({ error: "Expected a multipart/form-data body" });
    }
    if (!body.file) {
      return reply.code(400).send({ error: "file is required" });
    }
    const actor = resolveActor(deps.identity ?? null, request, reply, body.fields.developerAddress);
    if (!actor.ok) return reply;
    const fields = actor.id ? { ...body.fields, developerAddress: actor.id } : body.fields;

    try {
      const contract = await submitContract(
        { ...deps, now },
        { filename: body.file.filename, bytes: body.file.bytes, fields },
      );
      return reply.code(201).send(contract);
    } catch (err) {
      if (err instanceof ContractValidationError) {
        return reply.code(400).send({ error: "Invalid contract submission", issues: err.issues });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { developerAddress?: string } }>(
    "/api/contracts",
    async (request, reply) => {
      const developerAddress = request.query.developerAddress || undefined;
      if (developerAddress !== undefined && !AddressSchema.safeParse(developerAddress).success) {
        return reply.code(400).send({ error: "developerAddress must be a valid 0x address" });
      }
      return deps.repository.listContracts({ developerAddress }, now());
    },
  );

  app.get<{ Params: { id: string } }>("/api/contracts/:id", async (request, reply) => {
    const contract = await deps.repository.findContractById(request.params.id, now());
    if (!contract) {
      return reply.code(404).send({ error: "Not found" });
    }
    return contract;
  });

  // The terms the developer funds on-chain once the analysis is done.
  app.get<{ Params: { id: string } }>("/api/contracts/:id/bounty", async (request, reply) => {
    const bounty = await deps.repository.findBounty(request.params.id);
    if (!bounty) {
      return reply.code(404).send({ error: "Not found" });
    }
    return bounty;
  });
}
