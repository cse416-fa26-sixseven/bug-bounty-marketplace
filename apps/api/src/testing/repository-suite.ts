import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { FindingSchema, type Bounty, type Contract, type PoCSubmission } from "@bbm/shared";
import type { ContractRepository } from "../contracts/repository.js";
import type {
  FindingRecord,
  JobStatus,
  NewJob,
  PipelineRepository,
} from "../pipeline/repository.js";
import type { MemoryStore } from "../pipeline/memory-repository.js";

/** What the shared repository tests need from an implementation. Test-only
 * hooks (seeding findings, failing jobs) stand in for the Python worker. */
export interface RepositoryHarness {
  contracts: ContractRepository;
  pipeline: PipelineRepository;
  seedFinding(record: FindingRecord): Promise<void>;
  setJobStatus(jobId: string, status: JobStatus, lastError?: string): Promise<void>;
  /** Queues another analysis job for the contract, as a re-run would. */
  addAnalysisJob(job: { id: string; subjectId: string; createdAt: string; status: JobStatus }): Promise<void>;
  jobsFor(subjectId: string): Promise<Array<{ kind: string; status: JobStatus }>>;
  /** Removes what the tests have inserted so far, so the next test starts with
   * no claims. The auditors in these tests hold one claim at a time. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

const T0 = new Date("2026-10-20T12:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

export function makeContract(overrides: Partial<Contract> = {}) {
  const id = `contract_${randomUUID()}`;
  const bountyId = `bounty_${randomUUID()}`;
  const contract: Contract = {
    id,
    developerAddress: "0x1234567890123456789012345678901234567890",
    filename: "Vault.sol",
    sourceHash: "a".repeat(64),
    sourceReference: `contracts/${id}/${"a".repeat(64)}.sol`,
    bountyId,
    status: "Open",
    createdAt: T0.toISOString(),
    deadline: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
  const bounty: Bounty = {
    id: bountyId,
    contractId: id,
    amount: "2000000000000000000",
    currency: "ETH",
    fundedAt: contract.createdAt,
    deadline: contract.deadline,
  };
  const analysisJob: NewJob = {
    id: `job_${randomUUID()}`,
    kind: "analysis",
    subjectId: id,
    createdAt: contract.createdAt,
  };
  return { contract, bounty, analysisJob };
}

export function makeFinding(
  contractId: string,
  overrides: Partial<FindingRecord> = {},
): FindingRecord {
  const id = `finding_${randomUUID()}`;
  return {
    id,
    contractId,
    severity: "High",
    slitherDetector: "reentrancy-eth",
    slitherConfidence: "Medium",
    rawOutput: { check: "reentrancy-eth", impact: "High" },
    rawOutputReference: `/api/findings/${id}/raw`,
    llmExplanation: "Funds can be drained by re-entering withdraw().",
    explanationSource: "llm",
    status: "Flagged",
    statusHistory: [{ status: "Flagged", changedAt: T0.toISOString() }],
    isFalsePositive: false,
    challengeWindowExpiresAt: null,
    createdAt: T0.toISOString(),
    source: "slither",
    title: null,
    reportedByAuditorId: null,
    developerNote: null,
    developerNoteUpdatedAt: null,
    ...overrides,
  };
}

/** An auditor-reported finding as the route builds it: born Submitted. */
export function makeAuditorFinding(
  contractId: string,
  auditorId = "auditor_1",
  overrides: Partial<FindingRecord> = {},
): FindingRecord {
  const report = {
    title: "Unprotected sweep()",
    severity: "Critical" as const,
    description: "Anyone can call sweep() and take the whole balance.",
  };
  return makeFinding(contractId, {
    severity: report.severity,
    slitherDetector: "auditor-reported",
    slitherConfidence: "n/a",
    rawOutput: { source: "auditor", reportedByAuditorId: auditorId, ...report },
    llmExplanation: report.description,
    explanationSource: "auditor",
    status: "Submitted",
    statusHistory: [{ status: "Submitted", changedAt: minutes(1).toISOString() }],
    createdAt: minutes(1).toISOString(),
    source: "auditor",
    title: report.title,
    reportedByAuditorId: auditorId,
    ...overrides,
  });
}

function makePoc(findingId: string): { poc: PoCSubmission; job: NewJob } {
  const id = `poc_${randomUUID()}`;
  return {
    poc: {
      id,
      findingId,
      auditorId: "auditor_1",
      testFileReference: `pocs/${id}/${"b".repeat(64)}.t.sol`,
      submittedAt: minutes(1).toISOString(),
      sandboxStatus: "Pending",
      sandboxLog: null,
    },
    job: {
      id: `job_${randomUUID()}`,
      kind: "sandbox",
      subjectId: id,
      createdAt: minutes(1).toISOString(),
    },
  };
}

/** Marks a contract's analysis jobs done in a MemoryStore, standing in for the
 * worker: the queue, claims and funding wait for a finished analysis. */
export function markAnalysed(store: MemoryStore, contractId: string): void {
  for (const job of store.jobs.values()) {
    if (job.kind === "analysis" && job.subjectId === contractId) job.status = "done";
  }
}

/** Registers the shared repository behaviour tests for one implementation. */
export function describeRepositories(
  name: string,
  makeHarness: () => RepositoryHarness,
  options: { concurrent?: boolean; skip?: boolean } = {},
): void {
  describe.skipIf(options.skip ?? false)(`${name} repositories`, () => {
    const h = options.skip ? (undefined as unknown as RepositoryHarness) : makeHarness();

    afterEach(async () => {
      await h?.reset();
    });

    afterAll(async () => {
      await h?.close();
    });

    async function insert(overrides: Partial<Contract> = {}) {
      const record = makeContract(overrides);
      await h.contracts.insertContract(record);
      return record;
    }

    /** A contract whose analysis job the worker has finished, so it is listed
     * in the queue. */
    async function insertAnalysed(overrides: Partial<Contract> = {}) {
      const record = await insert(overrides);
      await h.setJobStatus(record.analysisJob.id, "done");
      return record;
    }

    it("insertContract also queues an analysis job", async () => {
      const { contract } = await insert();
      expect(await h.jobsFor(contract.id)).toEqual([{ kind: "analysis", status: "queued" }]);
      expect(await h.pipeline.getAnalysisStatus(contract.id)).toEqual({
        contractId: contract.id,
        status: "Queued",
        error: null,
        findingCount: 0,
        updatedAt: contract.createdAt,
      });
    });

    it("getAnalysisStatus returns null for a contract without a job", async () => {
      expect(await h.pipeline.getAnalysisStatus(`contract_${randomUUID()}`)).toBeNull();
    });

    it("getAnalysisStatus exposes last_error only once the job has failed", async () => {
      const { contract, analysisJob } = await insert();
      await h.setJobStatus(analysisJob.id, "running", "transient");
      expect((await h.pipeline.getAnalysisStatus(contract.id))?.error).toBeNull();
      await h.setJobStatus(analysisJob.id, "failed", "ParserError: Expected ';'");
      const status = await h.pipeline.getAnalysisStatus(contract.id);
      expect(status?.status).toBe("Failed");
      expect(status?.error).toBe("ParserError: Expected ';'");
    });

    it("listContracts filters by developer (ignoring case), newest first", async () => {
      const developerAddress = `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`;
      const older = await insert({ developerAddress, createdAt: minutes(-5).toISOString() });
      const newer = await insert({ developerAddress, createdAt: minutes(5).toISOString() });
      await insert();
      const listed = await h.contracts.listContracts(
        { developerAddress: developerAddress.toUpperCase().replace("0X", "0x") },
        T0,
      );
      expect(listed.map((c) => c.id)).toEqual([newer.contract.id, older.contract.id]);
    });

    it("claim succeeds once; a second claim is not_open", async () => {
      const { contract } = await insert();
      const first = await h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0);
      expect(first).toEqual({ ok: true, contract: { ...contract, status: "Claimed" } });
      expect(await h.contracts.claimContract(contract.id, "auditor_2", minutes(10), T0)).toEqual({
        ok: false,
        reason: "not_open",
      });
      expect(await h.contracts.findActiveClaim(contract.id, T0)).toEqual({
        auditorId: "auditor_1",
        expiresAt: minutes(10),
      });
    });

    it("claiming an unknown contract is not_found", async () => {
      expect(
        await h.contracts.claimContract("contract_missing", "auditor_1", minutes(10), T0),
      ).toEqual({
        ok: false,
        reason: "not_found",
      });
    });

    it("an expired claim reads back as Open and can be claimed again", async () => {
      const { contract } = await insert();
      await h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0);
      expect((await h.contracts.findContractById(contract.id, minutes(9)))?.status).toBe("Claimed");
      expect((await h.contracts.findContractById(contract.id, minutes(10)))?.status).toBe("Open");
      expect(await h.contracts.findActiveClaim(contract.id, minutes(10))).toBeNull();
      const again = await h.contracts.claimContract(
        contract.id,
        "auditor_2",
        minutes(20),
        minutes(10),
      );
      expect(again.ok).toBe(true);
      expect(await h.contracts.findActiveClaim(contract.id, minutes(11))).toEqual({
        auditorId: "auditor_2",
        expiresAt: minutes(20),
      });
    });

    it("an auditor holds one claim at a time, across contracts", async () => {
      const first = await insert();
      const second = await insert();
      expect((await h.contracts.claimContract(first.contract.id, "auditor_1", minutes(10), T0)).ok).toBe(true);
      expect(await h.contracts.claimContract(second.contract.id, "auditor_1", minutes(10), T0)).toEqual({
        ok: false,
        reason: "auditor_has_claim",
      });
      expect((await h.contracts.claimContract(second.contract.id, "auditor_2", minutes(10), T0)).ok).toBe(true);
      // Once the first claim has expired, the auditor may claim again.
      const third = await insert();
      expect((await h.contracts.claimContract(third.contract.id, "auditor_1", minutes(20), minutes(10))).ok).toBe(
        true,
      );
    });

    if (options.concurrent) {
      it("of two simultaneous claims by one auditor on different contracts, exactly one succeeds", async () => {
        const a = await insert();
        const b = await insert();
        const results = await Promise.all([
          h.contracts.claimContract(a.contract.id, "auditor_1", minutes(10), T0),
          h.contracts.claimContract(b.contract.id, "auditor_1", minutes(10), T0),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
      });

      it("of two simultaneous claims exactly one succeeds", async () => {
        const { contract } = await insert();
        const results = await Promise.all([
          h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0),
          h.contracts.claimContract(contract.id, "auditor_2", minutes(10), T0),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
      });
    }

    it("listQueue and isAnalysisDone wait for the latest analysis job to be done", async () => {
      const queued = await insert();
      const failed = await insert();
      await h.setJobStatus(failed.analysisJob.id, "failed", "solc: compilation failed");
      const running = await insert();
      await h.setJobStatus(running.analysisJob.id, "running");
      const done = await insertAnalysed();

      const ids = (await h.contracts.listQueue(T0)).map((c) => c.id);
      expect(ids).toContain(done.contract.id);
      for (const record of [queued, failed, running]) {
        expect(ids).not.toContain(record.contract.id);
        expect(await h.contracts.isAnalysisDone(record.contract.id)).toBe(false);
      }
      expect(await h.contracts.isAnalysisDone(done.contract.id)).toBe(true);
      expect(await h.contracts.isAnalysisDone("contract_missing")).toBe(false);
    });

    it("isAnalysisDone and listQueue follow the newest analysis job, by time then id", async () => {
      const job = (subjectId: string, createdAt: Date, status: JobStatus, id = `job_${randomUUID()}`) =>
        h.addAnalysisJob({ id, subjectId, createdAt: createdAt.toISOString(), status });
      const listed = async (id: string) => (await h.contracts.listQueue(T0)).some((c) => c.id === id);

      // An older failure does not hold back a newer finished run.
      const rerun = await insert();
      await h.setJobStatus(rerun.analysisJob.id, "failed", "solc error");
      await job(rerun.contract.id, minutes(5), "done");
      expect(await h.contracts.isAnalysisDone(rerun.contract.id)).toBe(true);
      expect(await listed(rerun.contract.id)).toBe(true);

      // An older finished run does not stand in for a newer one still running.
      const running = await insertAnalysed();
      await job(running.contract.id, minutes(5), "running");
      expect(await h.contracts.isAnalysisDone(running.contract.id)).toBe(false);
      expect(await listed(running.contract.id)).toBe(false);

      // Same timestamp: the larger id is the newer job.
      const tie = await insert();
      await job(tie.contract.id, minutes(5), "done", "job_zzzz_" + randomUUID());
      await job(tie.contract.id, minutes(5), "failed", "job_aaaa_" + randomUUID());
      expect(await h.contracts.isAnalysisDone(tie.contract.id)).toBe(true);
    });

    it("listQueue includes Open and expired claims, not active claims, with the bounty", async () => {
      const open = await insertAnalysed();
      const active = await insertAnalysed();
      const expired = await insertAnalysed();
      await h.contracts.claimContract(active.contract.id, "auditor_1", minutes(30), T0);
      // A different auditor: auditor_1 already holds the active claim above, and
      // one auditor may hold one claim at a time.
      expect(
        (await h.contracts.claimContract(expired.contract.id, "auditor_2", minutes(5), T0)).ok,
      ).toBe(true);
      const queue = await h.contracts.listQueue(minutes(10));
      const ids = queue.map((c) => c.id);
      expect(ids).toContain(open.contract.id);
      expect(ids).toContain(expired.contract.id);
      expect(ids).not.toContain(active.contract.id);
      const item = queue.find((c) => c.id === expired.contract.id);
      expect(item).toEqual({
        ...expired.contract,
        status: "Open",
        bounty: { amount: "2000000000000000000", currency: "ETH" },
      });
    });

    it("listFindings orders by severity and fills in the active claim", async () => {
      const { contract } = await insert();
      const low = makeFinding(contract.id, { severity: "Low" });
      const high = makeFinding(contract.id, {
        severity: "High",
        createdAt: minutes(1).toISOString(),
      });
      const critical = makeFinding(contract.id, {
        severity: "Critical",
        createdAt: minutes(2).toISOString(),
      });
      for (const f of [low, high, critical]) await h.seedFinding(f);

      const unclaimed = await h.pipeline.listFindings(contract.id, T0);
      expect(unclaimed.map((f) => f.id)).toEqual([critical.id, high.id, low.id]);
      expect(unclaimed[0]).toMatchObject({ claimedByAuditorId: null, claimExpiresAt: null });
      for (const f of unclaimed) FindingSchema.parse(f);

      await h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0);
      const claimed = await h.pipeline.listFindings(contract.id, minutes(1));
      expect(claimed[0]).toMatchObject({
        claimedByAuditorId: "auditor_1",
        claimExpiresAt: minutes(10).toISOString(),
      });
      const afterExpiry = await h.pipeline.listFindings(contract.id, minutes(10));
      expect(afterExpiry[0]).toMatchObject({ claimedByAuditorId: null, claimExpiresAt: null });
    });

    it("findFinding returns the finding with its contract; getRawOutput returns the stored JSON", async () => {
      const { contract } = await insert();
      const finding = makeFinding(contract.id, {
        rawOutput: { check: "tx-origin", elements: [1, 2] },
      });
      await h.seedFinding(finding);
      const found = await h.pipeline.findFinding(finding.id, T0);
      expect(found?.contract.id).toBe(contract.id);
      expect(found?.slitherDetector).toBe("reentrancy-eth");
      expect(await h.pipeline.getRawOutput(finding.id)).toEqual({
        check: "tx-origin",
        elements: [1, 2],
      });
      expect(await h.pipeline.findFinding("finding_missing", T0)).toBeNull();
      expect(await h.pipeline.getRawOutput("finding_missing")).toBeNull();
    });

    it("getAnalysisStatus counts stored findings", async () => {
      const { contract } = await insert();
      await h.seedFinding(makeFinding(contract.id));
      await h.seedFinding(makeFinding(contract.id));
      expect((await h.pipeline.getAnalysisStatus(contract.id))?.findingCount).toBe(2);
    });

    it("submitPoc on a Flagged finding marks it Submitted and queues a sandbox job", async () => {
      const { contract } = await insert();
      const finding = makeFinding(contract.id);
      await h.seedFinding(finding);
      await h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0);
      const { poc, job } = makePoc(finding.id);

      expect(
        await h.pipeline.submitPoc({ poc, job, findingId: finding.id, now: poc.submittedAt }),
      ).toBe("ok");

      const stored = await h.pipeline.findFinding(finding.id, T0);
      expect(stored?.status).toBe("Submitted");
      expect(stored?.statusHistory).toEqual([
        { status: "Flagged", changedAt: T0.toISOString() },
        { status: "Submitted", changedAt: poc.submittedAt },
      ]);
      expect(await h.jobsFor(poc.id)).toEqual([{ kind: "sandbox", status: "queued" }]);
    });

    it("markFunded with a deadline moves an unfunded bounty's deadline, never a funded one's", async () => {
      const { contract } = await insert();
      const later = new Date("2031-06-01T00:00:00.000Z");
      await h.contracts.markFunded(contract.id, T0, later);
      expect(await h.contracts.isFunded(contract.id)).toBe(true);
      expect((await h.contracts.findContractById(contract.id, T0))?.deadline).toBe(later.toISOString());
      expect((await h.contracts.findBounty(contract.id))?.deadline).toBe(later.toISOString());

      await h.contracts.markFunded(contract.id, minutes(1), new Date("2032-01-01T00:00:00.000Z"));
      expect((await h.contracts.findContractById(contract.id, T0))?.deadline).toBe(later.toISOString());
      expect((await h.contracts.findBounty(contract.id))?.deadline).toBe(later.toISOString());
    });

    it("markFunded, fundedOnly queue, findBounty and setContractStatus", async () => {
      const funded = await insertAnalysed();
      const unfunded = await insertAnalysed();
      expect((await h.contracts.findBounty(funded.contract.id))?.amount).toBe(funded.bounty.amount);
      expect(await h.contracts.isFunded(funded.contract.id)).toBe(false);
      await h.contracts.markFunded(funded.contract.id, T0);
      await h.contracts.markFunded(funded.contract.id, minutes(1));
      expect(await h.contracts.isFunded(funded.contract.id)).toBe(true);
      const queued = (await h.contracts.listQueue(T0, { fundedOnly: true })).map((c) => c.id);
      expect(queued).toContain(funded.contract.id);
      expect(queued).not.toContain(unfunded.contract.id);
      expect((await h.contracts.listQueue(T0)).map((c) => c.id)).toContain(unfunded.contract.id);

      expect((await h.contracts.setContractStatus(unfunded.contract.id, "Expired", T0))?.status).toBe("Expired");
      expect((await h.contracts.setContractStatus(unfunded.contract.id, "Expired", T0))?.status).toBe("Expired");
      await expect(h.contracts.setContractStatus(unfunded.contract.id, "Open", T0)).rejects.toThrow(/Invalid/);
      expect(await h.contracts.setContractStatus("contract_missing", "Expired", T0)).toBeNull();
    });

    it("markFalsePositive rejects a Flagged finding once, and findLatestPoc returns the newest PoC", async () => {
      const { contract } = await insert();
      const flagged = makeFinding(contract.id);
      await h.seedFinding(flagged);
      expect(await h.pipeline.markFalsePositive(flagged.id, minutes(1).toISOString())).toBe("ok");
      expect(await h.pipeline.markFalsePositive(flagged.id, minutes(2).toISOString())).toBe("not_flagged");
      expect(await h.pipeline.markFalsePositive("finding_missing", minutes(2).toISOString())).toBe("not_found");
      const stored = await h.pipeline.findFinding(flagged.id, T0);
      expect(stored).toMatchObject({ status: "Rejected", isFalsePositive: true });

      const other = makeFinding(contract.id);
      await h.seedFinding(other);
      expect(await h.pipeline.findLatestPoc(other.id)).toBeNull();
      await h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0);
      const { poc, job } = makePoc(other.id);
      await h.pipeline.submitPoc({ poc, job, findingId: other.id, now: poc.submittedAt });
      expect((await h.pipeline.findLatestPoc(other.id))?.id).toBe(poc.id);
      expect(await h.contracts.listClaimedContractIds("auditor_1", T0)).toEqual([contract.id]);
    });

    it("lists decided, unapplied verdicts for Submitted findings until marked applied", async () => {
      const { contract } = await insert();
      const finding = makeFinding(contract.id);
      await h.seedFinding(finding);
      await h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0);
      const { poc, job } = makePoc(finding.id);
      await h.pipeline.submitPoc({ poc, job, findingId: finding.id, now: poc.submittedAt });
      const mine = async () =>
        (await h.pipeline.listUnappliedVerdicts(100)).filter((v) => v.pocId === poc.id);

      expect(await mine()).toEqual([]);
      await h.pipeline.recordVerdict(poc.id, "Passed");
      expect(await mine()).toEqual([{ pocId: poc.id, findingId: finding.id, verdict: "Passed" }]);

      await h.pipeline.markVerdictApplied(poc.id, minutes(2));
      await h.pipeline.markVerdictApplied(poc.id, minutes(3));
      expect(await mine()).toEqual([]);
    });

