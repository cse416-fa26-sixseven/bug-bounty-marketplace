import { useQueryClient } from "@tanstack/react-query";
import type { ChainInfo } from "@bbm/shared";
import { isInjectedChain } from "@/lib/chain/config";
import { connectInjected, disconnectInjected, useInjectedStore } from "./injected";
import type { Wallet } from "./types";

/** Wallet backed by the browser's injected wallet (MetaMask). connect()
 * requests an account, switches chains and signs in with SIWE. */
export function useInjectedWallet(info: ChainInfo | undefined): Wallet {
  const address = useInjectedStore((s) => s.address);
  const error = useInjectedStore((s) => s.error);
  const queryClient = useQueryClient();
  const refetch = () => queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "chain" });

  return {
    address,
    isConnected: address !== null,
    error,
    async connect() {
      if (!isInjectedChain(info)) return;
      await connectInjected(info);
      await refetch();
    },
    disconnect() {
      void disconnectInjected()
        .catch((err: unknown) => console.error("sign-out failed", err))
        .then(refetch);
    },
  };
}
