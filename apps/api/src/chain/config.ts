import { readFileSync } from "node:fs";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface ChainConfig {
  rpcUrl: string;
  /** RPC URL the browser uses (PUBLIC_CHAIN_RPC_URL). Null when unset: the
   * internal URL is never published, since provider URLs often carry an API
   * key. */
  publicRpcUrl: string | null;
  chainId: number;
  operatorPrivateKey: Hex;
  auditorStakingAddress: Address;
  bountyEscrowAddress: Address;
  disputeResolutionAddress: Address;
  /** DisputeResolution's arbiter. Defaults to the operator, as the deploy
   * script does. */
  arbiterAddress: Address;
  /** BountyEscrow's challenge window. Defaults to the deploy script's 3 days. */
  challengeWindowSeconds: number;
  /** First block the event indexer reads when it has no checkpoint:
   * INDEXER_START_BLOCK, else the deployments file's deployBlock. Unset reads
   * from block 0, which is fine on anvil but far too slow on a testnet. */
  startBlock?: bigint;
  /** Blocks behind the head the event indexer stops at
   * (INDEXER_CONFIRMATIONS, default 0). Load-balanced public RPCs can answer
   * eth_blockNumber from one backend and eth_getLogs from another a block
   * behind, which rejects a range ending at the head; a few confirmations
   * avoid that and ride out shallow reorgs. */
  indexerConfirmations?: bigint;
}

/** BountyEscrow's default challenge window in Deploy.s.sol: 3 days. */
const DEFAULT_CHALLENGE_WINDOW_SECONDS = 259_200;

/** The keys of the deploy script's deployments/<chainId>.json the API reads. */
const DEPLOYMENT_ADDRESS_KEYS = ["auditorStaking", "bountyEscrow", "disputeResolution", "arbiter"] as const;

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const PRIVATE_KEY = /^0x[a-fA-F0-9]{64}$/;

/**
 * Reads chain settings from the environment. Returns null when CHAIN_RPC_URL
 * is unset, so the API runs without a chain, the same way it runs without
 * DATABASE_URL. Once CHAIN_RPC_URL is set, every other variable is required.
 *
 * With CHAIN_DEPLOYMENTS_FILE (the deploy script's deployments/<chainId>.json),
 * the contract addresses, arbiter and challenge window come only from that
 * file; AUDITOR_STAKING_ADDRESS, BOUNTY_ESCROW_ADDRESS,
 * DISPUTE_RESOLUTION_ADDRESS, ARBITER_ADDRESS and CHALLENGE_WINDOW_SECONDS are
 * then ignored. The file's chainId must equal CHAIN_ID.
 */
export function loadChainConfig(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ChainConfig | null {
  const rpcUrl = env.CHAIN_RPC_URL;
  if (!rpcUrl) return null;

  const deploymentsFile = env.CHAIN_DEPLOYMENTS_FILE;
  const required = deploymentsFile
    ? (["CHAIN_ID", "OPERATOR_PRIVATE_KEY"] as const)
    : ([
        "CHAIN_ID",
        "OPERATOR_PRIVATE_KEY",
        "AUDITOR_STAKING_ADDRESS",
        "BOUNTY_ESCROW_ADDRESS",
        "DISPUTE_RESOLUTION_ADDRESS",
      ] as const);
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`CHAIN_RPC_URL is set but ${missing.join(", ")} is missing`);
  }

  const chainId = Number(env.CHAIN_ID);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error("CHAIN_ID must be a positive integer");
  }

  const operatorPrivateKey = env.OPERATOR_PRIVATE_KEY!;
  if (!PRIVATE_KEY.test(operatorPrivateKey)) {
    throw new Error("OPERATOR_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  }

  const operatorAddress = privateKeyToAccount(operatorPrivateKey as Hex).address;
  const common = {
    rpcUrl,
    publicRpcUrl: env.PUBLIC_CHAIN_RPC_URL || null,
    chainId,
    operatorPrivateKey: operatorPrivateKey as Hex,
  };

  if (deploymentsFile) {
    let text: string;
    try {
      text = readFile(deploymentsFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `CHAIN_DEPLOYMENTS_FILE ${deploymentsFile} does not exist: deploy the contracts first (pnpm stack:demo or docker compose run --rm contracts-deploy)`,
          { cause: err },
        );
      }
      throw err;
    }
    const { deployBlock, ...deployment } = readDeployment(deploymentsFile, text, chainId);
    return withIndexerSettings({ ...common, ...deployment }, env, deployBlock);
  }

  const addresses = [
    "AUDITOR_STAKING_ADDRESS",
    "BOUNTY_ESCROW_ADDRESS",
    "DISPUTE_RESOLUTION_ADDRESS",
    ...(env.ARBITER_ADDRESS ? (["ARBITER_ADDRESS"] as const) : []),
  ] as const;
  for (const name of addresses) {
    if (!ADDRESS.test(env[name]!)) {
      throw new Error(`${name} must be a 0x-prefixed 20-byte address`);
    }
  }

  const challengeWindowSeconds = env.CHALLENGE_WINDOW_SECONDS
    ? Number(env.CHALLENGE_WINDOW_SECONDS)
    : DEFAULT_CHALLENGE_WINDOW_SECONDS;
  if (!Number.isInteger(challengeWindowSeconds) || challengeWindowSeconds < 0) {
    throw new Error("CHALLENGE_WINDOW_SECONDS must be a non-negative integer");
  }

  return withIndexerSettings(
    {
      ...common,
      auditorStakingAddress: env.AUDITOR_STAKING_ADDRESS as Address,
      bountyEscrowAddress: env.BOUNTY_ESCROW_ADDRESS as Address,
      disputeResolutionAddress: env.DISPUTE_RESOLUTION_ADDRESS as Address,
      arbiterAddress: (env.ARBITER_ADDRESS as Address | undefined) ?? operatorAddress,
      challengeWindowSeconds,
    },
    env,
    undefined,
  );
}

