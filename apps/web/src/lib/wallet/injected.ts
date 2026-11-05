import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  getAddress,
  http,
  numberToHex,
  type Address,
  type Chain,
  type EIP1193Provider,
} from "viem";
import { create } from "zustand";
import { ensureSignedIn, sessionAddress, signIn, signOut, type MessageSigner } from "@/lib/api/auth";
import { ChainTxError, reasonOf, type ConfiguredChainInfo, type TxClient } from "@/lib/chain/calls";
import { NETWORKS, explorerOf, networkName } from "@/lib/chain/networks";

/**
 * Injected-wallet (EIP-1193, `window.ethereum`, e.g. MetaMask) mode, used when
 * the API's chain is not the local anvil chain. The connected account is the
 * user's identity: connect() asks for an account, switches the wallet to the
 * API's chain, then signs in with SIWE. Transactions go through the wallet.
 */

/** A wallet problem with a message the UI can show as is. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletError";
  }
}

export const NO_WALLET =
  "No browser wallet found. Install MetaMask (or another Ethereum wallet), then reload the page.";
export const REJECTED = "You rejected the request in your wallet.";
export const CONNECT_FIRST = "Connect your wallet first.";
export const ACCOUNT_CHANGED = "Your wallet switched accounts. Connect again to sign in with it.";

export function wrongNetwork(chainId: number): string {
  return `Wrong network: switch your wallet to ${networkName(chainId)}.`;
}

export function injectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { ethereum?: EIP1193Provider }).ethereum ?? null;
}

/** The EIP-1193 / JSON-RPC error code on `err` or anything it wraps. */
export function walletErrorCode(err: unknown): number | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const e = current as { code?: unknown; data?: { originalError?: { code?: unknown } }; cause?: unknown };
    if (typeof e.code === "number") return e.code;
    // MetaMask mobile wraps 4902 in -32603's data.originalError.
    if (typeof e.data?.originalError?.code === "number") return e.data.originalError.code;
    current = e.cause;
  }
  return undefined;
}

/** Text for a failed wallet request. */
export function readableWalletError(err: unknown): string {
  if (err instanceof WalletError || err instanceof ChainTxError) return err.message;
  const code = walletErrorCode(err);
  if (code === 4001) return REJECTED;
  if (code === -32002) return "Your wallet already has a request waiting. Open it to continue.";
  return reasonOf(err);
}

/** A viem chain for the API's chain id, named from NETWORKS. */
export function chainFor(info: ConfiguredChainInfo): Chain {
  const network = NETWORKS[info.chainId];
  const explorer = explorerOf(info.chainId);
  return defineChain({
    id: info.chainId,
    name: networkName(info.chainId),
    nativeCurrency: network?.nativeCurrency ?? { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: info.rpcUrl ? [info.rpcUrl] : [...(network?.rpcUrls ?? [])] } },
    ...(explorer ? { blockExplorers: { default: explorer } } : {}),
  });
}

/** Switches the wallet to the API's chain, adding it when the wallet doesn't
 * know it (4902). Throws WalletError if the wallet stays elsewhere. */
