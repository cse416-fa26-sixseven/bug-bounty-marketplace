import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, Hex } from "viem";
import type { Dispute } from "@bbm/shared";
import { MemoryDisputeRepository } from "../disputes/memory-repository.js";
import { runLapsesOnce } from "./dispute-lapser.js";
import type { OnchainDispute } from "./dispute-resolution.js";
import { onchainId } from "./ids.js";

const DEVELOPER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const AUDITOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hash;
/** Chain time of the latest block, in unix seconds. */
const CHAIN_NOW = 2_000_000_000n;
const at = (seconds: bigint) => new Date(Number(seconds) * 1000);

function dispute(n: number): Dispute & { contractId: string } {
  return {
    id: `dispute_${n}`,
    findingId: `finding_${n}`,
    contractId: `contract_${n}`,
    developerId: DEVELOPER,
    reason: "not exploitable",
    openedAt: "2026-10-20T12:00:00.000Z",
    challengeWindowExpiresAt: "2026-10-21T12:00:00.000Z",
    ruling: "Pending",
    ruledAt: null,
    arbiterId: null,
  };
}

/** A fake DisputeResolution: disputes keyed by finding id, resolved by lapse(). */
function fakeChain(onchain: Record<string, Partial<OnchainDispute> | null>) {
  const byFindingKey = new Map<Hex, OnchainDispute | null>();
  for (const [findingId, d] of Object.entries(onchain)) {
    byFindingKey.set(
      onchainId(findingId),
      d === null ? null : { developer: DEVELOPER, auditor: AUDITOR, ruleBy: CHAIN_NOW - 1n, resolved: false, ...d },
    );
  }
  return {
    latestBlockTime: vi.fn(async () => CHAIN_NOW),
    getDispute: vi.fn(async (_contract: Hex, finding: Hex) => byFindingKey.get(finding) ?? null),
    lapse: vi.fn(async (_contract: Hex, finding: Hex) => {
      const d = byFindingKey.get(finding);
      if (!d || d.resolved || d.ruleBy >= CHAIN_NOW) throw new Error("would revert");
      d.resolved = true;
      return HASH;
    }),
  };
}

describe("runLapsesOnce", () => {
  it("lapses a Pending dispute past its ruling window, once", async () => {
    const disputes = new MemoryDisputeRepository();
    await disputes.create({ ...dispute(1), ruleBy: at(CHAIN_NOW - 1n) });
    const chain = fakeChain({ finding_1: {} });

    await expect(runLapsesOnce({ disputes, disputeResolution: chain })).resolves.toEqual({
      candidates: 1,
      lapsed: 1,
      failed: 0,
    });
    expect(chain.lapse).toHaveBeenCalledWith(onchainId("contract_1"), onchainId("finding_1"));

    // Until the indexer settles it the row is still Pending; the chain read
    // sees it resolved, so the next pass sends nothing.
    await expect(runLapsesOnce({ disputes, disputeResolution: chain })).resolves.toMatchObject({ lapsed: 0 });
    expect(chain.lapse).toHaveBeenCalledTimes(1);
  });

  it("leaves a dispute whose ruling window is still open", async () => {
    const disputes = new MemoryDisputeRepository();
    await disputes.create({ ...dispute(1), ruleBy: at(CHAIN_NOW + 60n) });
    const chain = fakeChain({ finding_1: { ruleBy: CHAIN_NOW + 60n } });

    await expect(runLapsesOnce({ disputes, disputeResolution: chain })).resolves.toEqual({
      candidates: 0,
      lapsed: 0,
      failed: 0,
    });
    expect(chain.getDispute).not.toHaveBeenCalled();
  });

  it("uses chain time, not the server clock", async () => {
    // Window closed by chain time (anvil warped ahead) though not by wall time.
    const disputes = new MemoryDisputeRepository();
    const ruleBy = CHAIN_NOW - 1n;
    await disputes.create({ ...dispute(1), ruleBy: at(ruleBy) });
    const chain = fakeChain({ finding_1: { ruleBy } });
    vi.useFakeTimers({ now: at(ruleBy - 3n * 86_400n) });
    try {
      await expect(runLapsesOnce({ disputes, disputeResolution: chain })).resolves.toMatchObject({ lapsed: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fills in a missing ruling window from the chain and lapses only when it has closed", async () => {
    const disputes = new MemoryDisputeRepository();
    await disputes.create(dispute(1));
    await disputes.create(dispute(2));
    const chain = fakeChain({ finding_1: { ruleBy: CHAIN_NOW + 60n }, finding_2: { ruleBy: CHAIN_NOW - 5n } });

    await expect(runLapsesOnce({ disputes, disputeResolution: chain })).resolves.toEqual({
      candidates: 2,
      lapsed: 1,
      failed: 0,
    });
    expect(chain.lapse).toHaveBeenCalledWith(onchainId("contract_2"), onchainId("finding_2"));
    // dispute_1 now has its open window recorded, so it is no longer a
    // candidate; dispute_2 stays one until the indexer settles it.
    expect((await disputes.listLapseCandidates(at(CHAIN_NOW))).map((c) => c.id)).toEqual(["dispute_2"]);
  });

  it("skips a dispute that does not exist on-chain or is already resolved", async () => {
    const disputes = new MemoryDisputeRepository();
    await disputes.create({ ...dispute(1), ruleBy: at(CHAIN_NOW - 1n) });
    await disputes.create({ ...dispute(2), ruleBy: at(CHAIN_NOW - 1n) });
    const chain = fakeChain({ finding_1: null, finding_2: { resolved: true } });

    await expect(runLapsesOnce({ disputes, disputeResolution: chain })).resolves.toMatchObject({
      candidates: 2,
      lapsed: 0,
      failed: 0,
    });
    expect(chain.lapse).not.toHaveBeenCalled();
  });

  it("ignores ruled disputes", async () => {
    const disputes = new MemoryDisputeRepository();
    const stored = await disputes.create({ ...dispute(1), ruleBy: at(CHAIN_NOW - 1n) });
    await disputes.setRuling(stored.id, "AgainstAuditor", DEVELOPER, new Date());
    const chain = fakeChain({ finding_1: {} });

    await expect(runLapsesOnce({ disputes, disputeResolution: chain })).resolves.toMatchObject({ candidates: 0 });
  });

  it("reports a failed lapse and goes on with the rest", async () => {
    const disputes = new MemoryDisputeRepository();
    await disputes.create({ ...dispute(1), ruleBy: at(CHAIN_NOW - 1n) });
    await disputes.create({ ...dispute(2), ruleBy: at(CHAIN_NOW - 1n) });
    const chain = fakeChain({ finding_1: {}, finding_2: {} });
    chain.lapse.mockRejectedValueOnce(new Error("rpc unavailable"));
    const onError = vi.fn();

    await expect(runLapsesOnce({ disputes, disputeResolution: chain, onError })).resolves.toEqual({
      candidates: 2,
      lapsed: 1,
      failed: 1,
    });
    expect(onError).toHaveBeenCalledWith("lapse failed for dispute dispute_1", expect.any(Error));
  });
});
