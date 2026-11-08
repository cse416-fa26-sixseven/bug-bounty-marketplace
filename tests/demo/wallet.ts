import type { BrowserContext } from "@playwright/test";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  hexToBigInt,
  http,
  numberToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * A headless EIP-1193 wallet for the demo recorder: the page sees a
 * `window.ethereum` that answers like MetaMask, and every request lands here
 * in Node, where the role's private key signs SIWE messages and
 * transactions and a public RPC broadcasts them. Nothing is ever shown or
 * confirmed: the recording has no wallet pop-ups to wait for.
 *
 * Keys come from the environment (see record.ts); never commit one.
 */
export interface HeadlessWalletOptions {
  key: Hex;
  chainId: number;
  rpcUrl: string;
}

export interface HeadlessWallet {
  address: Address;
  request(method: string, params?: unknown[]): Promise<unknown>;
  /** The account's balance in ETH, for the pre-flight check. */
  balanceEth(): Promise<string>;
}

interface SendParams {
  from?: Address;
  to?: Address;
  data?: Hex;
  value?: Hex;
  gas?: Hex;
}

export function headlessWallet(options: HeadlessWalletOptions): HeadlessWallet {
  const account = privateKeyToAccount(options.key);
  const chain = defineChain({
    id: options.chainId,
    name: `chain-${options.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(options.rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(options.rpcUrl) });
  let authorized = false;

  async function request(method: string, params: unknown[] = []): Promise<unknown> {
    switch (method) {
      case "eth_requestAccounts":
        authorized = true;
        return [account.address];
      case "eth_accounts":
        return authorized ? [account.address] : [];
      case "eth_chainId":
        return numberToHex(options.chainId);
      case "wallet_switchEthereumChain":
      case "wallet_addEthereumChain":
        // One chain only, and it is always the API's.
        return null;
      case "personal_sign": {
        const [data, from] = params as [Hex, Address];
        if (from.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error(`demo wallet: cannot sign for ${from}`);
        }
        return account.signMessage({ message: { raw: data } });
      }
      case "eth_sendTransaction": {
        const tx = (params[0] ?? {}) as SendParams;
        if (tx.from && tx.from.toLowerCase() !== account.address.toLowerCase()) {
          throw new Error(`demo wallet: cannot send from ${tx.from}`);
        }
        // viem fills the nonce, gas and fees from the RPC, signs and broadcasts.
        return walletClient.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? hexToBigInt(tx.value) : undefined,
          gas: tx.gas ? hexToBigInt(tx.gas) : undefined,
        });
      }
      default:
        // Reads (eth_call, receipts, ...) go straight to the RPC.
        return publicClient.request({ method, params } as never);
    }
  }

  return {
    address: account.address,
    request,
    balanceEth: async () =>
      formatEther(await publicClient.getBalance({ address: account.address })),
  };
}

/**
 * Installs `wallet` as `window.ethereum` in every page of `context`. The
 * page-side shim is plain source, not a function: tsx/esbuild would wrap a
 * function's inner functions in a `__name` helper the page does not have.
 */
export async function installWallet(
  context: BrowserContext,
  wallet: HeadlessWallet,
): Promise<void> {
  await context.exposeFunction("__bbmWalletRequest", (method: string, params: unknown[]) =>
    wallet.request(method, params),
  );
  await context.addInitScript({ content: PROVIDER_SHIM });
}

const PROVIDER_SHIM = `
(() => {
  const listeners = new Map();
  const provider = {
    isMetaMask: true,
    isBbmDemoWallet: true,
    request: ({ method, params }) => window.__bbmWalletRequest(method, params ?? []),
    on: (event, listener) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(listener);
    },
    removeListener: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
  };
  Object.defineProperty(window, "ethereum", { value: provider, configurable: true, writable: false });
})();
`;
