import type { ChainActions } from "./actions.js";
import type { LapseSummary } from "./dispute-lapser.js";

export interface PayoutKeeperOptions {
  /** One pass of work, e.g. ChainActions.runPayoutsOnce bound to the clock. */
  runOnce: () => Promise<unknown>;
  intervalMs: number;
  /** Where a failed pass is reported; the keeper keeps running. */
  onError?: (err: unknown) => void;
}

export interface PayoutKeeper {
  /** Stops the timer and waits for a pass already in flight. */
  stop(): Promise<void>;
}

/**
 * Runs `runOnce` every `intervalMs`. Passes never overlap: if one is still
 * running when the next tick fires, that tick is skipped. The timer is
 * unref'd so the keeper alone does not keep the process alive.
 */
export function startPayoutKeeper(options: PayoutKeeperOptions): PayoutKeeper {
  const onError = options.onError ?? ((err: unknown) => console.error("payout keeper pass failed", err));
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = options
      .runOnce()
      .then(
        () => undefined,
        (err: unknown) => onError(err),
      )
      .finally(() => {
        inFlight = null;
      });
  };

  const timer = setInterval(tick, options.intervalMs);
  timer.unref();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}

export interface KeeperPassDeps {
  chainActions: Pick<ChainActions, "finishPendingUnlocks" | "runPayoutsOnce">;
  /** Lapses disputes left unruled past their ruling window; omitted without a chain. */
  runLapses?: () => Promise<LapseSummary>;
  now: () => Date;
  log?: (message: string) => void;
  onError?: (message: string, err: unknown) => void;
}

/**
 * One keeper pass: finish pending unlocks, lapse unruled disputes, then pay
 * out. The first two are best-effort: a failure is reported and the payout
 * step still runs, so an RPC hiccup in either never delays a payout.
 */
export async function runKeeperPass(deps: KeeperPassDeps): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(`@bbm/api ${message}`));
  const onError = deps.onError ?? ((message: string, err: unknown) => console.error(`@bbm/api ${message}`, err));

  await deps.chainActions.finishPendingUnlocks().catch((err: unknown) => onError("unlock sweep failed", err));
  if (deps.runLapses) {
    const lapses = await deps.runLapses().catch((err: unknown) => {
      onError("lapse pass failed", err);
      return null;
    });
    if (lapses && lapses.lapsed + lapses.failed > 0) log(`lapse pass: ${JSON.stringify(lapses)}`);
  }
  const summary = await deps.chainActions.runPayoutsOnce(deps.now());
  if (summary.due > 0) log(`payout pass: ${JSON.stringify(summary)}`);
}
