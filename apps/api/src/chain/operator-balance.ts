/** Below this the operator may not afford verifications and payouts: 0.05 ETH. */
export const LOW_OPERATOR_BALANCE_WEI = 50_000_000_000_000_000n;

export interface OperatorBalanceMonitor {
  /** True once a read found the balance below the threshold; false when it
   * was enough; null before the first successful read. Never waits on RPC. */
  isLow(): boolean | null;
  /** Reads the balance once now (the timer calls this too). */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Keeps the operator's balance in memory so /health can report it without an
 * RPC call per probe. A failed read keeps the last value and is logged.
 */
export function startOperatorBalanceMonitor(options: {
  readBalance: () => Promise<bigint>;
  intervalMs: number;
  thresholdWei?: bigint;
  onError?: (err: unknown) => void;
}): OperatorBalanceMonitor {
  const threshold = options.thresholdWei ?? LOW_OPERATOR_BALANCE_WEI;
  const onError = options.onError ?? ((err: unknown) => console.error("operator balance read failed", err));
  let low: boolean | null = null;

  async function refresh(): Promise<void> {
    try {
      low = (await options.readBalance()) < threshold;
    } catch (err) {
      onError(err);
    }
  }

  void refresh();
  const timer = setInterval(() => void refresh(), options.intervalMs);
  timer.unref();

  return {
    isLow: () => low,
    refresh,
    stop: () => clearInterval(timer),
  };
}
