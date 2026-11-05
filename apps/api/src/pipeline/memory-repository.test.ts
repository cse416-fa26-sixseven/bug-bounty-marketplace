import { MemoryContractRepository } from "../contracts/memory-repository.js";
import { describeRepositories } from "../testing/repository-suite.js";
import { MemoryPipelineRepository, MemoryStore } from "./memory-repository.js";

describeRepositories(
  "in-memory",
  () => {
    const store = new MemoryStore();
    return {
      reset: async () => {
        store.contracts.clear();
        store.bounties.clear();
        store.findings.clear();
        store.pocs.clear();
        store.jobs.clear();
      },
      contracts: new MemoryContractRepository(store),
      pipeline: new MemoryPipelineRepository(store),
      seedFinding: async (record) => {
        store.findings.set(record.id, structuredClone(record));
      },
      setJobStatus: async (jobId, status, lastError) => {
        const job = store.jobs.get(jobId);
        if (!job) throw new Error(`no job ${jobId}`);
        job.status = status;
        job.lastError = lastError ?? null;
      },
      addAnalysisJob: async ({ id, subjectId, createdAt, status }) => {
        store.jobs.set(id, {
          id,
          kind: "analysis",
          subjectId,
          createdAt,
          status,
          attempts: 0,
          lastError: null,
          updatedAt: createdAt,
        });
      },
      jobsFor: async (subjectId) =>
        [...store.jobs.values()]
          .filter((j) => j.subjectId === subjectId)
          .map((j) => ({ kind: j.kind, status: j.status })),
      close: async () => {},
    };
  },
  { concurrent: true },
);
