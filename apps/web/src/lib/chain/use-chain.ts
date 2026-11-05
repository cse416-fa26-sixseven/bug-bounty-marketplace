import { useMemo } from "react";
import type { Hash } from "viem";
import { ensureSignedIn } from "@/lib/api/auth";
import { useRoleStore } from "@/lib/role/store";
import { injectedTxClient, prepareInjectedSend, useInjectedStore } from "@/lib/wallet/injected";
import { SEED_AUDITOR_ID } from "@/mocks/db";
import { ANVIL_ACCOUNTS } from "./accounts";
import { chainCalls, viemTxClient, type ChainCalls } from "./calls";
import { chainMode, isLocalChain, isOnChain, useChainInfo } from "./config";
import { useLastTx } from "./tx-store";

/**
 * The user's on-chain actions: signed by the selected role's anvil key on the
 * local chain, or by the connected injected wallet on any other chain. Null
 * in mock-only mode, where flows keep calling the mock API alone. Before
 * signing, each action makes sure the API session is the signing account's,
 * so the API call that follows is made as the same account.
 */
export function useChainCalls(): ChainCalls | null {
  const info = useChainInfo();
  const role = useRoleStore((s) => s.role);
  const address = useInjectedStore((s) => s.address);
  return useMemo(() => {
    if (!isOnChain(info)) return null;
    const onSent = (hash: Hash) => useLastTx.getState().record({ chainId: info.chainId, hash });
    if (isLocalChain(info)) {
      const account = ANVIL_ACCOUNTS[role];
      return chainCalls(info, viemTxClient(info, account), {
        beforeSend: () => ensureSignedIn(account),
        onSent,
      });
    }
    return chainCalls(info, injectedTxClient(info, address), {
      beforeSend: () => prepareInjectedSend(info, address),
      onSent,
    });
  }, [info, role, address]);
}

/** The auditor id the API knows: the auditor's anvil address on the local
 * chain, the connected wallet's address on another chain ("" until one is
 * connected), the mock DB's seeded auditor otherwise. */
export function useAuditorId(): string {
  const info = useChainInfo();
  const address = useInjectedStore((s) => s.address);
  const mode = chainMode(info);
  if (mode === "local") return ANVIL_ACCOUNTS.auditor.address;
  if (mode === "injected") return address ?? "";
  return SEED_AUDITOR_ID;
}

/** Required auditor stake in wei: the contract's on a chain, the mock demo's
 * otherwise (passed in so callers keep their own default). */
export function useRequiredStakeWei(mockDefault: string): string {
  const info = useChainInfo();
  return isOnChain(info) ? info.requiredStakeWei : mockDefault;
}
