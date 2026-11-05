import { describe, expect, it, vi } from "vitest";
import { keccak256, toBytes, type Hash } from "viem";
import type { ChainInfo } from "@bbm/shared";
import {
  ChainTxError,
  chainCalls,
  type ChainCalls,
  type ContractWrite,
  type TxClient,
} from "../calls";
import { onchainId } from "../ids";

const INFO: Extract<ChainInfo, { configured: true }> = {
  configured: true,
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  addresses: {
    auditorStaking: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    bountyEscrow: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    disputeResolution: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  },
  arbiter: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  challengeWindowSeconds: 60,
  requiredStakeWei: "100000000000000000",
};
const HASH = `0x${"ab".repeat(32)}` as Hash;
const DEVELOPER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function fakeClient(overrides: Partial<TxClient> = {}): TxClient & { writes: ContractWrite[] } {
  const writes: ContractWrite[] = [];
  return {
    writes,
    simulate: vi.fn(async () => undefined),
    write: vi.fn(async (req: ContractWrite) => {
      writes.push(req);
      return HASH;
    }),
    waitForSuccess: vi.fn(async () => true),
    read: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("onchainId", () => {
  it("is keccak256 of the API id, like the API's", () => {
    expect(onchainId("contract_1")).toBe(keccak256(toBytes("contract_1")));
  });
});

describe("chainCalls", () => {
  it("funds a bounty with the deadline in unix seconds and the amount as value", async () => {
    const client = fakeClient();
    const calls = chainCalls(INFO, client);

    await expect(
      calls.fundBounty("contract_1", new Date("2030-01-01T00:00:00.000Z"), "1000000000000000000", DEVELOPER),
    ).resolves.toBe(HASH);

    expect(client.writes[0]).toMatchObject({
      address: INFO.addresses.bountyEscrow,
      functionName: "fund",
      args: [onchainId("contract_1"), 1893456000n],
      value: 1000000000000000000n,
    });
  });

  it("stakes, disputes, rules, deletes, refunds and withdraws payout and stake against the right contracts", async () => {
    const client = fakeClient();
    const calls = chainCalls(INFO, client);
    await calls.stake("100000000000000000");
    await calls.openDispute("contract_1", "finding_1", "bad PoC");
    await calls.rule("contract_1", "finding_1", false);
    await calls.deleteBounty("contract_1");
    await calls.refund("contract_1");
    await calls.withdrawPayout();
    await calls.withdrawStake("50000000000000000");
    expect(client.writes.map((w) => [w.address, w.functionName])).toEqual([
      [INFO.addresses.auditorStaking, "stake"],
      [INFO.addresses.disputeResolution, "openDispute"],
      [INFO.addresses.disputeResolution, "rule"],
      [INFO.addresses.bountyEscrow, "deleteBounty"],
      [INFO.addresses.bountyEscrow, "refund"],
      [INFO.addresses.bountyEscrow, "withdrawPayout"],
      [INFO.addresses.auditorStaking, "withdraw"],
    ]);
    expect(client.writes[6]!.args).toEqual([50000000000000000n]);
    expect(client.writes[0]!.value).toBe(100000000000000000n);
    expect(client.writes[2]!.args).toEqual([
      onchainId("contract_1"),
      onchainId("finding_1"),
      false,
    ]);
  });

  it("surfaces a revert from the simulation and never sends", async () => {
    const client = fakeClient({
      simulate: vi.fn(async () => {
        throw new ChainTxError("PastDeadline");
      }),
    });
    const calls = chainCalls(INFO, client);
    await expect(
      calls.fundBounty("contract_1", new Date("2020-01-01T00:00:00.000Z"), "1", DEVELOPER),
    ).rejects.toThrow(/deadline has already passed/);
    expect(client.write).not.toHaveBeenCalled();
  });

  it("fails when the receipt is not successful", async () => {
    const client = fakeClient({ waitForSuccess: vi.fn(async () => false) });
    await expect(
      chainCalls(INFO, client).withdrawPayout(),
    ).rejects.toBeInstanceOf(ChainTxError);
  });

  it("reports each confirmed transaction to onSent", async () => {
    const onSent = vi.fn();
    await chainCalls(INFO, fakeClient(), { onSent }).stake("1");
    expect(onSent).toHaveBeenCalledWith(HASH);

    const failed = vi.fn();
    const reverted = fakeClient({ waitForSuccess: vi.fn(async () => false) });
    await expect(chainCalls(INFO, reverted, { onSent: failed }).stake("1")).rejects.toThrow();
    expect(failed).not.toHaveBeenCalled();
  });

  it("checks the API session before signing, and sends nothing when that fails", async () => {
    const client = fakeClient();
    const beforeSend = vi.fn(async () => {
      throw new Error("still signing in");
    });
    const calls = chainCalls(INFO, client, { beforeSend });
    await expect(calls.stake("1")).rejects.toThrow("still signing in");
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(client.simulate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "openDispute",
      "DisputeExists",
      (c: ChainCalls) => c.openDispute("contract_1", "finding_1", "r"),
    ],
    ["rule", "AlreadyResolved", (c: ChainCalls) => c.rule("contract_1", "finding_1", true)],
  ] as const)(
    "%s resolves null without sending when %s says it already happened",
    async (_name, error, run) => {
      const client = fakeClient({
        simulate: vi.fn(async () => {
          throw new ChainTxError(error);
        }),
      });
      await expect(run(chainCalls(INFO, client))).resolves.toBeNull();
      expect(client.write).not.toHaveBeenCalled();
    },
  );

  it("treats BountyExists as done only when the developer funded the existing bounty", async () => {
    const exists = () =>
      fakeClient({
        simulate: vi.fn(async () => {
          throw new ChainTxError("BountyExists");
        }),
        // closedBounty's developer is 0x...01.
        read: vi.fn(async () => closedBounty(1)),
      });
    const fund = (client: ReturnType<typeof fakeClient>, developer: string) =>
      chainCalls(INFO, client).fundBounty("contract_1", new Date("2030-01-01"), "1", developer);

    const ours = exists();
    await expect(fund(ours, "0x0000000000000000000000000000000000000001")).resolves.toBeNull();
    expect(ours.write).not.toHaveBeenCalled();

    const squatted = exists();
    await expect(fund(squatted, "0x00000000000000000000000000000000000000d1")).rejects.toMatchObject({
      reason: "BountyExists",
    });
    expect(squatted.write).not.toHaveBeenCalled();
  });

  it("treats cancel and refund of a bounty already closed on-chain as done", async () => {
    const client = fakeClient({
      simulate: vi.fn(async () => {
        throw new ChainTxError("BountyNotOpen");
      }),
      read: vi.fn(async () => closedBounty(3)),
    });
    const calls = chainCalls(INFO, client);
    await expect(calls.deleteBounty("contract_1")).resolves.toBeNull();
    await expect(calls.refund("contract_1")).resolves.toBeNull();
    expect(client.write).not.toHaveBeenCalled();
  });

  it("still fails cancel when the bounty was paid out rather than closed", async () => {
    const client = fakeClient({
      simulate: vi.fn(async () => {
        throw new ChainTxError("BountyNotOpen");
      }),
      read: vi.fn(async () => closedBounty(2)),
    });
    await expect(
      chainCalls(INFO, client).deleteBounty("contract_1"),
    ).rejects.toMatchObject({ reason: "BountyNotOpen" });
  });

  it("reads the bounty's state from BountyEscrow", async () => {
    const client = fakeClient({ read: vi.fn(async () => closedBounty(0)) });
    const calls = chainCalls(INFO, client);
    await expect(calls.readBounty("contract_1")).resolves.toMatchObject({ state: 0 });
    vi.mocked(client.read).mockResolvedValue(closedBounty(1));
    await expect(calls.readBounty("contract_1")).resolves.toMatchObject({ state: 1 });
    expect(client.read).toHaveBeenCalledWith(
      expect.objectContaining({
        address: INFO.addresses.bountyEscrow,
        functionName: "bounties",
        args: [onchainId("contract_1")],
      }),
    );
  });
});

/** BountyEscrow.bounties(id) as viem returns it: the struct's fields in order;
 * index 3 is the state (None, Open, Paid, Closed). */
describe("readBounty", () => {
  it("reads who funded the bounty under the contract's id, and its state", async () => {
    const client = fakeClient({ read: vi.fn(async () => closedBounty(1)) });
    await expect(chainCalls(INFO, client).readBounty("contract_1")).resolves.toEqual({
      developer: "0x0000000000000000000000000000000000000001",
      state: 1,
    });
    expect(client.read).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "bounties", args: [onchainId("contract_1")] }),
    );
  });
});

function closedBounty(state: number): readonly unknown[] {
  return [
    "0x0000000000000000000000000000000000000001",
    1n,
    1n,
    state,
    0n,
    `0x${"00".repeat(32)}`,
    "0x0000000000000000000000000000000000000000",
    0n,
    false,
  ];
}

describe("ChainTxError", () => {
  it("explains a known revert in plain English and keeps the contract's error name", () => {
    const err = new ChainTxError("RefundNotDue");
    expect(err.reason).toBe("RefundNotDue");
    expect(err.message).toBe(
      "The refund isn’t available yet: it opens shortly after the deadline. Try again in a minute.",
    );
    expect(new ChainTxError("PastDeadline").message).toMatch(/deadline has already passed/);
  });

  it("passes an unknown reason through unchanged", () => {
    const err = new ChainTxError("SomethingNew");
    expect(err.message).toBe("SomethingNew");
    expect(err.reason).toBe("SomethingNew");
  });
});
