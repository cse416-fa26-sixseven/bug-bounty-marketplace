"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { auditorApi, ApiError, type QueueItem } from "@/lib/api";
import { weiToEth } from "@/lib/money";
import { useRequiredStakeWei } from "@/lib/chain/use-chain";
import { REQUIRED_STAKE_WEI, isStakeMet } from "./StakeGate";

type SortOption = "newest" | "deadline" | "bounty";

const SORT_LABELS: Record<SortOption, string> = {
  newest: "Newest",
  deadline: "Deadline",
  bounty: "Bounty size",
};

export function QueueList({ auditorId }: { auditorId: string }) {
  const [sort, setSort] = useState<SortOption>("newest");
  const [search, setSearch] = useState("");
  const [claimError, setClaimError] = useState<string | null>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const queueQuery = useQuery({
    queryKey: ["auditor-queue", sort],
    queryFn: () => auditorApi.listQueue({ sort }),
    refetchInterval: 3_000,
  });

  // Same query as ProfileSummary, so it shares the cache. Claiming needs the
  // required stake (the API answers 403 otherwise), so the buttons stay
  // disabled until it is posted. While the profile is unknown, the API decides.
  const profileQuery = useQuery({
    queryKey: ["auditor-profile", auditorId],
    queryFn: () => auditorApi.getProfile(auditorId),
  });
  const requiredStakeWei = useRequiredStakeWei(REQUIRED_STAKE_WEI);
  const stakeShort = profileQuery.data ? !isStakeMet(profileQuery.data.stake, requiredStakeWei) : false;

  const claimMutation = useMutation({
    mutationFn: (contractId: string) => auditorApi.claimContract({ contractId, auditorId }),
    onSuccess: (contract) => {
      setClaimError(null);
      void queryClient.invalidateQueries({ queryKey: ["auditor-queue"] });
      void queryClient.invalidateQueries({ queryKey: ["auditor-profile"] });
      router.push(`/auditor/contracts/${contract.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 403 && /stake/i.test(err.message)) {
        setClaimError("Your stake is below the required stake. Post the required stake above, then claim.");
        void queryClient.invalidateQueries({ queryKey: ["auditor-profile"] });
        return;
      }
      if (err instanceof ApiError && err.status === 409) {
        // The API says why it refused; only a taken contract means someone else won.
        if (/already holds/i.test(err.message)) {
          setClaimError(
            "You already hold a claim on another contract. Finish it, or wait until it is paid, ruled on or expires.",
          );
          return;
        }
        if (/not funded/i.test(err.message)) {
          setClaimError("This bounty isn’t funded on-chain yet. Try again in a moment.");
          void queryClient.invalidateQueries({ queryKey: ["auditor-queue"] });
          return;
        }
        setClaimError("Someone else already claimed that contract. Refreshing the queue.");
        void queryClient.invalidateQueries({ queryKey: ["auditor-queue"] });
        return;
      }
      setClaimError(err instanceof ApiError ? err.message : "Failed to claim contract.");
    },
  });

  return (
    <section>
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <h2 className="text-xl font-semibold text-white">Open queue</h2>
        <div className="flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 p-1">
          {(Object.keys(SORT_LABELS) as SortOption[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setSort(option)}
              aria-pressed={sort === option}
              className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
                sort === option
                  ? "bg-emerald-500 text-slate-950"
                  : "text-slate-300 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {SORT_LABELS[option]}
            </button>
          ))}
        </div>
      </div>
      <label className="search-field mt-4">
        <input
          aria-label="Search audit queue"
          placeholder="Search open contracts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>

      {stakeShort && (
        <p className="mt-3 text-sm text-amber-400">
          Post the required stake above to claim a contract.
        </p>
      )}
      {claimError && <p className="mt-3 text-sm text-red-400">{claimError}</p>}

      {queueQuery.isLoading && <p className="mt-4 text-slate-400">Loading queue...</p>}
      {queueQuery.isError && <p className="mt-4 text-red-400">Failed to load the queue.</p>}

      {queueQuery.data && queueQuery.data.length === 0 && (
        <p className="mt-4 text-slate-400">No open contracts right now.</p>
      )}

      <ul className="mt-4 flex flex-col gap-3">
        {queueQuery.data
          ?.filter((item) => item.filename.toLowerCase().includes(search.toLowerCase()))
          .map((item: QueueItem) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900 p-4"
            >
              <div>
                <p className="font-medium text-white">{item.filename}</p>
                <p className="text-sm text-slate-400">
                  {weiToEth(item.bounty.amount)} {item.bounty.currency} - deadline{" "}
                  {new Date(item.deadline).toLocaleDateString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setClaimError(null);
                  claimMutation.mutate(item.id);
                }}
                disabled={claimMutation.isPending || stakeShort}
                title={stakeShort ? "Post the required stake to claim" : undefined}
                className="rounded bg-emerald-500 px-4 py-1.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {claimMutation.isPending && claimMutation.variables === item.id
                  ? "Claiming..."
                  : "Claim"}
              </button>
            </li>
          ))}
      </ul>
      {search &&
        queueQuery.data &&
        !queueQuery.data.some((item) =>
          item.filename.toLowerCase().includes(search.toLowerCase()),
        ) && <p className="empty-state">No contracts match your search.</p>}
    </section>
  );
}