    it("a second submitPoc on the same finding is not_flagged and writes nothing", async () => {
      const { contract } = await insert();
      const finding = makeFinding(contract.id);
      await h.seedFinding(finding);
      await h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0);
      const first = makePoc(finding.id);
      await h.pipeline.submitPoc({ ...first, findingId: finding.id, now: first.poc.submittedAt });

      const second = makePoc(finding.id);
      expect(
        await h.pipeline.submitPoc({
          ...second,
          findingId: finding.id,
          now: second.poc.submittedAt,
        }),
      ).toBe("not_flagged");
      expect(await h.jobsFor(second.poc.id)).toEqual([]);
      expect((await h.pipeline.findFinding(finding.id, T0))?.statusHistory).toHaveLength(2);
    });

    it("submitAuditorFinding stores the Submitted finding, its PoC and a sandbox job", async () => {
      const { contract } = await insert();
      await h.contracts.claimContract(contract.id, "auditor_1", minutes(10), T0);
      const finding = makeAuditorFinding(contract.id);
      const { poc, job } = makePoc(finding.id);

      expect(
        await h.pipeline.submitAuditorFinding({ finding, poc, job, now: poc.submittedAt }),
      ).toBe("ok");

      const stored = await h.pipeline.findFinding(finding.id, T0);
      expect(FindingSchema.parse(stored)).toMatchObject({
        status: "Submitted",
        source: "auditor",
        title: "Unprotected sweep()",
        reportedByAuditorId: "auditor_1",
        slitherDetector: "auditor-reported",
        llmExplanation: finding.llmExplanation,
        claimedByAuditorId: "auditor_1",
      });
      expect(stored?.statusHistory).toEqual(finding.statusHistory);
      expect(await h.pipeline.getRawOutput(finding.id)).toEqual(finding.rawOutput);
      expect((await h.pipeline.listFindings(contract.id, T0)).map((f) => f.id)).toEqual([
        finding.id,
      ]);
      expect((await h.pipeline.findLatestPoc(finding.id))?.id).toBe(poc.id);
      expect(await h.jobsFor(poc.id)).toEqual([{ kind: "sandbox", status: "queued" }]);

      // Its verdict is applied like any other PoC's.
      await h.pipeline.recordVerdict(poc.id, "Passed");
      expect(
        (await h.pipeline.listUnappliedVerdicts(100)).filter((v) => v.pocId === poc.id),
      ).toEqual([{ pocId: poc.id, findingId: finding.id, verdict: "Passed" }]);
    });

    it("setDeveloperNote sets, replaces and clears a finding's note", async () => {
      const { contract } = await insert();
      const finding = makeFinding(contract.id);
      await h.seedFinding(finding);
      const note = async () => {
        const found = await h.pipeline.findFinding(finding.id, T0);
        return { note: found?.developerNote, at: found?.developerNoteUpdatedAt };
      };
      expect(await note()).toEqual({ note: null, at: null });

      expect(await h.pipeline.setDeveloperNote(finding.id, "Known issue", minutes(1).toISOString())).toBe(true);
      expect(await note()).toEqual({ note: "Known issue", at: minutes(1).toISOString() });

      await h.pipeline.setDeveloperNote(finding.id, "Fixed in v2", minutes(2).toISOString());
      expect(await note()).toEqual({ note: "Fixed in v2", at: minutes(2).toISOString() });
      expect((await h.pipeline.listFindings(contract.id, T0))[0]?.developerNote).toBe("Fixed in v2");

      await h.pipeline.setDeveloperNote(finding.id, null, minutes(3).toISOString());
      expect(await note()).toEqual({ note: null, at: null });
      // The note is an annotation: status and history are untouched.
      expect((await h.pipeline.findFinding(finding.id, T0))?.statusHistory).toEqual(
        finding.statusHistory,
      );
    });

    it("setDeveloperNote on an unknown finding is false", async () => {
      expect(await h.pipeline.setDeveloperNote("finding_missing", "x", T0.toISOString())).toBe(false);
    });

    it("a Slither finding reads back with source slither and no title", async () => {
      const { contract } = await insert();
      const finding = makeFinding(contract.id);
      await h.seedFinding(finding);
      expect(await h.pipeline.findFinding(finding.id, T0)).toMatchObject({
        source: "slither",
        title: null,
        reportedByAuditorId: null,
      });
    });

    for (const [label, claimant, expiresAt] of [
      ["no claim", null, null],
      ["another auditor's claim", "auditor_2", minutes(10)],
      ["an expired claim", "auditor_1", minutes(1)],
    ] as const) {
      it(`submitAuditorFinding with ${label} is no_claim and writes nothing`, async () => {
        const { contract } = await insert();
        if (claimant && expiresAt) {
          await h.contracts.claimContract(contract.id, claimant, expiresAt, T0);
        }
        const finding = makeAuditorFinding(contract.id);
        const { poc, job } = makePoc(finding.id); // auditor_1, submitted at T0 + 1 min
        expect(
          await h.pipeline.submitAuditorFinding({ finding, poc, job, now: poc.submittedAt }),
        ).toBe("no_claim");
        expect(await h.pipeline.findFinding(finding.id, T0)).toBeNull();
        expect(await h.pipeline.findLatestPoc(finding.id)).toBeNull();
        expect(await h.jobsFor(poc.id)).toEqual([]);
      });
    }

    // The claim is re-checked inside the same transaction as the status
    // change, so a claim that lapses (or changes hands) mid-request loses.
    for (const [label, claimant, expiresAt] of [
      ["no claim", null, null],
      ["another auditor's claim", "auditor_2", minutes(10)],
      ["an expired claim", "auditor_1", minutes(1)],
    ] as const) {
      it(`submitPoc with ${label} is no_claim and writes nothing`, async () => {
        const { contract } = await insert();
        const finding = makeFinding(contract.id);
        await h.seedFinding(finding);
        if (claimant && expiresAt) {
          await h.contracts.claimContract(contract.id, claimant, expiresAt, T0);
        }
        const { poc, job } = makePoc(finding.id); // auditor_1, submitted at T0 + 1 min
        expect(
          await h.pipeline.submitPoc({ poc, job, findingId: finding.id, now: poc.submittedAt }),
        ).toBe("no_claim");
        expect(await h.jobsFor(poc.id)).toEqual([]);
        expect((await h.pipeline.findFinding(finding.id, T0))?.status).toBe("Flagged");
      });
    }
  });
}
