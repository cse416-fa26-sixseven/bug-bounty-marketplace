import {
  BaseError,
  ContractFunctionRevertedError,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { auditorStakingAbi } from "@bbm/shared";
import { awaitSuccess } from "./tx.js";

/**
 * AuditorStaking.lockSubmission reverted with StakeBelowRequired: the
 * auditor's stake is under REQUIRED_STAKE, so the contract refused the lock.
 * Nothing was mined. Callers answer it like the API's own stake gate.
 */
export class StakeBelowRequiredError extends Error {
  constructor(
    readonly auditor: Address,
    /** The auditor's stake in wei, as the contract reported it. */
    readonly stake: bigint,
    options?: ErrorOptions,
  ) {
    super(`AuditorStaking.lockSubmission refused ${auditor}: stake ${stake} is below the required stake`, options);
    this.name = "StakeBelowRequiredError";
  }
}

/** The StakeBelowRequired revert inside a viem error, if that is what it is.
 * viem decodes it from the gas estimate it runs before sending. */
function asStakeBelowRequired(err: unknown): StakeBelowRequiredError | null {
  if (!(err instanceof BaseError)) return null;
  const revert = err.walk((cause) => cause instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  if (revert.data?.errorName !== "StakeBelowRequired") return null;
  const [auditor, stake] = (revert.data.args ?? []) as [Address, bigint];
  return new StakeBelowRequiredError(auditor, stake, { cause: err });
}

/** The operator-side view of AuditorStaking the API needs. */
export interface AuditorStakingPort {
  stakeOf(auditor: Address): Promise<bigint>;
  reputation(auditor: Address): Promise<bigint>;
  activeSubmissions(auditor: Address): Promise<bigint>;
  /** Rejects with StakeBelowRequiredError when the contract refuses the lock
   * because the auditor's stake is under REQUIRED_STAKE. */
  lockSubmission(auditor: Address): Promise<Hash>;
  unlockSubmission(auditor: Address): Promise<Hash>;
}

export interface AuditorStakingDeps {
  address: Address;
  publicClient: Pick<PublicClient, "readContract" | "waitForTransactionReceipt">;
  /** Must be created with the operator account, since lock/unlock are operator-only. */
  walletClient: Pick<WalletClient<Transport, Chain | undefined, Account>, "writeContract">;
}

export function createAuditorStakingPort(deps: AuditorStakingDeps): AuditorStakingPort {
  const { address, publicClient, walletClient } = deps;

  async function send(functionName: "lockSubmission" | "unlockSubmission", auditor: Address): Promise<Hash> {
    let hash: Hash;
    try {
      hash = await walletClient.writeContract({
        address,
        abi: auditorStakingAbi,
        functionName,
        args: [auditor],
        chain: undefined,
      });
    } catch (err) {
      throw asStakeBelowRequired(err) ?? err;
    }
    return awaitSuccess(publicClient, hash, `AuditorStaking.${functionName}`);
  }

  return {
    stakeOf: (auditor) =>
      publicClient.readContract({
        address,
        abi: auditorStakingAbi,
        functionName: "stakeOf",
        args: [auditor],
      }) as Promise<bigint>,
    reputation: async (auditor) =>
      BigInt(
        (await publicClient.readContract({
          address,
          abi: auditorStakingAbi,
          functionName: "reputation",
          args: [auditor],
        })) as bigint,
      ),
    activeSubmissions: (auditor) =>
      publicClient.readContract({
        address,
        abi: auditorStakingAbi,
        functionName: "activeSubmissions",
        args: [auditor],
      }) as Promise<bigint>,
    lockSubmission: (auditor) => send("lockSubmission", auditor),
    unlockSubmission: (auditor) => send("unlockSubmission", auditor),
  };
}
