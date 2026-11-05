import { z } from "zod";
import {
  AnalysisStatusSchema,
  ContractSchema,
  DisputeSchema,
  FindingSchema,
  type AnalysisStatus,
  type Contract,
  type Dispute,
  type Finding,
} from "@bbm/shared";
import { getJson, postForm, postJson, putJson, toQueryString } from "./http";

export interface SubmitContractInput {
  file: File;
  developerAddress: string;
  /** Wei as a decimal string. */
  bountyAmount: string;
  currency?: string;
  deadline: string;
}

/** POST /api/contracts - submits a .sol file + bounty + deadline. Kicks off
 * the (mocked, ~3s) analysis pipeline; the returned Contract has no
 * findings yet. */
export function submitContract(input: SubmitContractInput): Promise<Contract> {
  const form = new FormData();
  form.set("file", input.file);
  form.set("developerAddress", input.developerAddress);
  form.set("bountyAmount", input.bountyAmount);
  form.set("currency", input.currency ?? "ETH");
  form.set("deadline", input.deadline);
  return postForm("/api/contracts", form, ContractSchema);
}

/** GET /api/contracts[?developerAddress=] - list contracts, optionally
 * scoped to the connected developer. */
export function listContracts(params?: { developerAddress?: string }): Promise<Contract[]> {
  return getJson(
    `/api/contracts${toQueryString({ developerAddress: params?.developerAddress })}`,
    z.array(ContractSchema),
  );
}

/** GET /api/contracts/:id */
export function getContract(contractId: string): Promise<Contract> {
  return getJson(`/api/contracts/${contractId}`, ContractSchema);
}

/** GET /api/contracts/:id/findings */
export function listFindings(contractId: string): Promise<Finding[]> {
  return getJson(`/api/contracts/${contractId}/findings`, z.array(FindingSchema));
}

/** GET /api/contracts/:id/analysis - state of the Slither + LLM analysis
 * (Queued, Running, Done, or Failed with the compiler error). */
export function getAnalysisStatus(contractId: string): Promise<AnalysisStatus> {
  return getJson(`/api/contracts/${contractId}/analysis`, AnalysisStatusSchema);
}

export interface DisputeFindingInput {
  developerId: string;
  reason: string;
}

/** POST /api/findings/:id/dispute - only valid while the finding is
 * Verified and its challenge window hasn't elapsed. */
export function disputeFinding(findingId: string, input: DisputeFindingInput): Promise<Dispute> {
  return postJson(`/api/findings/${findingId}/dispute`, input, DisputeSchema);
}

/** PUT /api/findings/:id/note - the contract's developer sets (or, with a
 * blank/null note, clears) their note on a finding. `developerId` is only
 * used without a chain; with one the API uses the signed-in wallet. */
export function setFindingNote(
  findingId: string,
  input: { developerId: string; note: string | null },
): Promise<Finding> {
  return putJson(`/api/findings/${findingId}/note`, input, FindingSchema);
}

/** POST /api/contracts/:id/reclaim - only valid once the bounty deadline
 * has passed with no payout. */
export function reclaimBounty(contractId: string): Promise<Contract> {
  return postJson(`/api/contracts/${contractId}/reclaim`, {}, ContractSchema);
}

/** POST /api/contracts/:id/funded - after the developer's BountyEscrow.fund
 * transaction confirms; the API checks the chain and lists the bounty. */
export function markFunded(contractId: string): Promise<Contract> {
  return postJson(`/api/contracts/${contractId}/funded`, {}, ContractSchema);
}

/** POST /api/contracts/:id/cancel - withdraws a bounty submission before any
 * auditor has engaged with it. Only valid while the contract is still
 * `Open`; the mock 400s once it has been claimed. */
export function cancelContract(contractId: string): Promise<Contract> {
  return postJson(`/api/contracts/${contractId}/cancel`, {}, ContractSchema);
}
