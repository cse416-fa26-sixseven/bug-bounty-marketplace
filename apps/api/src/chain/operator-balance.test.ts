import { afterEach, describe, expect, it, vi } from "vitest";
import { LOW_OPERATOR_BALANCE_WEI, startOperatorBalanceMonitor, type OperatorBalanceMonitor } from "./operator-balance.js";
import { buildApp } from "../app.js";

let monitor: OperatorBalanceMonitor | undefined;
afterEach(() => monitor?.stop());

describe("startOperatorBalanceMonitor", () => {
  it("is null before a read, then reports low below 0.05 ETH and not low at or above it", async () => {
    let balance = LOW_OPERATOR_BALANCE_WEI - 1n;
    let release!: () => void;
    const first = new Promise<void>((resolve) => (release = resolve));
    monitor = startOperatorBalanceMonitor({
      readBalance: async () => {
        await first;
        return balance;
      },
      intervalMs: 60_000,
    });
    expect(monitor.isLow()).toBeNull();
    release();
    await monitor.refresh();
    expect(monitor.isLow()).toBe(true);

    balance = LOW_OPERATOR_BALANCE_WEI;
    await monitor.refresh();
    expect(monitor.isLow()).toBe(false);
  });

  it("keeps the last value when a read fails", async () => {
    const onError = vi.fn();
    const readBalance = vi.fn(async () => 0n);
    monitor = startOperatorBalanceMonitor({ readBalance, intervalMs: 60_000, onError });
    await monitor.refresh();
    readBalance.mockRejectedValueOnce(new Error("rpc down"));
    await monitor.refresh();
    expect(monitor.isLow()).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

describe("GET /health with an operator balance", () => {
  it("adds operatorBalanceLow only when the balance is low, and stays 200", async () => {
    let low: boolean | null = null;
    const app = buildApp({ operatorBalanceLow: () => low });

    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    low = false;
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
    low = true;
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", operatorBalanceLow: true });
  });
});