export async function ensureWalletChain(provider: EIP1193Provider, info: ConfiguredChainInfo): Promise<void> {
  if (Number(await provider.request({ method: "eth_chainId" })) === info.chainId) return;
  const chainId = numberToHex(info.chainId);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (err) {
    if (walletErrorCode(err) !== 4902) throw err;
    const chain = chainFor(info);
    const rpcUrls = chain.rpcUrls.default.http;
    if (rpcUrls.length === 0) {
      throw new WalletError(`Add ${chain.name} (chain id ${info.chainId}) to your wallet, then try again.`);
    }
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [...rpcUrls],
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
  if (Number(await provider.request({ method: "eth_chainId" })) !== info.chainId) {
    throw new WalletError(wrongNetwork(info.chainId));
  }
}

/** Signs SIWE messages with the wallet account (personal_sign). */
export function injectedSigner(provider: EIP1193Provider, address: Address): MessageSigner {
  const wallet = createWalletClient({ account: address, transport: custom(provider) });
  return { address, signMessage: ({ message }) => wallet.signMessage({ account: address, message }) };
}

interface InjectedState {
  /** The connected account, set only once the API session is this account's. */
  address: Address | null;
  /** The wallet's current chain, as it last reported. */
  chainId: number | null;
  error: string | null;
  connecting: boolean;
}

export const useInjectedStore = create<InjectedState>(() => ({
  address: null,
  chainId: null,
  error: null,
  connecting: false,
}));

/** Asks the wallet for an account (eth_requestAccounts), switches it to the
 * API's chain and signs in with SIWE. Throws a WalletError with readable
 * text, which also lands in the store's `error`. */
export async function connectInjected(info: ConfiguredChainInfo): Promise<Address> {
  useInjectedStore.setState({ connecting: true, error: null });
  try {
    const provider = injectedProvider();
    if (!provider) throw new WalletError(NO_WALLET);
    const [first] = await provider.request({ method: "eth_requestAccounts" });
    if (!first) throw new WalletError("Your wallet did not share an account. Unlock it and try again.");
    const address = getAddress(first);
    await ensureWalletChain(provider, info);
    await signIn(injectedSigner(provider, address));
    useInjectedStore.setState({ address, chainId: info.chainId, connecting: false });
    return address;
  } catch (err) {
    const message = readableWalletError(err);
    useInjectedStore.setState({ error: message, connecting: false });
    throw new WalletError(message);
  }
}

/** Clears the connection and the API session. */
export async function disconnectInjected(): Promise<void> {
  useInjectedStore.setState({ address: null, error: null });
  await signOut();
}

/** On page load, without prompting: the wallet's already-shared account counts
 * as connected only while the API session is still that account's. */
export async function restoreInjected(info: ConfiguredChainInfo): Promise<void> {
  const provider = injectedProvider();
  if (!provider) return;
  const [first] = await provider.request({ method: "eth_accounts" });
  const chainId = Number(await provider.request({ method: "eth_chainId" }));
  const session = await sessionAddress();
  // A Connect click while this was waiting wins: keep what it set.
  const current = useInjectedStore.getState();
  if (current.connecting || current.address) return;
  const address = first && session && session.toLowerCase() === first.toLowerCase() ? getAddress(first) : null;
  // A session for an account the wallet isn't sharing would keep pages
  // reading as that account: clear it.
  if (session && !address) await signOut();
  useInjectedStore.setState({ address, chainId, error: chainId === info.chainId ? null : wrongNetwork(info.chainId) });
}

/** Follows accountsChanged and chainChanged. On an account change or a
 * disconnect it signs out (the API session is the old account's), then
 * calls onIdentityChange so pages refetch; a new account must connect (sign
 * in) again. Returns an unsubscribe. */
export function watchInjected(info: ConfiguredChainInfo, onIdentityChange: () => void): () => void {
  const provider = injectedProvider();
  if (!provider) return () => undefined;
  const onAccounts = (accounts: Address[]) => {
    const next = accounts[0] ? getAddress(accounts[0]) : null;
    const { address } = useInjectedStore.getState();
    if (next === address) return;
    useInjectedStore.setState({ address: null, error: next && address ? ACCOUNT_CHANGED : null });
    void signOut()
      .catch((err: unknown) => console.error("sign-out failed", err))
      .finally(onIdentityChange);
  };
  const onChain = (hex: string) => {
    const chainId = Number(hex);
    useInjectedStore.setState({ chainId, error: chainId === info.chainId ? null : wrongNetwork(info.chainId) });
  };
  provider.on("accountsChanged", onAccounts);
  provider.on("chainChanged", onChain);
  return () => {
    provider.removeListener("accountsChanged", onAccounts);
    provider.removeListener("chainChanged", onChain);
  };
}

/** chainCalls' beforeSend in injected mode: a wallet, an account, the right
 * chain, and an API session for that account (signing in again if needed). */
export async function prepareInjectedSend(
  info: ConfiguredChainInfo,
  address: Address | null,
  provider: EIP1193Provider | null = injectedProvider(),
): Promise<void> {
  try {
    if (!provider) throw new WalletError(NO_WALLET);
    if (!address) throw new WalletError(CONNECT_FIRST);
    await ensureWalletChain(provider, info);
    await ensureSignedIn(injectedSigner(provider, address));
  } catch (err) {
    throw new ChainTxError(readableWalletError(err));
  }
}

/** TxClient over the injected wallet. Reads and receipts use the API's
 * browser RPC URL when it publishes one, else the wallet's own RPC. */
export function injectedTxClient(
  info: ConfiguredChainInfo,
  address: Address | null,
  provider: EIP1193Provider | null = injectedProvider(),
): TxClient {
  const chain = chainFor(info);
  const transport = info.rpcUrl ? http(info.rpcUrl) : provider ? custom(provider) : null;
  const publicClient = transport ? createPublicClient({ chain, transport }) : null;
  // Reads through the wallet follow its current chain, so check it first
  // (without prompting a switch); the API's RPC URL is always the API's chain.
  const reader = async () => {
    if (!publicClient) throw new ChainTxError(NO_WALLET);
    if (!info.rpcUrl && provider && Number(await provider.request({ method: "eth_chainId" })) !== info.chainId) {
      throw new ChainTxError(wrongNetwork(info.chainId));
    }
    return publicClient;
  };
  const sender = () => {
    if (!provider) throw new ChainTxError(NO_WALLET);
    if (!address) throw new ChainTxError(CONNECT_FIRST);
    return { provider, account: address };
  };
  return {
    async simulate(request) {
      const { account } = sender();
      try {
        await (await reader()).simulateContract({ ...request, account } as never);
      } catch (err) {
        throw new ChainTxError(reasonOf(err));
      }
    },
    async write(request) {
      const { provider: wallet, account } = sender();
      try {
        await ensureWalletChain(wallet, info);
        const client = createWalletClient({ chain, transport: custom(wallet), account });
        return await client.writeContract({ ...request, account, chain } as never);
      } catch (err) {
        throw new ChainTxError(readableWalletError(err));
      }
    },
    async waitForSuccess(hash) {
      const receipt = await (await reader()).waitForTransactionReceipt({ hash });
      return receipt.status === "success";
    },
    async read(request) {
      return (await reader()).readContract(request as never);
    },
  };
}
