/** Minimal wallet interface: the mock wallet, the anvil-role wallet (local
 * chain) and the injected wallet (MetaMask on a testnet) all implement it. */
export interface Wallet {
  address: string | null;
  isConnected: boolean;
  /** Rejects with a readable Error when connecting fails. */
  connect(): Promise<void>;
  disconnect(): void;
  /** The last connection problem to show (no wallet, rejected, wrong network). */
  error?: string | null;
}
