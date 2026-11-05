import { describe, expect, it, vi } from "vitest";
import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { onchainId } from "./ids.js";
import { claimLockEnabled, loadChainConfig } from "./config.js";
import { createAuditorStakingPort } from "./auditor-staking.js";

const STAKING = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
const AUDITOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const HASH = `0x${"ab".repeat(32)}` as Hash;
const KEY = `0x${"11".repeat(32)}`;
const ARBITER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const VALID_ENV = {
  CHAIN_RPC_URL: "http://127.0.0.1:8545",
  CHAIN_ID: "31337",
  OPERATOR_PRIVATE_KEY: KEY,
  AUDITOR_STAKING_ADDRESS: STAKING,
  BOUNTY_ESCROW_ADDRESS: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  DISPUTE_RESOLUTION_ADDRESS: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
};

describe("onchainId", () => {
  it("is a deterministic 32-byte keccak256 of the API id", () => {
    const id = onchainId("contract_123");
    expect(id).toMatch(/^0x[a-f0-9]{64}$/);
    expect(onchainId("contract_123")).toBe(id);
    expect(onchainId("contract_456")).not.toBe(id);
  });
});

describe("loadChainConfig", () => {
  it("returns null when CHAIN_RPC_URL is unset", () => {
    expect(loadChainConfig({})).toBeNull();
  });

  it("parses a complete environment", () => {
    const config = loadChainConfig(VALID_ENV);
    expect(config).toMatchObject({ chainId: 31337, auditorStakingAddress: STAKING });
  });

  it("names every missing variable once CHAIN_RPC_URL is set", () => {
    expect(() => loadChainConfig({ CHAIN_RPC_URL: "http://x" })).toThrow(
      /CHAIN_ID, OPERATOR_PRIVATE_KEY, AUDITOR_STAKING_ADDRESS/,
    );
  });

  it("rejects a malformed address", () => {
    expect(() => loadChainConfig({ ...VALID_ENV, BOUNTY_ESCROW_ADDRESS: "0x123" })).toThrow(
      /BOUNTY_ESCROW_ADDRESS/,
    );
  });

  it("rejects a malformed private key", () => {
    expect(() => loadChainConfig({ ...VALID_ENV, OPERATOR_PRIVATE_KEY: "0x1234" })).toThrow(
      /OPERATOR_PRIVATE_KEY/,
    );
  });

  it("reads addresses, arbiter and challenge window from CHAIN_DEPLOYMENTS_FILE", () => {
    const deployment = {
      auditorStaking: STAKING,
      bountyEscrow: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
      disputeResolution: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      arbiter: ARBITER,
      challengeWindow: 60,
      chainId: 31337,
    };
    const config = loadChainConfig(
      {
        CHAIN_RPC_URL: "http://anvil:8545",
        PUBLIC_CHAIN_RPC_URL: "http://localhost:8545",
        CHAIN_ID: "31337",
        OPERATOR_PRIVATE_KEY: KEY,
        CHAIN_DEPLOYMENTS_FILE: "/deployments/31337.json",
      },
      (path) => {
        expect(path).toBe("/deployments/31337.json");
        return JSON.stringify(deployment);
      },
    );
    expect(config).toMatchObject({
      auditorStakingAddress: STAKING,
      bountyEscrowAddress: deployment.bountyEscrow,
      disputeResolutionAddress: deployment.disputeResolution,
      arbiterAddress: ARBITER,
      challengeWindowSeconds: 60,
      publicRpcUrl: "http://localhost:8545",
    });
  });

  it("names a field missing from the deployments file", () => {
    expect(() =>
      loadChainConfig(
        { CHAIN_RPC_URL: "http://x", CHAIN_ID: "31337", OPERATOR_PRIVATE_KEY: KEY, CHAIN_DEPLOYMENTS_FILE: "/d.json" },
        () =>
          JSON.stringify({ auditorStaking: STAKING, disputeResolution: STAKING, arbiter: ARBITER, challengeWindow: 60, chainId: 31337 }),
      ),
    ).toThrow(/bountyEscrow/);
  });

  it("defaults the arbiter to the operator and the window to 3 days without a deployments file", () => {
    const config = loadChainConfig(VALID_ENV);
    expect(config?.arbiterAddress).toBe(privateKeyToAccount(KEY as Hex).address);
    expect(config?.challengeWindowSeconds).toBe(259200);
    expect(config?.publicRpcUrl).toBeNull();
  });

  const FILE_ENV = {
    CHAIN_RPC_URL: "http://anvil:8545",
    CHAIN_ID: "31337",
    OPERATOR_PRIVATE_KEY: KEY,
    CHAIN_DEPLOYMENTS_FILE: "/d.json",
  };
  const GOOD_FILE = {
    auditorStaking: STAKING,
    bountyEscrow: STAKING,
    disputeResolution: STAKING,
    arbiter: ARBITER,
    challengeWindow: 60,
    chainId: 31337,
  };

  it("reads a Sepolia deployments file and starts the indexer at its deploy block", () => {
    const env = { ...FILE_ENV, CHAIN_ID: "11155111", CHAIN_RPC_URL: "https://rpc.invalid" };
    const file = JSON.stringify({ ...GOOD_FILE, chainId: 11155111, deployBlock: 9_100_000 });
    expect(loadChainConfig(env, () => file)).toMatchObject({ chainId: 11155111, startBlock: 9_100_000n });
    expect(loadChainConfig({ ...env, INDEXER_START_BLOCK: "9200000" }, () => file)?.startBlock).toBe(9_200_000n);
  });

  it("leaves the start block unset without deployBlock or INDEXER_START_BLOCK", () => {
    expect(loadChainConfig(FILE_ENV, () => JSON.stringify(GOOD_FILE))?.startBlock).toBeUndefined();
    expect(loadChainConfig({ ...VALID_ENV, INDEXER_START_BLOCK: "42" })?.startBlock).toBe(42n);
  });

  it("rejects a malformed start block", () => {
    expect(() => loadChainConfig({ ...VALID_ENV, INDEXER_START_BLOCK: "-1" })).toThrow(/INDEXER_START_BLOCK/);
    expect(() =>
      loadChainConfig(FILE_ENV, () => JSON.stringify({ ...GOOD_FILE, deployBlock: "x" })),
    ).toThrow(/deployBlock/);
  });

  it("defaults the indexer's confirmations to 0 and reads INDEXER_CONFIRMATIONS", () => {
    expect(loadChainConfig(VALID_ENV)?.indexerConfirmations).toBe(0n);
    expect(loadChainConfig({ ...VALID_ENV, INDEXER_CONFIRMATIONS: "" })?.indexerConfirmations).toBe(0n);
    expect(loadChainConfig({ ...VALID_ENV, INDEXER_CONFIRMATIONS: "3" })?.indexerConfirmations).toBe(3n);
    expect(loadChainConfig({ ...VALID_ENV, INDEXER_CONFIRMATIONS: " 0 " })?.indexerConfirmations).toBe(0n);
    expect(
      loadChainConfig({ ...FILE_ENV, INDEXER_CONFIRMATIONS: "12" }, () => JSON.stringify(GOOD_FILE))
        ?.indexerConfirmations,
    ).toBe(12n);
  });

  it.each(["-1", "2.5", "abc", "1e3", "0x10"])("rejects INDEXER_CONFIRMATIONS=%j", (value) => {
    expect(() => loadChainConfig({ ...VALID_ENV, INDEXER_CONFIRMATIONS: value })).toThrow(/INDEXER_CONFIRMATIONS/);
  });

  it("rejects a deployments file that is not JSON", () => {
    expect(() => loadChainConfig(FILE_ENV, () => "not json")).toThrow(/not valid JSON/);
  });

  it("rejects a non-numeric challengeWindow in the deployments file", () => {
    expect(() =>
      loadChainConfig(FILE_ENV, () => JSON.stringify({ ...GOOD_FILE, challengeWindow: null })),
    ).toThrow(/challengeWindow/);
    expect(() =>
      loadChainConfig(FILE_ENV, () => JSON.stringify({ ...GOOD_FILE, challengeWindow: "60" })),
    ).toThrow(/challengeWindow/);
  });

  it("rejects a deployments file for another chain", () => {
    expect(() =>
      loadChainConfig(FILE_ENV, () => JSON.stringify({ ...GOOD_FILE, chainId: 11155111 })),
    ).toThrow(/not CHAIN_ID 31337/);
  });

  it("explains a missing deployments file", () => {
    expect(() =>
      loadChainConfig(FILE_ENV, () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
    ).toThrow(/deploy the contracts first/);
  });

  it("rejects a malformed ARBITER_ADDRESS", () => {
    expect(() => loadChainConfig({ ...VALID_ENV, ARBITER_ADDRESS: "0x12" })).toThrow(/ARBITER_ADDRESS/);
  });

  it("reads CHALLENGE_WINDOW_SECONDS and rejects a bad value", () => {
    expect(loadChainConfig({ ...VALID_ENV, CHALLENGE_WINDOW_SECONDS: "60" })?.challengeWindowSeconds).toBe(60);
    expect(() => loadChainConfig({ ...VALID_ENV, CHALLENGE_WINDOW_SECONDS: "soon" })).toThrow(
      /CHALLENGE_WINDOW_SECONDS/,
    );
  });

  it("rejects a non-integer chain id", () => {
    expect(() => loadChainConfig({ ...VALID_ENV, CHAIN_ID: "sepolia" })).toThrow(/CHAIN_ID/);
  });
});

describe("createAuditorStakingPort", () => {
  function fakeClients(receiptStatus: "success" | "reverted" = "success") {
    const publicClient = {
      readContract: vi.fn(),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: receiptStatus }),
    };
    const walletClient = { writeContract: vi.fn().mockResolvedValue(HASH) };
    return { publicClient, walletClient };
  }

  it("reads stake and open submissions from the contract", async () => {
    const { publicClient, walletClient } = fakeClients();
    publicClient.readContract
      .mockResolvedValueOnce(100_000_000_000_000_000n)
      .mockResolvedValueOnce(2n);
    const port = createAuditorStakingPort({ address: STAKING, publicClient, walletClient });

    await expect(port.stakeOf(AUDITOR)).resolves.toBe(100_000_000_000_000_000n);
    await expect(port.activeSubmissions(AUDITOR)).resolves.toBe(2n);
    expect(publicClient.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: STAKING, functionName: "stakeOf", args: [AUDITOR] }),
    );
  });

  it("sends lockSubmission and waits for the receipt", async () => {
    const { publicClient, walletClient } = fakeClients();
    const port = createAuditorStakingPort({ address: STAKING, publicClient, walletClient });

    await expect(port.lockSubmission(AUDITOR)).resolves.toBe(HASH);
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: STAKING, functionName: "lockSubmission", args: [AUDITOR] }),
    );
    expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: HASH });
  });

  it("sends unlockSubmission", async () => {
    const { publicClient, walletClient } = fakeClients();
    const port = createAuditorStakingPort({ address: STAKING, publicClient, walletClient });

    await port.unlockSubmission(AUDITOR);
    expect(walletClient.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "unlockSubmission", args: [AUDITOR] }),
    );
  });

  it("throws when the transaction reverts", async () => {
    const { publicClient, walletClient } = fakeClients("reverted");
    const port = createAuditorStakingPort({ address: STAKING, publicClient, walletClient });

    await expect(port.lockSubmission(AUDITOR)).rejects.toThrow(/lockSubmission reverted/);
  });
});

describe("claimLockEnabled", () => {
  it("is off unless CLAIM_LOCK_ENABLED is exactly true", () => {
    expect(claimLockEnabled({})).toBe(false);
    expect(claimLockEnabled({ CLAIM_LOCK_ENABLED: "false" })).toBe(false);
    expect(claimLockEnabled({ CLAIM_LOCK_ENABLED: "1" })).toBe(false);
    expect(claimLockEnabled({ CLAIM_LOCK_ENABLED: "true" })).toBe(true);
  });
});
