import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Abi, type AbiEvent, type Address, type Hash, type Hex } from "viem";
import { bountyEscrowAbi, disputeResolutionAbi } from "@bbm/shared";
import { loadChainConfig } from "../chain/config.js";
import { onchainId } from "../chain/ids.js";
import type { ChainLog } from "./events.js";
import { MemoryFindingStatusStore } from "../status/memory-finding-status.js";
import type { FindingStatus } from "@bbm/shared";
import { runOnce, startEventIndexer, type EventIndexerOptions, type IndexerChainClient } from "./indexer.js";
import { MemoryIndexerLock, MemoryIndexerRepository } from "./memory-repository.js";
import type { IndexerLock } from "./repository.js";

const ESCROW = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512" as Address;
const DISPUTES = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0" as Address;
const UNWATCHED = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const AUDITOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const CONTRACT_KEY = `0x${"c1".repeat(32)}` as Hex;
const DISPUTE_KEY = `0x${"d1".repeat(32)}` as Hex;
const FINDING_API_ID = "finding_1";
const FINDING_KEY = onchainId(FINDING_API_ID);
const AT = new Date("2026-10-20T12:00:00Z");

/** Store that records every write so tests can assert on the sequence. */
class RecordingFindingStatus extends MemoryFindingStatusStore {
  readonly calls: { findingId: string; status: FindingStatus; at: string }[] = [];
  readonly statuses = new Map<string, FindingStatus>();

  override async setFindingStatus(findingId: string, status: FindingStatus, changedAt: string): Promise<void> {
    this.calls.push({ findingId, status, at: changedAt });
    this.statuses.set(findingId, status);
    await super.setFindingStatus(findingId, status, changedAt);
  }
}
const CHAIN_ID = 31337;

type LogSpot = Pick<ChainLog, "address" | "blockNumber" | "transactionHash" | "logIndex">;

function txHashFor(blockNumber: bigint): Hash {
  return `0x${blockNumber.toString(16).padStart(64, "0")}` as Hash;
}

/** Builds a log the way the chain would emit it: indexed args as topics, the rest ABI-encoded. */
function makeLog(
  abi: readonly unknown[],
  eventName: string,
  args: Record<string, unknown>,
  spot: LogSpot,
): ChainLog {
  const event = (abi as Abi).find((item): item is AbiEvent => item.type === "event" && item.name === eventName);
  if (!event) throw new Error(`no ${eventName} in ABI`);
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as Hex[];
  const nonIndexed = event.inputs.filter((input) => !input.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((input) => args[input.name!])) as Hex;
  return { ...spot, topics, data };
}

const spot = (blockNumber: bigint, logIndex: number, transactionHash = txHashFor(blockNumber)): LogSpot => ({
  address: ESCROW,
  blockNumber,
  transactionHash,
  logIndex,
});

/** A fake chain: fixed head, logs filtered by the requested block range. */
function fakeChain(head: bigint, logs: ChainLog[]) {
  let current = head;
  const getBlockNumber = vi.fn(async () => current);
  const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
    logs.filter((log) => log.blockNumber! >= fromBlock && log.blockNumber! <= toBlock),
  );
  return {
    client: { getBlockNumber, getLogs } as unknown as IndexerChainClient,
    getLogs,
    setHead(next: bigint) {
      current = next;
    },
  };
}

function setup(head: bigint, logs: ChainLog[], overrides: Partial<EventIndexerOptions> = {}) {
  const chain = fakeChain(head, logs);
  const repository = new MemoryIndexerRepository();
  const findingStatus = new RecordingFindingStatus();
  findingStatus.add(FINDING_API_ID, "Submitted", AT.toISOString());
  const options: EventIndexerOptions = {
    chainId: CHAIN_ID,
    client: chain.client,
    contracts: { bountyEscrow: ESCROW, disputeResolution: DISPUTES },
    repository,
    findingStatus,
    listFindingIds: async () => [FINDING_API_ID],
    lock: new MemoryIndexerLock(),
    now: () => AT,
    ...overrides,
  };
  return { chain, repository, findingStatus, options };
}

