"use client";

import React, { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { compareWei, type AuditorProfile } from "@bbm/shared";
import { auditorApi, ApiError } from "@/lib/api";
import { ethToWei, weiToEth } from "@/lib/money";
import { useChainCalls, useRequiredStakeWei } from "@/lib/chain/use-chain";

/** Minimum stake an auditor must have posted before claiming a contract and
 * before the PoC-upload UI unlocks, in demo ETH. Deliberately set above the seed auditor's starting
 * 5,000 stake so the gate is demonstrable rather than already-satisfied. */
export const REQUIRED_STAKE = 10_000;
export const REQUIRED_STAKE_WEI = ethToWei(String(REQUIRED_STAKE));

/** True when a wei stake meets the requirement. Compared exactly, not as numbers. */
export function isStakeMet(stakeWei: string, requiredWei: string = REQUIRED_STAKE_WEI): boolean {
  return compareWei(stakeWei, requiredWei) >= 0;
}

export function StakeGate({
  profile,
  auditorId,
  onStaked,
}: {
  profile: AuditorProfile;
  auditorId: string;
  onStaked: () => void;
}) {
  const chain = useChainCalls();
  // On the local chain the requirement is AuditorStaking.REQUIRED_STAKE.
  const requiredWei = useRequiredStakeWei(REQUIRED_STAKE_WEI);
  const shortfallWei = BigInt(requiredWei) - BigInt(profile.stake);
  const [amount, setAmount] = useState(shortfallWei > 0n ? weiToEth(shortfallWei.toString()) : "1000");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: async (amountWei: string) => {
      // On-chain the auditor stakes from their own wallet; the profile reads it back.
      if (chain) await chain.stake(amountWei);
      else await auditorApi.postStake({ auditorId, amount: amountWei });
    },
    onSuccess: () => {
      setError(null);
      onStaked();
    },
    onError: (err) => {
      setError(err instanceof ApiError || chain ? (err as Error).message : "Failed to post stake.");
    },
  });

  const met = isStakeMet(profile.stake, requiredWei);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-slate-400">{chain ? "Stake · ETH on the local chain" : "Stake · demo units"}</p>
          <p className="text-lg font-semibold text-white">
            {Number(weiToEth(profile.stake)).toLocaleString()} /{" "}
            {Number(weiToEth(requiredWei)).toLocaleString()} required
          </p>
          {!met && (
            <p className="text-sm text-slate-400">
              Claiming a contract and submitting a PoC both need the required stake.
            </p>
          )}
        </div>
        {met ? (
          <span className="rounded-full bg-emerald-500/20 px-3 py-1 text-sm font-medium text-emerald-400">
            PoC upload unlocked
          </span>
        ) : (
          <span className="rounded-full bg-amber-500/20 px-3 py-1 text-sm font-medium text-amber-400">
            PoC upload locked
          </span>
        )}
      </div>

      {!met && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            let amountWei: string;
            try {
              amountWei = ethToWei(amount);
            } catch {
              setError("Enter a stake in ETH, up to 18 decimal places.");
              return;
            }
            if (amountWei === "0") {
              setError("Enter a positive stake amount.");
              return;
            }
            setError(null);
            mutation.mutate(amountWei);
          }}
        >
          <label htmlFor="stake-amount" className="text-sm text-slate-400">
            Post stake
          </label>
          <input
            id="stake-amount"
            type="number"
            step="any"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-32 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white"
          />
          <button
            type="submit"
            disabled={mutation.isPending}
            className="rounded bg-emerald-500 px-3 py-1 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
          >
            {mutation.isPending ? "Posting..." : "Post stake"}
          </button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </div>
  );
}
