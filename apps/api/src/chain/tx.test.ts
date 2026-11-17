import { describe, expect, it, vi } from "vitest";
import type { Hash, PublicClient, TransactionReceipt } from "viem";
import { awaitSuccess } from "./tx.js";

const HASH = `0x${"ab".repeat(32)}` as Hash;

function fakeClient(status: TransactionReceipt["status"]) {
  return {
    waitForTransactionReceipt: vi.fn(async () => ({ status }) as TransactionReceipt),
  } satisfies Pick<PublicClient, "waitForTransactionReceipt">;
}

describe("awaitSuccess", () => {
  it("returns the hash once the receipt is a success", async () => {
    const client = fakeClient("success");
    await expect(awaitSuccess(client, HASH, "fund")).resolves.toBe(HASH);
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it("throws with the label and hash when the receipt reverted", async () => {
    const client = fakeClient("reverted");
    await expect(awaitSuccess(client, HASH, "recordVerification")).rejects.toThrow(
      `recordVerification reverted in ${HASH}`,
    );
    expect(client.waitForTransactionReceipt).toHaveBeenCalledTimes(1);
  });

  it("propagates a failure to fetch the receipt", async () => {
    const client = {
      waitForTransactionReceipt: vi.fn(async (): Promise<TransactionReceipt> => {
        throw new Error("timed out");
      }),
    };
    await expect(awaitSuccess(client, HASH, "payout")).rejects.toThrow("timed out");
  });
});