/** Adds the indexer settings: startBlock (INDEXER_START_BLOCK when set, else
 * the deploy block) and indexerConfirmations (INDEXER_CONFIRMATIONS, default 0). */
function withIndexerSettings(
  config: ChainConfig,
  env: NodeJS.ProcessEnv,
  deployBlock: bigint | undefined,
): ChainConfig {
  const rawConfirmations = env.INDEXER_CONFIRMATIONS?.trim();
  if (rawConfirmations && !/^\d+$/.test(rawConfirmations)) {
    throw new Error("INDEXER_CONFIRMATIONS must be a non-negative integer number of blocks");
  }
  const withConfirmations = { ...config, indexerConfirmations: BigInt(rawConfirmations || "0") };

  const raw = env.INDEXER_START_BLOCK?.trim();
  if (raw) {
    if (!/^\d+$/.test(raw)) throw new Error("INDEXER_START_BLOCK must be a non-negative integer block number");
    return { ...withConfirmations, startBlock: BigInt(raw) };
  }
  return deployBlock === undefined ? withConfirmations : { ...withConfirmations, startBlock: deployBlock };
}

/** Parses the deploy script's deployments/<chainId>.json. */
function readDeployment(
  path: string,
  text: string,
  chainId: number,
): Pick<
  ChainConfig,
  | "auditorStakingAddress"
  | "bountyEscrowAddress"
  | "disputeResolutionAddress"
  | "arbiterAddress"
  | "challengeWindowSeconds"
> & { deployBlock: bigint | undefined } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`CHAIN_DEPLOYMENTS_FILE ${path} is not valid JSON`, { cause: err });
  }
  for (const key of DEPLOYMENT_ADDRESS_KEYS) {
    const value = parsed[key];
    if (typeof value !== "string" || !ADDRESS.test(value)) {
      throw new Error(`CHAIN_DEPLOYMENTS_FILE ${path} has no valid ${key} address`);
    }
  }
  if (parsed.chainId !== chainId) {
    throw new Error(`CHAIN_DEPLOYMENTS_FILE ${path} is for chain ${String(parsed.chainId)}, not CHAIN_ID ${chainId}`);
  }
  const challengeWindowSeconds = parsed.challengeWindow;
  if (typeof challengeWindowSeconds !== "number" || !Number.isInteger(challengeWindowSeconds) || challengeWindowSeconds < 0) {
    throw new Error(`CHAIN_DEPLOYMENTS_FILE ${path} has no valid challengeWindow`);
  }
  // Written by Deploy.s.sol since the Sepolia runbook; older files have none.
  const deployBlock = parsed.deployBlock;
  if (
    deployBlock !== undefined &&
    (typeof deployBlock !== "number" || !Number.isSafeInteger(deployBlock) || deployBlock < 0)
  ) {
    throw new Error(`CHAIN_DEPLOYMENTS_FILE ${path} has an invalid deployBlock`);
  }
  return {
    deployBlock: deployBlock === undefined ? undefined : BigInt(deployBlock),
    auditorStakingAddress: parsed.auditorStaking as Address,
    bountyEscrowAddress: parsed.bountyEscrow as Address,
    disputeResolutionAddress: parsed.disputeResolution as Address,
    arbiterAddress: parsed.arbiter as Address,
    challengeWindowSeconds,
  };
}

/**
 * True only when CLAIM_LOCK_ENABLED is exactly "true". The on-chain lock on
 * claim stays off by default: a lock with no unlock (plan item 6) can strand
 * an auditor's stake.
 */
export function claimLockEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.CLAIM_LOCK_ENABLED === "true";
}
