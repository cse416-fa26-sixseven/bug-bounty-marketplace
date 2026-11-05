import type { FastifyInstance } from "fastify";
import { DeveloperNoteInputSchema } from "@bbm/shared";
import { resolveActor, type Auth } from "../auth/session.js";
import type { PipelineConfig } from "./config.js";
import type { PipelineRepository } from "./repository.js";

export interface DeveloperNoteRouteDeps {
  pipeline: PipelineRepository;
  config: Pick<PipelineConfig, "now">;
  /** With a chain configured the writer is the signed-in wallet; without one
   * (dev mode) the body's `developerId` names it. */
  identity: Auth | null;
}

/**
 * R16: the contract's developer keeps a note on each finding. Only the
 * developer writes it; it is returned with the finding everywhere the
 * finding is shown, so the claiming auditor and the arbiter read it.
 */
export function registerDeveloperNoteRoutes(app: FastifyInstance, deps: DeveloperNoteRouteDeps): void {
  const { pipeline, config, identity } = deps;

  app.put<{ Params: { id: string }; Body: Record<string, unknown> | undefined }>(
    "/api/findings/:id/note",
    async (request, reply) => {
      const actor = resolveActor(identity, request, reply, request.body?.developerId);
      if (!actor.ok) return reply;
      const developerId = actor.id;
      if (!developerId) return reply.code(400).send({ error: "developerId is required" });
      const parsed = DeveloperNoteInputSchema.safeParse({ note: request.body?.note });
      if (!parsed.success) {
        return reply.code(400).send({
          error: "Invalid note",
          issues: parsed.error.issues.map((issue) => issue.message),
        });
      }

      const now = config.now();
      const finding = await pipeline.findFinding(request.params.id, now);
      if (!finding) return reply.code(404).send({ error: "Not found" });
      if (finding.contract.developerAddress.toLowerCase() !== developerId.toLowerCase()) {
        return reply.code(403).send({ error: "Only the contract's developer can edit this note" });
      }
      if (!(await pipeline.setDeveloperNote(finding.id, parsed.data.note, now.toISOString()))) {
        return reply.code(404).send({ error: "Not found" });
      }
      const updated = await pipeline.findFinding(finding.id, now);
      if (!updated) return reply.code(404).send({ error: "Not found" });
      const { contract: _contract, ...body } = updated;
      return body;
    },
  );
}
