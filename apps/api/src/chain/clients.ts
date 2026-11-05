import { createPublicClient, createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAuditorStakingPort, type AuditorStakingPort } from "./auditor-staking.js";
import { claimLockEnabled, loadChainConfig, type ChainConfig } from "./config.js";
import { createBountyEscrowPort, type BountyEscrowPort } from "./bounty-escrow.js";
import { createDisputeResolutionPort, type DisputeResolutionPort } from "./dispute-resolution.js";

/** Builds the AuditorStaking port against the configured RPC node, signing
 * lock/unlock with the operator key. Only called when a chain is configured. */
export function createAuditorStakingFromConfig(config: ChainConfig): AuditorStakingPort {
  const transport = http(config.rpcUrl);
  const account = privateKeyToAccount(config.operatorPrivateKey);
  return createAuditorStakingPort({
    address: config.auditorStakingAddress as Address,
    publicClient: createPublicClient({ transport }),
    walletClient: createWalletClient({ account, transport }),
  });
}

/**
 * Decides whether the API gets an AuditorStaking port. Returns undefined
 * unless CHAIN_RPC_URL is set and CLAIM_LOCK_ENABLED=true; claims then skip
 * the on-chain lock. The chain config is still parsed when the lock is off,
 * so a malformed CHAIN_RPC_URL setup fails at startup either way.
 */
export function buildAuditorStakingPort(
  env: NodeJS.ProcessEnv,
  createPort: (config: ChainConfig) => AuditorStakingPort = createAuditorStakingFromConfig,
): AuditorStakingPort | undefined {
  const chainConfig = loadChainConfig(env);
  if (!chainConfig || !claimLockEnabled(env)) return undefined;
  return createPort(chainConfig);
}

/** Builds the BountyEscrow port against the configured RPC node, signing
 * submission, verification and payout writes with the operator key. Only
 * called when a chain is configured. */
export function createBountyEscrowFromConfig(config: ChainConfig): BountyEscrowPort {
  const transport = http(config.rpcUrl);
  const account = privateKeyToAccount(config.operatorPrivateKey);
  return createBountyEscrowPort({
    address: config.bountyEscrowAddress as Address,
    publicClient: createPublicClient({ transport }),
    walletClient: createWalletClient({ account, transport }),
  });
}

/** DisputeResolution port: reads disputes and rulings, and sends lapse()
 * with the operator key. */
export function createDisputeResolutionFromConfig(config: ChainConfig): DisputeResolutionPort {
  const transport = http(config.rpcUrl);
  const account = privateKeyToAccount(config.operatorPrivateKey);
  return createDisputeResolutionPort({
    address: config.disputeResolutionAddress,
    publicClient: createPublicClient({ transport }),
    walletClient: createWalletClient({ account, transport }),
  });
}
