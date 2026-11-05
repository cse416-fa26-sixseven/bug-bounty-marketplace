"use client";

import { explorerOf, explorerTxUrl } from "@/lib/chain/networks";
import { useLastTx } from "@/lib/chain/tx-store";

/** A link to the transaction on the chain's block explorer; nothing when the
 * chain has none (the local anvil chain). */
export function TxLink({ chainId, hash, children }: { chainId: number; hash: string; children?: React.ReactNode }) {
  const url = explorerTxUrl(chainId, hash);
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline hover:text-white">
      {children ?? `View on ${explorerOf(chainId)!.name}`}
    </a>
  );
}

/** After a user transaction confirms on a chain with an explorer, shows its
 * link until dismissed or replaced by the next one. */
export function TxNotice() {
  const last = useLastTx((s) => s.last);
  const clear = useLastTx((s) => s.clear);
  if (!last || !explorerTxUrl(last.chainId, last.hash)) return null;
  return (
    <div role="status" className="demo-banner">
      <strong>Transaction confirmed</strong>
      <span className="font-mono">
        {last.hash.slice(0, 10)}…{last.hash.slice(-8)}
      </span>
      <TxLink chainId={last.chainId} hash={last.hash} />
      <button type="button" onClick={clear} className="ml-auto underline" aria-label="Dismiss transaction notice">
        Dismiss
      </button>
    </div>
  );
}
