"use client";

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { auditorApi, developerApi } from "@/lib/api";
import { StakeGate } from "./StakeGate";
import { StakeWithdraw } from "./StakeWithdraw";
import { weiToEth } from "@/lib/money";
import { useChainCalls } from "@/lib/chain/use-chain";

export function ProfileSummary({ auditorId }: { auditorId: string }) {
  const queryClient = useQueryClient();
  const contractsQuery = useQuery({
    queryKey: ["auditor-contracts"],
    queryFn: () => developerApi.listContracts(),
    refetchInterval: 3000,
  });
  const profileQuery = useQuery({
    queryKey: ["auditor-profile", auditorId],
    queryFn: () => auditorApi.getProfile(auditorId),
    refetchInterval: 3000,
  });

  const chain = useChainCalls();
  const withdrawMutation = useMutation({
    mutationFn: async () => {
      if (!chain) throw new Error("Withdrawals happen on-chain.");
      await chain.withdrawPayout();
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["auditor-profile", auditorId] }),
  });

  if (profileQuery.isLoading) {
    return <p className="text-slate-400">Loading profile...</p>;
  }
  if (profileQuery.isError || !profileQuery.data) {
    return <p className="text-red-400">Failed to load auditor profile.</p>;
  }

  const profile = profileQuery.data;

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-slate-800 bg-slate-900 p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-slate-400">Stake</p>
            <p className="text-lg font-semibold text-white">{Number(weiToEth(profile.stake)).toLocaleString()}</p>
          </div>
          {chain && profile.pendingPayout !== undefined ? (
            <div>
              <p className="text-sm text-slate-400">Payout to withdraw</p>
              <p className="text-lg font-semibold text-white">{weiToEth(profile.pendingPayout)} ETH</p>
              {profile.pendingPayout !== "0" ? (
                <button
                  type="button"
                  onClick={() => withdrawMutation.mutate()}
                  disabled={withdrawMutation.isPending}
                  className="mt-1 rounded bg-emerald-500 px-3 py-1 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  {withdrawMutation.isPending ? "Withdrawing..." : "Withdraw"}
                </button>
              ) : null}
              {withdrawMutation.error ? (
                <p className="mt-1 text-sm text-red-400">{withdrawMutation.error.message}</p>
              ) : null}
            </div>
          ) : null}
          <div>
            <p className="text-sm text-slate-400">Reputation</p>
            <p className="text-lg font-semibold text-white">{profile.reputation}</p>
          </div>
          <div>
            <p className="text-sm text-slate-400">Claimed contracts</p>
            {profile.claimedContractIds.length === 0 ? (
              <p className="text-slate-400">None yet</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {profile.claimedContractIds.map((id) => (
                  <li key={id}>
                    <Link
                      href={`/auditor/contracts/${id}`}
                      className="rounded border border-slate-700 px-2 py-0.5 text-sm text-emerald-400 hover:border-emerald-500"
                    >
                      {contractsQuery.data?.find((c) => c.id === id)?.filename ?? id}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {profile.stake !== "0" ? (
          <div className="mt-4 border-t border-slate-800 pt-4">
            <StakeWithdraw
              profile={profile}
              auditorId={auditorId}
              onWithdrawn={() =>
                void queryClient.invalidateQueries({ queryKey: ["auditor-profile", auditorId] })
              }
            />
          </div>
        ) : null}
      </section>
      <StakeGate
        profile={profile}
        auditorId={auditorId}
        onStaked={() =>
          void queryClient.invalidateQueries({ queryKey: ["auditor-profile", auditorId] })
        }
      />
    </div>
  );
}
