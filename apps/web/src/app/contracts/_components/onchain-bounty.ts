import { useQuery } from "@tanstack/react-query";
import type { Contract } from "@bbm/shared";
import { BOUNTY_STATE, type OnchainBounty } from "@/lib/chain/calls";
import { useChainCalls } from "@/lib/chain/use-chain";
import { useWallet } from "@/lib/wallet";

/** True when the connected wallet is the contract's developer. Only they may
 * fund, cancel or reclaim its bounty. */
export function useIsContractDeveloper(contract: Contract): boolean {
  const { address } = useWallet();
  return address !== null && address.toLowerCase() === contract.developerAddress.toLowerCase();
}

/** What BountyEscrow holds under the contract's id, from the developer's side. */
export type BountyOwnership =
  /** Nothing funded yet. */
  | "none"
  /** Funded by the contract's developer (any state). */
  | "ours"
  /** Funded by another wallet under this contract's id: not the developer's. */
  | "foreign";

export function bountyOwnership(bounty: OnchainBounty, contract: Contract): BountyOwnership {
  if (bounty.state === BOUNTY_STATE.None) return "none";
  return bounty.developer.toLowerCase() === contract.developerAddress.toLowerCase()
    ? "ours"
    : "foreign";
}

/** The on-chain bounty under the contract's id. Disabled without a chain. */
export function useOnchainBounty(contractId: string) {
  const chain = useChainCalls();
  return useQuery({
    queryKey: ["onchain-bounty", contractId],
    queryFn: () => chain!.readBounty(contractId),
    enabled: chain !== null,
  });
}
