import type { DisputeRepository } from "../disputes/repository.js";
import type { DisputeResolutionPort } from "./dispute-resolution.js";
import { onchainId } from "./ids.js";

export interface DisputeLapserDeps {
  disputes: Pick<DisputeRepository, "listLapseCandidates" | "setRuleBy">;
  disputeResolution: Pick<DisputeResolutionPort, "getDispute" | "latestBlockTime" | "lapse">;
  /** Where a failed lapse is reported; the pass goes on with the rest. */
  onError?: (message: string, err: unknown) => void;
}

export interface LapseSummary {
  /** Pending disputes looked at: past their ruling window, or with none recorded. */
  candidates: number;
  lapsed: number;
  failed: number;
}

/**
 * Lapses Pending disputes whose ruling window has closed without a ruling,
 * which resolves them in the auditor's favour (DisputeResolution.lapse).
 * The indexer then sees Unfrozen(auditorWon=true): the finding returns to
 * Verified, the dispute is settled and the payout follows on a later pass.
 *
 * Time is the chain's, not the server's: lapse() checks block.timestamp, and
 * a local chain's clock can run ahead of the wall clock. Each dispute is read
 * from the chain before the write, so a retry never sends a lapse the chain
 * would refuse (already resolved, or still inside its ruling window).
 */
export async function runLapsesOnce(deps: DisputeLapserDeps): Promise<LapseSummary> {
  const onError =
    deps.onError ?? ((message: string, err: unknown) => console.error(`@bbm/api ${message}`, err));
  const chainNow = await deps.disputeResolution.latestBlockTime();
  const candidates = await deps.disputes.listLapseCandidates(new Date(Number(chainNow) * 1000));
  const summary: LapseSummary = { candidates: candidates.length, lapsed: 0, failed: 0 };

  for (const candidate of candidates) {
    try {
      const contractKey = onchainId(candidate.contractId);
      const findingKey = onchainId(candidate.findingId);
      const onchain = await deps.disputeResolution.getDispute(contractKey, findingKey);
      if (!onchain) continue;
      if (candidate.ruleBy === null) {
        await deps.disputes.setRuleBy(candidate.id, new Date(Number(onchain.ruleBy) * 1000));
      }
      // Resolved: the indexer settles it. Window still open: the next block
      // must be later than ruleBy, which holds once the latest one is.
      if (onchain.resolved || onchain.ruleBy >= chainNow) continue;
      await deps.disputeResolution.lapse(contractKey, findingKey);
      summary.lapsed += 1;
    } catch (err) {
      summary.failed += 1;
      onError(`lapse failed for dispute ${candidate.id}`, err);
    }
  }
  return summary;
}
