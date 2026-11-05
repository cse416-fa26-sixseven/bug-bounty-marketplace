import { chainMode, useChainInfo } from "@/lib/chain/config";
import { useWallet as useMockWallet } from "./mock";
import { useLocalWallet } from "./local";
import { useInjectedWallet } from "./use-injected-wallet";
import type { Wallet } from "./types";

export type { Wallet } from "./types";

/** The role's anvil account on the local chain; the user's injected wallet
 * (MetaMask) on any other chain the API runs on; the mock wallet otherwise
 * (mock-only demo). */
export function useWallet(): Wallet {
  const info = useChainInfo();
  const mock = useMockWallet();
  const local = useLocalWallet();
  const injected = useInjectedWallet(info);
  const mode = chainMode(info);
  return mode === "local" ? local : mode === "injected" ? injected : mock;
}
