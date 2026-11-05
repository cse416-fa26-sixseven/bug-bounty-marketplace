import { z } from "zod";
import {
  AuditorFindingReportSchema,
  AuditorProfileSchema,
  BountySchema,
  ContractSchema,
  FindingSchema,
  PoCSubmissionSchema,
  type AuditorFindingReport,
  type AuditorProfile,
  type FindingSeverity,
  type Contract,
  type Finding,
  type PoCSubmission,
} from "@bbm/shared";
import { getJson, postForm, postJson, toQueryString } from "./http";

/** A contract in the auditor queue, with its bounty amount joined in so the
 * queue can be sorted/displayed without an extra round trip per row. */
export const QueueItemSchema = ContractSchema.extend({
  bounty: BountySchema.pick({ amount: true, currency: true }),
});
export type QueueItem = z.infer<typeof QueueItemSchema>;

/** GET /api/auditor/queue[?sort=deadline|bounty|newest] - open, unclaimed
 * contracts. */
export function listQueue(params?: {
  sort?: "deadline" | "bounty" | "newest";
}): Promise<QueueItem[]> {
  return getJson(
    `/api/auditor/queue${toQueryString({ sort: params?.sort })}`,
    z.array(QueueItemSchema),
  );
}

/** POST /api/auditor/claim - exclusive, time-limited claim on an Open
 * contract. */
export function claimContract(input: { contractId: string; auditorId: string }): Promise<Contract> {
  return postJson("/api/auditor/claim", input, ContractSchema);
}

/** GET /api/auditor/profile?auditorId= - stake + reputation + claimed
 * contracts for the connected auditor. */
export function getProfile(auditorId: string): Promise<AuditorProfile> {
  return getJson(
    `/api/auditor/profile${toQueryString({ auditorId })}`,
    AuditorProfileSchema,
  );
}

/** POST /api/auditor/stake - adds to the auditor's posted stake. */
/** `amount` is wei as a decimal string. */
export function postStake(input: { auditorId: string; amount: string }): Promise<AuditorProfile> {
  return postJson("/api/auditor/stake", input, AuditorProfileSchema);
}

export interface SubmitPocInput {
  findingId: string;
  auditorId: string;
  file: File;
}

/** POST /api/auditor/poc - submits a Foundry `.t.sol` PoC against a
 * finding. Sandbox result (Passed/Failed) resolves ~3s later; poll the
 * finding or re-fetch the PoC to observe it. */
export function submitPoc(input: SubmitPocInput): Promise<PoCSubmission> {
  const form = new FormData();
  form.set("findingId", input.findingId);
  form.set("auditorId", input.auditorId);
  form.set("file", input.file);
  return postForm("/api/auditor/poc", form, PoCSubmissionSchema);
}

export interface ReportFindingInput {
  contractId: string;
  auditorId: string;
  title: string;
  severity: FindingSeverity;
  description: string;
  file: File;
}

/** POST /api/auditor/findings - reports a finding Slither missed, with the
 * Foundry PoC that proves it. Needs the active claim and the stake, like
 * submitPoc; the finding starts Submitted and the sandbox decides it. */
export function reportFinding(input: ReportFindingInput): Promise<AuditorFindingReport> {
  const form = new FormData();
  form.set("contractId", input.contractId);
  form.set("auditorId", input.auditorId);
  form.set("title", input.title);
  form.set("severity", input.severity);
  form.set("description", input.description);
  form.set("file", input.file);
  return postForm("/api/auditor/findings", form, AuditorFindingReportSchema);
}

/** POST /api/findings/:id/false-positive - auditor judges the AI finding
 * bogus without submitting a PoC. */
export function markFalsePositive(
  findingId: string,
  input: { auditorId: string },
): Promise<Finding> {
  return postJson(`/api/findings/${findingId}/false-positive`, input, FindingSchema);
}
