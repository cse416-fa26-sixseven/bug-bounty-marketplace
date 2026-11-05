"use client";

import React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Contract, Finding } from "@bbm/shared";
import { developerApi } from "@/lib/api";
import { BOUNTY_STATE } from "@/lib/chain/calls";
import { useChainCalls } from "@/lib/chain/use-chain";
import { bountyOwnership, useIsContractDeveloper, useOnchainBounty } from "./onchain-bounty";

/**
 * The developer's actions on their contract's bounty: reclaim it after the
 * deadline, cancel the contract while it is Open, and delete a bounty left
 * open on-chain after the contract was cancelled (for example, funded in a
 * race with the cancel). Shown only to the contract's developer.
 *
 * On a chain, a bounty is funded only after the analysis, so there may be
 * nothing on-chain: cancel then needs no deleteBounty (nor when another
 * wallet funded under this contract's id, which the developer cannot
 * delete), and there is nothing to reclaim.
 */
export function ContractActions({ contract, findings }: { contract: Contract; findings: Finding[] }) {
  const chain = useChainCalls();
  const isDeveloper = useIsContractDeveloper(contract);
  const queryClient = useQueryClient();
  const onchainQuery = useOnchainBounty(contract.id);
  const onchain = onchainQuery.data;
  const openAndOurs =
    onchain !== undefined &&
    bountyOwnership(onchain, contract) === "ours" &&
    onchain.state === BOUNTY_STATE.Open;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["contract", contract.id] });
    void queryClient.invalidateQueries({ queryKey: ["onchain-bounty", contract.id] });
  };

  const reclaimMutation = useMutation({
    mutationFn: async () => {
      // On-chain the developer takes the bounty back (refund), then the API records it.
      if (chain) await chain.refund(contract.id);
      return developerApi.reclaimBounty(contract.id);
    },
    onSuccess: refresh,
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (chain) {
        // Read now, not from the cache: only the developer's own open bounty
        // is deleted on-chain; the API checks the chain either way.
        const fresh = await chain.readBounty(contract.id);
        if (bountyOwnership(fresh, contract) === "ours" && fresh.state === BOUNTY_STATE.Open) {
          await chain.deleteBounty(contract.id);
        }
      }
      return developerApi.cancelContract(contract.id);
    },
    onSuccess: refresh,
  });

  const deleteStrandedMutation = useMutation({
    mutationFn: () => chain!.deleteBounty(contract.id),
    onSuccess: refresh,
  });

  if (!isDeveloper) return null;

  // Without a chain the mock bounty is funded at upload.
  const fundedOnChain = chain === null || openAndOurs;
  const showReclaim =
    fundedOnChain && contract.status !== "Resolved" && contract.status !== "Expired";
  const canReclaim =
    showReclaim &&
    new Date(contract.deadline) < new Date() &&
    !findings.some((f) => ["Submitted", "Verified", "Disputed"].includes(f.status));
  const canCancel = contract.status === "Open";
  const stranded = chain !== null && contract.status === "Expired" && openAndOurs;

  const error = [reclaimMutation.error, cancelMutation.error, deleteStrandedMutation.error].find(
    (e): e is Error => e instanceof Error,
  );

  return (
    <>
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {showReclaim && (
          <button
            type="button"
            disabled={!canReclaim || reclaimMutation.isPending}
            onClick={() => {
              if (window.confirm("Reclaim this expired bounty?")) reclaimMutation.mutate();
            }}
            title={canReclaim ? undefined : "Only available after the deadline passes"}
            className="rounded-md border border-slate-700 px-3 py-1.5 text-sm font-medium text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reclaimMutation.isPending ? "Reclaiming..." : "Reclaim bounty"}
          </button>
        )}

        {canCancel && (
          <button
            type="button"
            disabled={cancelMutation.isPending}
            onClick={() => {
              if (window.confirm("Cancel this contract and close its bounty?"))
                cancelMutation.mutate();
            }}
            className="rounded-md border border-red-500/50 px-3 py-1.5 text-sm font-medium text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cancelMutation.isPending ? "Cancelling..." : "Cancel contract"}
          </button>
        )}

        {stranded && (
          <button
            type="button"
            disabled={deleteStrandedMutation.isPending}
            onClick={() => {
              if (window.confirm("Delete this bounty on-chain and get your funds back?"))
                deleteStrandedMutation.mutate();
            }}
            className="rounded-md border border-amber-500/50 px-3 py-1.5 text-sm font-medium text-amber-300 hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {deleteStrandedMutation.isPending ? "Deleting..." : "Delete on-chain bounty"}
          </button>
        )}
      </div>
      {stranded && (
        <p className="mt-2 text-sm text-amber-300">
          This contract is cancelled, but its bounty is still open on-chain. Delete it to get your
          funds back.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-400">{error.message}</p>}
      {onchainQuery.isError && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          Could not read the bounty on-chain: {onchainQuery.error.message}
        </p>
      )}
    </>
  );
}
