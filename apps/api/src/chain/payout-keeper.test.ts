import { afterEach, describe, expect, it, vi } from "vitest";
import type { Address, Hash } from "viem";
import { MemoryContractRepository } from "../contracts/memory-repository.js";
import { MemoryStore } from "../pipeline/memory-repository.js";
import { makeContract, makeFinding } from "../testing/repository-suite.js";
import { createChainActions } from "./actions.js";
import type { AuditorStakingPort } from "./auditor-staking.js";
import { MemoryChainActionStore } from "./memory-action-store.js";
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
      releaseExpiredLocks: vi.fn(async (_now: Date) => 0),
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

  it("sweeps lapsed claim locks at the pass's time, and still pays out when that fails", async () => {
    const d = deps();
    d.chainActions.releaseExpiredLocks.mockRejectedValueOnce(new Error("rpc down"));
    await runKeeperPass(d);
    expect(d.chainActions.releaseExpiredLocks).toHaveBeenCalledWith(T);
    expect(d.chainActions.runPayoutsOnce).toHaveBeenCalledWith(T);
    expect(d.onError).toHaveBeenCalledWith("expired lock sweep failed", expect.any(Error));
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

describe("runKeeperPass with real chain actions", () => {
  const T0 = new Date("2026-11-05T12:00:00.000Z");
  const WINDOW_MS = 600_000;
  const HASH = `0x${"ab".repeat(32)}` as Hash;
  const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
  const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;

  it("unlocks a lapsed claim with no pending finding and leaves an active claim locked", async () => {
    const store = new MemoryStore();
    const repository = new MemoryContractRepository(store);
    const active = new Map<string, bigint>();
    const auditorStaking = {
      stakeOf: vi.fn(async () => 0n),
      reputation: vi.fn(async () => 0n),
      activeSubmissions: vi.fn(async (a: Address) => active.get(a) ?? 0n),
      lockSubmission: vi.fn(async (a: Address) => {
        active.set(a, (active.get(a) ?? 0n) + 1n);
        return HASH;
      }),
      unlockSubmission: vi.fn(async (a: Address) => {
        active.set(a, (active.get(a) ?? 0n) - 1n);
        return HASH;
      }),
    } satisfies AuditorStakingPort & Record<string, unknown>;
    const actions = createChainActions({
      store: new MemoryChainActionStore(store),
      auditorStaking,
      claimLockEnabled: true,
      onError: () => {},
    });

    async function claimLocked(auditor: Address, at: Date): Promise<string> {
      const record = makeContract();
      await repository.insertContract(record);
      const id = record.contract.id;
      const result = await repository.claimContract(id, auditor, new Date(at.getTime() + WINDOW_MS), at);
      if (!result.ok) throw new Error("claim failed in test setup");
      await actions.lockClaim(id, auditor);
      return id;
    }

    // A: claimed at T0 and its PoC failed (Rejected, so nothing pending).
    const lapsed = await claimLocked(A, T0);
    const rejected = makeFinding(lapsed, {
      status: "Rejected",
      statusHistory: [{ status: "Rejected", changedAt: T0.toISOString() }],
    });
    store.findings.set(rejected.id, rejected);
    // B: claimed later, still running at the pass.
    const later = new Date(T0.getTime() + WINDOW_MS / 2);
    const running = await claimLocked(B, later);

    const passAt = new Date(T0.getTime() + WINDOW_MS + 1);
    await runKeeperPass({
      chainActions: { ...actions, runPayoutsOnce: async () => ({ due: 0, paid: 0, failed: 0 }) },
      now: () => passAt,
      log: () => {},
    });

    expect(auditorStaking.unlockSubmission).toHaveBeenCalledTimes(1);
    expect(auditorStaking.unlockSubmission).toHaveBeenCalledWith(A);
    expect(store.contracts.get(lapsed)?.claimLock).toBe("released");
    expect(store.contracts.get(running)?.claimLock).toBe("locked");
    expect(active.get(B)).toBe(1n);
  });
});
