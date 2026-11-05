"use client";

import { useState } from "react";
import { useWallet } from "@/lib/wallet";

function shortenAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletBadge() {
  const wallet = useWallet();
  const [connecting, setConnecting] = useState(false);

  const error = wallet.error ? (
    <span role="alert" className="max-w-xs text-xs text-red-400">
      {wallet.error}
    </span>
  ) : null;

  if (!wallet.isConnected || !wallet.address) {
    return (
      <div className="flex items-center gap-2">
        {error}
        <button
          type="button"
          disabled={connecting}
          onClick={() => {
            setConnecting(true);
            // The wallet keeps a readable error to show; nothing to rethrow.
            void wallet
              .connect()
              .catch(() => undefined)
              .finally(() => setConnecting(false));
          }}
          className="rounded-full bg-emerald-500 px-3 py-1 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
        >
          {connecting ? "Connecting…" : "Connect wallet"}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {error}
      <button
        type="button"
        onClick={() => wallet.disconnect()}
        title="Click to disconnect"
        className="flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-sm text-slate-200 hover:border-slate-500"
      >
        <span className="h-2 w-2 rounded-full bg-emerald-400" aria-hidden />
        Connected as {shortenAddress(wallet.address)}
      </button>
    </div>
  );
}
