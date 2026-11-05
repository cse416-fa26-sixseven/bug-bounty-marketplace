import { useQuery } from "@tanstack/react-query";
import type { ChainInfo } from "@bbm/shared";
import { getChainInfo } from "@/lib/api/chain";
import { LOCAL_CHAIN_ID } from "./accounts";
import type { ConfiguredChainInfo, LocalChainInfo } from "./calls";

/** The API's chain description; fetched once per session. */
export function useChainInfo(): ChainInfo | undefined {
  return useQuery({ queryKey: ["chain"], queryFn: getChainInfo, staleTime: Infinity, retry: false }).data;
}

/** True when the API runs on the local anvil chain the demo accounts live on,
 * with an RPC URL the browser can use. */
export function isLocalChain(info: ChainInfo | undefined): info is LocalChainInfo {
  return info?.configured === true && info.chainId === LOCAL_CHAIN_ID && Boolean(info.rpcUrl);
}

/** True when the API runs on another chain (Sepolia, ...): users sign with
 * their own injected wallet (MetaMask), which brings its own RPC. */
export function isInjectedChain(info: ChainInfo | undefined): info is ConfiguredChainInfo {
  return info?.configured === true && info.chainId !== LOCAL_CHAIN_ID;
}

/** True when user actions are real transactions, on either kind of chain. */
export function isOnChain(info: ChainInfo | undefined): info is ConfiguredChainInfo {
  return isLocalChain(info) || isInjectedChain(info);
}

/**
 * How the browser signs:
 * - local: the role's anvil key (chain id 31337 with a browser RPC URL);
 * - injected: the user's EIP-1193 wallet (any other configured chain);
 * - mock: nothing is signed (no chain, or anvil without a browser RPC URL).
 */
export type ChainMode = "local" | "injected" | "mock";

export function chainMode(info: ChainInfo | undefined): ChainMode {
  if (isLocalChain(info)) return "local";
  if (isInjectedChain(info)) return "injected";
  return "mock";
}
