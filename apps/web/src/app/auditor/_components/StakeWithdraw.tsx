"use client";

import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { compareWei, type AuditorProfile } from "@bbm/shared";
import { auditorApi, ApiError } from "@/lib/api";
import { ethToWei, weiToEth } from "@/lib/money";
import { useChainCalls } from "@/lib/chain/use-chain";

/** Takes stake back. AuditorStaking refuses while any claim or pending
 * finding holds a lock, so the form is disabled then and says why. */
export function StakeWithdraw({
  profile,
  auditorId,
  onWithdrawn,
}: {
  profile: AuditorProfile;
  auditorId: string;
  onWithdrawn: () => void;
}) {
  const chain = useChainCalls();
  const [amount, setAmount] = useState(() => weiToEth(profile.stake));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (amountWei: string) => {
      if (chain) await chain.withdrawStake(amountWei);
      else await auditorApi.withdrawStake({ auditorId, amount: amountWei });
    },
    onSuccess: () => {
      setError(null);
      onWithdrawn();
    },
    onError: (err) => {
      setError(err instanceof ApiError || chain ? (err as Error).message : "Failed to withdraw stake.");
    },
  });

  const locked = (profile.activeSubmissions ?? 0) > 0;

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        let amountWei: string;
        try {
          amountWei = ethToWei(amount);
        } catch {
          setError("Enter an amount in ETH, up to 18 decimal places.");
          return;
        }
        if (amountWei === "0") {
          setError("Enter a positive amount.");
          return;
        }
        if (compareWei(amountWei, profile.stake) > 0) {
          setError("That is more than your stake.");
          return;
        }
        setError(null);
        mutation.mutate(amountWei);
      }}
    >
      <label htmlFor="withdraw-stake-amount" className="text-sm text-slate-400">
        Withdraw stake
      </label>
      <input
        id="withdraw-stake-amount"
        type="number"
        step="any"
        value={amount}
        disabled={locked}
        onChange={(e) => setAmount(e.target.value)}
        className="w-32 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={locked || mutation.isPending}
        className="rounded border border-slate-600 px-3 py-1 text-sm font-medium text-slate-200 hover:border-slate-400 disabled:opacity-50"
      >
        {mutation.isPending ? "Withdrawing..." : "Withdraw stake"}
      </button>
      {locked && (
        <p className="w-full text-sm text-amber-400">
          Locked while you have an active claim or a finding awaiting its verdict, payout or ruling.
        </p>
      )}
      {error && <p className="w-full text-sm text-red-400">{error}</p>}
    </form>
  );
}
