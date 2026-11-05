import { VerdictDeferredError, type ChainActions } from "./actions.js";
import { startPayoutKeeper, type PayoutKeeper } from "./payout-keeper.js";
import type { PipelineRepository } from "../pipeline/repository.js";

/** How many decided PoCs one pass applies at most. */
const BATCH = 20;

export interface VerdictRunDeps {
  pipeline: PipelineRepository;
  chainActions: ChainActions;
  now?: () => Date;
  onError?: (message: string, err: unknown) => void;
}

export interface VerdictRunSummary {
  applied: number;
  failed: number;
  /** Left unapplied without an error: the bounty holds another finding's
   * verification (VerdictDeferredError). Retried next pass. */
  deferred: number;
}

/**
 * Applies sandbox verdicts the worker has recorded (with CHAIN_ENABLED it only
 * writes poc_submissions.sandbox_status) through ChainActions.applyVerdict,
 * which records the verification on-chain and then moves the finding. A PoC is
 * marked applied only after that succeeds; a failure is reported and retried
 * next pass. A deferred verdict (VerdictDeferredError) is retried next pass
 * too, but is not reported. applyVerdict reads chain state before each write,
 * so a retry after a failed mark does not send again.
 */
export async function runVerdictsOnce(deps: VerdictRunDeps): Promise<VerdictRunSummary> {
  const now = deps.now ?? (() => new Date());
  const onError = deps.onError ?? ((message, err) => console.error(message, err));
  const summary: VerdictRunSummary = { applied: 0, failed: 0, deferred: 0 };
  for (const { pocId, findingId, verdict } of await deps.pipeline.listUnappliedVerdicts(BATCH)) {
    try {
      await deps.chainActions.applyVerdict(findingId, verdict);
      await deps.pipeline.markVerdictApplied(pocId, now());
      summary.applied += 1;
    } catch (err) {
      if (err instanceof VerdictDeferredError) {
        summary.deferred += 1;
        continue;
      }
      summary.failed += 1;
      onError(`verdict for PoC ${pocId} (finding ${findingId}) not applied`, err);
    }
  }
  return summary;
}

/** Runs `runOnce` every `intervalMs` without overlapping passes (same timer
 * as the payout keeper). */
export function startVerdictLoop(options: {
  runOnce: () => Promise<unknown>;
  intervalMs: number;
  onError?: (err: unknown) => void;
}): PayoutKeeper {
  return startPayoutKeeper(options);
}
