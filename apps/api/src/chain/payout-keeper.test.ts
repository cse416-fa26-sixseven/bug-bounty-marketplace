import { afterEach, describe, expect, it, vi } from "vitest";
import { runKeeperPass, startPayoutKeeper } from "./payout-keeper.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startPayoutKeeper", () => {
  it("runs on each interval until stopped", async () => {
    vi.useFakeTimers();
    const runOnce = vi.fn(async () => undefined);
    const keeper = startPayoutKeeper({ runOnce, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(3500);
    expect(runOnce).toHaveBeenCalledTimes(3);

    await keeper.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(runOnce).toHaveBeenCalledTimes(3);
  });

  it("does not start a pass while the previous one is still running", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => undefined;
    const runOnce = vi.fn(
      () => new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const keeper = startPayoutKeeper({ runOnce, intervalMs: 1000 });

    await vi.advanceTimersByTimeAsync(3500);
    expect(runOnce).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(runOnce).toHaveBeenCalledTimes(2);
    finish();
    await keeper.stop();
  });

  it("reports a failed pass and keeps running", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const runOnce = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("rpc unavailable"))
      .mockResolvedValue(undefined);
    const keeper = startPayoutKeeper({ runOnce, intervalMs: 1000, onError });

    await vi.advanceTimersByTimeAsync(2500);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(runOnce).toHaveBeenCalledTimes(2);
    await keeper.stop();
  });
});

describe("runKeeperPass", () => {
  const T = new Date("2026-11-05T12:00:00.000Z");

  function deps(overrides: { unlocks?: () => Promise<number> } = {}) {
    const chainActions = {
      finishPendingUnlocks: vi.fn(overrides.unlocks ?? (async () => 0)),
      runPayoutsOnce: vi.fn(async () => ({ due: 0, paid: 0, failed: 0 })),
    };
    const onError = vi.fn();
    return { chainActions, onError, now: () => T, log: vi.fn() };
  }

  it("still pays out when the lapse pass fails", async () => {
    const d = deps();
    await runKeeperPass({ ...d, runLapses: async () => Promise.reject(new Error("rpc down")) });
    expect(d.chainActions.runPayoutsOnce).toHaveBeenCalledWith(T);
    expect(d.onError).toHaveBeenCalledWith("lapse pass failed", expect.any(Error));
  });

  it("still pays out when the unlock sweep fails", async () => {
    const d = deps({ unlocks: async () => Promise.reject(new Error("rpc down")) });
    await runKeeperPass(d);
    expect(d.chainActions.runPayoutsOnce).toHaveBeenCalledWith(T);
    expect(d.onError).toHaveBeenCalledWith("unlock sweep failed", expect.any(Error));
  });

  it("runs the lapse pass before the payout pass", async () => {
    const d = deps();
    const order: string[] = [];
    d.chainActions.runPayoutsOnce.mockImplementation(async () => {
      order.push("payouts");
      return { due: 0, paid: 0, failed: 0 };
    });
    await runKeeperPass({
      ...d,
      runLapses: async () => {
        order.push("lapses");
        return { candidates: 0, lapsed: 0, failed: 0 };
      },
    });
    expect(order).toEqual(["lapses", "payouts"]);
  });
});
