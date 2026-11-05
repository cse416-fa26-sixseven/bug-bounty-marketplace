import type { Account, Address, Chain, Hash, Hex, PublicClient, Transport, WalletClient } from "viem";
import { disputeResolutionAbi } from "@bbm/shared";
import { awaitSuccess } from "./tx.js";

export interface OnchainDispute {
  developer: Address;
  auditor: Address;
  /** Unix seconds after which the arbiter's ruling window has closed. */
  ruleBy: bigint;
  resolved: boolean;
}

/** The view of DisputeResolution the API needs. Disputes and rulings are
 * sent by the developer and arbiter from their own wallets, so the API only
 * reads them. The one write is lapse(), which anyone may send once the
 * ruling window has closed; the operator sends it so a dispute the arbiter
 * never rules on does not freeze the payout forever. */
export interface DisputeResolutionPort {
  getDispute(contractId: Hex, findingId: Hex): Promise<OnchainDispute | null>;
  /** Unix seconds of the latest block: the clock lapse() is checked against. */
  latestBlockTime(): Promise<bigint>;
  /** Resolves an unruled dispute past its ruling window in the auditor's favour. */
  lapse(contractId: Hex, findingId: Hex): Promise<Hash>;
}

export interface DisputeResolutionDeps {
  address: Address;
  publicClient: Pick<PublicClient, "readContract" | "getBlock" | "waitForTransactionReceipt">;
  /** Needed only for lapse(); signs with the operator account. */
  walletClient?: Pick<WalletClient<Transport, Chain | undefined, Account>, "writeContract">;
}

export function createDisputeResolutionPort(deps: DisputeResolutionDeps): DisputeResolutionPort {
  const { address, publicClient, walletClient } = deps;

  return {
    async getDispute(contractId, findingId) {
      const key = (await publicClient.readContract({
        address,
        abi: disputeResolutionAbi,
        functionName: "disputeKey",
        args: [contractId, findingId],
      })) as Hex;

      // The public getter for a struct returns its fields in declaration order.
      const [developer, auditor, ruleBy, resolved] = (await publicClient.readContract({
        address,
        abi: disputeResolutionAbi,
        functionName: "disputes",
        args: [key],
      })) as readonly [Address, Address, bigint, boolean];

      // A dispute that was never opened has a zero developer address.
      if (developer === "0x0000000000000000000000000000000000000000") {
        return null;
      }
      return { developer, auditor, ruleBy, resolved };
    },

    async latestBlockTime() {
      return (await publicClient.getBlock()).timestamp;
    },

    async lapse(contractId, findingId) {
      if (!walletClient) throw new Error("DisputeResolution.lapse needs a wallet client");
      const hash = await walletClient.writeContract({
        address,
        abi: disputeResolutionAbi,
        functionName: "lapse",
        args: [contractId, findingId],
        chain: undefined,
      });
      return awaitSuccess(publicClient, hash, "DisputeResolution.lapse");
    },
  };
}