const verifiedLog = (blockNumber: bigint, logIndex: number, transactionHash?: Hash) =>
  makeLog(
    bountyEscrowAbi,
    "FindingVerified",
    { contractId: CONTRACT_KEY, findingId: FINDING_KEY, auditor: AUDITOR, verifiedAt: 1_900_000_000n },
    spot(blockNumber, logIndex, transactionHash),
  );

describe("runOnce", () => {
  it("advances a finding to Verified from a FindingVerified log", async () => {
    const { options, findingStatus } = setup(10n, [verifiedLog(5n, 0)]);

    const result = await runOnce(options);

    expect(findingStatus.statuses.get(FINDING_API_ID)).toBe("Verified");
    expect(findingStatus.calls).toEqual([{ findingId: FINDING_API_ID, status: "Verified", at: AT.toISOString() }]);
    expect(result).toMatchObject({ fromBlock: 0n, toBlock: 10n, applied: 1, ignored: 0 });
  });

  it("applies a replayed log once", async () => {
    const log = verifiedLog(5n, 0);
    const { options, findingStatus, repository } = setup(10n, [log]);

    await runOnce(options);
    const replay = await runOnce(options);

    // The checkpoint is past block 5, so the log is not read again at all.
    expect(findingStatus.calls).toHaveLength(1);
    expect(replay.applied).toBe(0);
    expect(await repository.hasApplied({ chainId: CHAIN_ID, txHash: log.transactionHash!, logIndex: 0 })).toBe(true);
  });

  it("replays a log after a crash before the applied marker without writing the status again", async () => {
    // A crash between the status write and markApplied leaves the status set
    // but no marker. A fresh repository models that state.
    const log = verifiedLog(5n, 0);
    const first = setup(10n, [log]);
    await runOnce(first.options);

    const replay = await runOnce({ ...first.options, repository: new MemoryIndexerRepository() });

    expect(replay.applied).toBe(1);
    expect(first.findingStatus.calls).toHaveLength(1);
    expect(first.findingStatus.statuses.get(FINDING_API_ID)).toBe("Verified");
  });

  it("re-reads the checkpoint block on the next run and advances it", async () => {
    const { chain, options, repository } = setup(10n, [verifiedLog(5n, 0)]);

    await runOnce(options);
    expect(await repository.getCheckpoint(CHAIN_ID)).toBe(10n);

    chain.setHead(12n);
    const second = await runOnce(options);

    expect(second.fromBlock).toBe(10n);
    expect(second.toBlock).toBe(12n);
    expect(await repository.getCheckpoint(CHAIN_ID)).toBe(12n);
  });

  it("does nothing when the checkpoint is past the confirmed head", async () => {
    const { chain, options, repository } = setup(10n, [], { confirmations: 2n });
    await repository.setCheckpoint(CHAIN_ID, 9n);

    const result = await runOnce(options);

    expect(result.toBlock).toBeNull();
    expect(chain.getLogs).not.toHaveBeenCalled();
  });

  it("reads in bounded block ranges", async () => {
    const { chain, options } = setup(10n, [], { batchSize: 4n });

    await runOnce(options);

    expect(chain.getLogs.mock.calls.map(([args]) => [args.fromBlock, args.toBlock])).toEqual([
      [0n, 3n],
      [4n, 7n],
      [8n, 10n],
    ]);
  });

  it("applies the status sequence Verified, Frozen, then Unfrozen with the auditor losing", async () => {
    const logs = [
      verifiedLog(2n, 0),
      makeLog(bountyEscrowAbi, "Frozen", { contractId: CONTRACT_KEY, findingId: FINDING_KEY }, spot(3n, 0)),
      makeLog(
        bountyEscrowAbi,
        "Unfrozen",
        { contractId: CONTRACT_KEY, findingId: FINDING_KEY, auditorWon: false, verifiedAt: 0n },
        spot(4n, 0),
      ),
    ];
    const { options, findingStatus } = setup(10n, logs);

    await runOnce(options);

    expect(findingStatus.calls.map((c) => c.status)).toEqual(["Verified", "Disputed", "Rejected"]);
  });

  it("calls onStatusApplied after each applied status, including the Unfrozen resolution", async () => {
    const logs = [
      verifiedLog(2n, 0),
      makeLog(bountyEscrowAbi, "Frozen", { contractId: CONTRACT_KEY, findingId: FINDING_KEY }, spot(3n, 0)),
      makeLog(
        bountyEscrowAbi,
        "Unfrozen",
        { contractId: CONTRACT_KEY, findingId: FINDING_KEY, auditorWon: true, verifiedAt: 0n },
        spot(4n, 0),
      ),
    ];
    const applied: Array<[string, string, string]> = [];
    const { options } = setup(10n, logs, {
      onStatusApplied: async (findingId, status, eventName) => {
        applied.push([findingId, status, eventName]);
      },
    });

    await runOnce(options);

    expect(applied).toEqual([
      [FINDING_API_ID, "Verified", "FindingVerified"],
      [FINDING_API_ID, "Disputed", "Frozen"],
      [FINDING_API_ID, "Verified", "Unfrozen"],
    ]);
  });

  it("keeps indexing when onStatusApplied throws", async () => {
    const { options, findingStatus } = setup(10n, [verifiedLog(2n, 0)], {
      onStatusApplied: async () => {
        throw new Error("unlock failed");
      },
    });

    const result = await runOnce(options);

    expect(result.skipped).toBe(false);
    expect(findingStatus.statuses.get(FINDING_API_ID)).toBe("Verified");
  });

  it("does not let a replayed FindingVerified undo a dispute", async () => {
    const { options, findingStatus } = setup(10n, [verifiedLog(2n, 0)]);
    findingStatus.add(FINDING_API_ID, "Disputed", AT.toISOString());

    await runOnce(options);

    expect(await findingStatus.getFindingStatus(FINDING_API_ID)).toBe("Disputed");
  });

  it("maps PayoutCredited to Paid", async () => {
    const logs = [
      verifiedLog(2n, 0),
      makeLog(
        bountyEscrowAbi,
        "PayoutCredited",
        { contractId: CONTRACT_KEY, findingId: FINDING_KEY, auditor: AUDITOR, amount: 10n ** 18n },
        spot(4n, 0),
      ),
    ];
    const { options, findingStatus } = setup(10n, logs);

    await runOnce(options);

    expect(findingStatus.statuses.get(FINDING_API_ID)).toBe("Paid");
  });

  it("returns a lapsed dispute to Verified via the auditor-won unfreeze", async () => {
    // DisputeResolution.lapse unfreezes in the auditor's favour, then emits DisputeLapsed.
    const logs = [
      verifiedLog(2n, 0),
      makeLog(bountyEscrowAbi, "Frozen", { contractId: CONTRACT_KEY, findingId: FINDING_KEY }, spot(3n, 0)),
      makeLog(
        bountyEscrowAbi,
        "Unfrozen",
        { contractId: CONTRACT_KEY, findingId: FINDING_KEY, auditorWon: true, verifiedAt: 0n },
        spot(4n, 0),
      ),
      makeLog(disputeResolutionAbi, "DisputeLapsed", { key: DISPUTE_KEY }, { ...spot(4n, 1), address: DISPUTES }),
    ];
    const { options, findingStatus } = setup(10n, logs);

    await runOnce(options);

    expect(findingStatus.calls.map((c) => c.status)).toEqual(["Verified", "Disputed", "Verified"]);
    expect(findingStatus.statuses.get(FINDING_API_ID)).toBe("Verified");
  });

  it("skips an event that would make an illegal move and keeps indexing past it", async () => {
    // Submitted -> Paid is illegal, so the PayoutCredited is skipped. The
    // later FindingVerified must still apply, or one bad log would stall the chain.
    const logs = [
      makeLog(
        bountyEscrowAbi,
        "PayoutCredited",
        { contractId: CONTRACT_KEY, findingId: FINDING_KEY, auditor: AUDITOR, amount: 10n ** 18n },
        spot(3n, 0),
      ),
      verifiedLog(4n, 0),
    ];
    const { options, findingStatus } = setup(10n, logs);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runOnce(options);

    expect(findingStatus.calls.map((c) => c.status)).toEqual(["Verified"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skipped PayoutCredited"));
    warn.mockRestore();
  });

  it("ignores events that do not change status, without throwing", async () => {
    const logs = [
      makeLog(
        disputeResolutionAbi,
        "DisputeLapsed",
        { key: DISPUTE_KEY },
        { ...spot(4n, 0), address: DISPUTES },
      ),
      makeLog(
        bountyEscrowAbi,
        "Funded",
        { contractId: CONTRACT_KEY, developer: AUDITOR, amount: 1n, deadline: 2n },
        spot(4n, 1),
      ),
    ];
    const { options, findingStatus } = setup(10n, logs);

    const result = await runOnce(options);

    expect(findingStatus.calls).toEqual([]);
    expect(result).toMatchObject({ applied: 0, ignored: 2 });
  });

  it("ignores an event whose topic matches nothing in the ABI", async () => {
    const unknown: ChainLog = {
      address: ESCROW,
      topics: [`0x${"ee".repeat(32)}` as Hex],
      data: "0x",
      blockNumber: 4n,
      transactionHash: `0x${"ab".repeat(32)}` as Hash,
      logIndex: 0,
    };
    const { options, findingStatus } = setup(10n, [unknown]);

    await expect(runOnce(options)).resolves.toMatchObject({ applied: 0, ignored: 1 });
    expect(findingStatus.calls).toEqual([]);
  });

  it("ignores logs from addresses it does not watch", async () => {
    const stray = makeLog(bountyEscrowAbi, "FindingVerified", {
      contractId: CONTRACT_KEY,
      findingId: FINDING_KEY,
      auditor: AUDITOR,
      verifiedAt: 1n,
    }, { ...spot(4n, 0), address: UNWATCHED });
    const { options, findingStatus } = setup(10n, [stray]);

    await runOnce(options);
    expect(findingStatus.calls).toEqual([]);
  });

  it("stores an event for an unknown finding as pending and advances the checkpoint past it", async () => {
    const { options, findingStatus, repository } = setup(10n, [verifiedLog(5n, 0)], {
      listFindingIds: async () => ["finding_other"],
    });

    const result = await runOnce(options);

    expect(findingStatus.calls).toEqual([]);
    expect(result).toMatchObject({ pending: 1, applied: 0 });
    expect(await repository.getCheckpoint(CHAIN_ID)).toBe(10n);
    const [held] = await repository.listPending(CHAIN_ID);
    expect(held).toMatchObject({ logIndex: 0, blockNumber: 5n, address: ESCROW });
    expect(await repository.hasApplied({ chainId: CHAIN_ID, txHash: held!.txHash, logIndex: 0 })).toBe(false);
  });

  it("applies a pending event on the run after its finding is added, without re-reading its block", async () => {
    let ids: string[] = ["finding_other"];
    const { chain, options, findingStatus, repository } = setup(10n, [verifiedLog(5n, 0)], {
      listFindingIds: async () => ids,
    });
    await runOnce(options);

    ids = [FINDING_API_ID];
    chain.getLogs.mockClear();
    const second = await runOnce(options);

    expect(findingStatus.statuses.get(FINDING_API_ID)).toBe("Verified");
    expect(second).toMatchObject({ applied: 1, pending: 0 });
    expect(await repository.listPending(CHAIN_ID)).toEqual([]);
    // Only the checkpoint block is re-read; block 5 comes from the stored log.
    expect(chain.getLogs.mock.calls.every(([args]) => args.fromBlock >= 10n)).toBe(true);
  });

  it("applies pending events in block order when a finding is added", async () => {
    let ids: string[] = ["finding_other"];
    const logs = [
      verifiedLog(4n, 0),
      makeLog(bountyEscrowAbi, "Frozen", { contractId: CONTRACT_KEY, findingId: FINDING_KEY }, spot(6n, 0)),
    ];
    const { options, findingStatus } = setup(10n, logs, { listFindingIds: async () => ids });
    await runOnce(options);

    ids = [FINDING_API_ID];
    await runOnce(options);

    expect(findingStatus.calls.map((c) => c.status)).toEqual(["Verified", "Disputed"]);
  });

  it("drops a pending event once it is older than pendingMaxAgeBlocks", async () => {
    const { options, repository } = setup(10n, [verifiedLog(5n, 0)], {
      listFindingIds: async () => ["finding_other"],
    });
    await runOnce(options);
    expect(await repository.listPending(CHAIN_ID)).toHaveLength(1);

    // Head 10, max age 2: cutoff block 8, so the block-5 log is dropped.
    const result = await runOnce({ ...options, pendingMaxAgeBlocks: 2n });

    expect(result.pruned).toBe(1);
    expect(await repository.listPending(CHAIN_ID)).toEqual([]);
  });

  it("keeps pending events when pendingMaxAgeBlocks is unset", async () => {
    const { options, repository } = setup(100n, [verifiedLog(5n, 0)], {
      listFindingIds: async () => ["finding_other"],
    });

    await runOnce(options);
    const later = await runOnce(options);

    expect(later.pruned).toBe(0);
    expect(await repository.listPending(CHAIN_ID)).toHaveLength(1);
  });
});

describe("runOnce leader lock", () => {
  class HeldLock implements IndexerLock {
    tryAcquire = vi.fn(async () => false);
    release = vi.fn(async () => {});
  }

  it("does nothing when another runner holds the lock", async () => {
    const lock = new HeldLock();
    const { chain, options, repository, findingStatus } = setup(10n, [verifiedLog(5n, 0)], { lock });

    const result = await runOnce(options);

    expect(result).toMatchObject({ skipped: true, fromBlock: null, toBlock: null, applied: 0 });
    expect(chain.getLogs).not.toHaveBeenCalled();
    expect(findingStatus.calls).toEqual([]);
    expect(await repository.getCheckpoint(CHAIN_ID)).toBeNull();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it("releases the lock after a run, even when the run fails", async () => {
    const lock = { tryAcquire: vi.fn(async () => true), release: vi.fn(async () => {}) };
    const { options } = setup(10n, [], { lock, listFindingIds: async () => { throw new Error("db down"); } });

    await expect(runOnce(options)).rejects.toThrow("db down");
    expect(lock.release).toHaveBeenCalledTimes(1);
  });
});

describe("checkpoint", () => {
  it("never moves backwards in the memory repository", async () => {
    const repository = new MemoryIndexerRepository();
    await repository.setCheckpoint(CHAIN_ID, 10n);
    await repository.setCheckpoint(CHAIN_ID, 5n);
    await repository.setCheckpoint(CHAIN_ID, 10n);

    expect(await repository.getCheckpoint(CHAIN_ID)).toBe(10n);
  });
});

describe("startEventIndexer", () => {
  it("does not start without CHAIN_RPC_URL and never creates a client", () => {
    const createClient = vi.fn();
    const config = loadChainConfig({});

    const handle = startEventIndexer({
      config,
      repository: new MemoryIndexerRepository(),
      findingStatus: new RecordingFindingStatus(),
      listFindingIds: async () => [],
      lock: new MemoryIndexerLock(),
      createClient,
    });

    expect(handle).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("stops reading at head minus the configured confirmations", async () => {
    const chain = fakeChain(10n, []);
    const config = loadChainConfig({
      CHAIN_RPC_URL: "http://127.0.0.1:8545",
      CHAIN_ID: String(CHAIN_ID),
      OPERATOR_PRIVATE_KEY: `0x${"11".repeat(32)}`,
      AUDITOR_STAKING_ADDRESS: UNWATCHED,
      BOUNTY_ESCROW_ADDRESS: ESCROW,
      DISPUTE_RESOLUTION_ADDRESS: DISPUTES,
      INDEXER_CONFIRMATIONS: "3",
    });

    const handle = startEventIndexer({
      config,
      repository: new MemoryIndexerRepository(),
      findingStatus: new RecordingFindingStatus(),
      listFindingIds: async () => [],
      lock: new MemoryIndexerLock(),
      startBlock: 5n,
      confirmations: config?.indexerConfirmations,
      createClient: () => chain.client,
      onError: (err) => {
        throw err;
      },
    });
    await handle?.stop();

    expect(chain.getLogs.mock.calls.map(([args]) => [args.fromBlock, args.toBlock])).toEqual([[5n, 7n]]);
  });
});
