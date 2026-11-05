import { create } from "zustand";

export interface SentTx {
  chainId: number;
  hash: string;
}

/** The user's last confirmed transaction, for the explorer link notice. */
export const useLastTx = create<{
  last: SentTx | null;
  record: (tx: SentTx) => void;
  clear: () => void;
}>()((set) => ({
  last: null,
  record: (last) => set({ last }),
  clear: () => set({ last: null }),
}));
