/** What the web app knows about a chain id: its name, a public RPC to offer
 * a wallet that doesn't have the chain yet, and its block explorer. The one
 * place chain ids map to explorers. */
export interface Network {
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  /** Offered to wallet_addEthereumChain when the API publishes no RPC URL. */
  rpcUrls: readonly string[];
  explorer?: { name: string; url: string };
}

export const SEPOLIA_CHAIN_ID = 11155111;

export const NETWORKS: Readonly<Record<number, Network>> = {
  31337: {
    name: "Local Anvil",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["http://127.0.0.1:8545"],
  },
  [SEPOLIA_CHAIN_ID]: {
    name: "Sepolia",
    nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://ethereum-sepolia-rpc.publicnode.com"],
    explorer: { name: "Etherscan", url: "https://sepolia.etherscan.io" },
  },
};

export function networkName(chainId: number): string {
  return NETWORKS[chainId]?.name ?? `chain ${chainId}`;
}

export function explorerOf(chainId: number): Network["explorer"] | null {
  return NETWORKS[chainId]?.explorer ?? null;
}

/** The explorer page for a transaction, or null when the chain has none. */
export function explorerTxUrl(chainId: number, hash: string): string | null {
  const explorer = explorerOf(chainId);
  return explorer ? `${explorer.url}/tx/${hash}` : null;
}

/** The explorer page for an address, or null when the chain has none. */
export function explorerAddressUrl(chainId: number, address: string): string | null {
  const explorer = explorerOf(chainId);
  return explorer ? `${explorer.url}/address/${address}` : null;
}
