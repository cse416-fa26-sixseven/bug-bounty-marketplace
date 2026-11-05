import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, Hex } from "viem";
import { createDisputeResolutionPort } from "./dispute-resolution.js";

const DISPUTES = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address;
const DEVELOPER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const AUDITOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const CONTRACT_KEY = `0x${"c1".repeat(32)}` as Hex;
const FINDING_KEY = `0x${"f1".repeat(32)}` as Hex;
const DISPUTE_KEY = `0x${"d1".repeat(32)}` as Hex;
const HASH = `0x${"ab".repeat(32)}` as Hash;

/** A public client that only the dispute reads are expected to touch. */
function readsOnly(readContract: ReturnType<typeof vi.fn>) {
  return { readContract, getBlock: vi.fn(), waitForTransactionReceipt: vi.fn() } as never;
}

describe("createDisputeResolutionPort", () => {
  it("looks up the dispute key on-chain and returns the dispute", async () => {
    const publicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(DISPUTE_KEY)
        .mockResolvedValueOnce([DEVELOPER, AUDITOR, 1_900_000_000n, false]),
    };
    const port = createDisputeResolutionPort({ address: DISPUTES, publicClient: readsOnly(publicClient.readContract) });

    await expect(port.getDispute(CONTRACT_KEY, FINDING_KEY)).resolves.toEqual({
      developer: DEVELOPER,
      auditor: AUDITOR,
      ruleBy: 1_900_000_000n,
      resolved: false,
    });
    expect(publicClient.readContract).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ functionName: "disputeKey", args: [CONTRACT_KEY, FINDING_KEY] }),
    );
    expect(publicClient.readContract).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ functionName: "disputes", args: [DISPUTE_KEY] }),
    );
  });

  it("returns null when no dispute exists for the finding", async () => {
    const publicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(DISPUTE_KEY)
        .mockResolvedValueOnce([ZERO, ZERO, 0n, false]),
    };
    const port = createDisputeResolutionPort({ address: DISPUTES, publicClient: readsOnly(publicClient.readContract) });

    await expect(port.getDispute(CONTRACT_KEY, FINDING_KEY)).resolves.toBeNull();
  });

  it("reports a resolved dispute", async () => {
    const publicClient = {
      readContract: vi
        .fn()
        .mockResolvedValueOnce(DISPUTE_KEY)
        .mockResolvedValueOnce([DEVELOPER, AUDITOR, 1_900_000_000n, true]),
    };
    const port = createDisputeResolutionPort({ address: DISPUTES, publicClient: readsOnly(publicClient.readContract) });

    await expect(port.getDispute(CONTRACT_KEY, FINDING_KEY)).resolves.toMatchObject({
      resolved: true,
    });
  });

  it("reads the latest block's timestamp", async () => {
    const publicClient = {
      readContract: vi.fn(),
      getBlock: vi.fn(async () => ({ timestamp: 1_900_000_000n })),
      waitForTransactionReceipt: vi.fn(),
    };
    const port = createDisputeResolutionPort({ address: DISPUTES, publicClient: publicClient as never });

    await expect(port.latestBlockTime()).resolves.toBe(1_900_000_000n);
  });

  it("sends lapse with the wallet client and waits for it to succeed", async () => {
    const publicClient = {
      readContract: vi.fn(),
      getBlock: vi.fn(),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "success" })),
    };
    const walletClient = { writeContract: vi.fn(async () => HASH) };
    const port = createDisputeResolutionPort({
      address: DISPUTES,
      publicClient: publicClient as never,
      walletClient: walletClient as never,
    });

    await expect(port.lapse(CONTRACT_KEY, FINDING_KEY)).resolves.toBe(HASH);
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: DISPUTES, functionName: "lapse", args: [CONTRACT_KEY, FINDING_KEY] }),
    );
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it("rejects a reverted lapse", async () => {
    const publicClient = {
      readContract: vi.fn(),
      getBlock: vi.fn(),
      waitForTransactionReceipt: vi.fn(async () => ({ status: "reverted" })),
    };
    const port = createDisputeResolutionPort({
      address: DISPUTES,
      publicClient: publicClient as never,
      walletClient: { writeContract: vi.fn(async () => HASH) } as never,
    });

    await expect(port.lapse(CONTRACT_KEY, FINDING_KEY)).rejects.toThrow(/reverted/);
  });

  it("cannot lapse without a wallet client", async () => {
    const port = createDisputeResolutionPort({ address: DISPUTES, publicClient: readsOnly(vi.fn()) });

    await expect(port.lapse(CONTRACT_KEY, FINDING_KEY)).rejects.toThrow(/wallet client/);
  });
});
