"use client";

import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AnalysisStatus, Contract } from "@bbm/shared";
import { developerApi } from "@/lib/api";
import { BOUNTY_STATE } from "@/lib/chain/calls";
import { useChainCalls } from "@/lib/chain/use-chain";
import { weiToEth } from "@/lib/money";
import { bountyOwnership, useIsContractDeveloper, useOnchainBounty } from "./onchain-bounty";

/** `datetime-local` value for a date, in local time. */
function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/**
 * Locks the bounty in BountyEscrow once the analysis is done, with the amount
 * and deadline entered at upload (or a later deadline if that one has
 * passed), then lets the API confirm it and list the contract for auditors.
 * Shown only to the contract's developer, on a chain, while the contract is
 * Open: in mock mode the bounty is simulated.
 *
 * A bounty the developer already funded on-chain is confirmed with the API
 * again once the analysis is done, so a confirmation that failed earlier is
 * not left behind; both steps are idempotent. A bounty another wallet funded
 * under this contract's id is not the developer's: they are told to cancel.
 */
export function FundBounty({
  contract,
  analysis,
}: {
  contract: Contract;
  analysis: AnalysisStatus | undefined;
}) {
  const chain = useChainCalls();
  const isDeveloper = useIsContractDeveloper(contract);
  const queryClient = useQueryClient();
  // Read once: whether the stored deadline has passed only matters when the
  // page opens; the submit handler re-checks against the current time.
  const [openedAt] = useState(() => Date.now());
  const [newDeadline, setNewDeadline] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const visible = chain !== null && isDeveloper && contract.status === "Open";
  const analysed = analysis?.status === "Done";

  const bountyQuery = useQuery({
    queryKey: ["bounty", contract.id],
    queryFn: () => developerApi.getBounty(contract.id),
    enabled: visible,
  });
  const onchainQuery = useOnchainBounty(contract.id);
  const ownership = onchainQuery.data ? bountyOwnership(onchainQuery.data, contract) : undefined;
  const fundedByUs = ownership === "ours" && onchainQuery.data?.state === BOUNTY_STATE.Open;
  // Keyed on the analysis status: the API refuses until it is Done, so a
  // confirmation tried earlier is tried again once it is.
  const confirmQuery = useQuery({
    queryKey: ["confirm-funded", contract.id, analysis?.status],
    queryFn: () => developerApi.markFunded(contract.id),
    enabled: visible && analysed && fundedByUs,
    retry: false,
    staleTime: Infinity,
  });

  const fundMutation = useMutation({
    mutationFn: async (deadline: Date) => {
      if (!chain || !bountyQuery.data) throw new Error("The bounty terms have not loaded yet.");
      await chain.fundBounty(contract.id, deadline, bountyQuery.data.amount, contract.developerAddress);
      return developerApi.markFunded(contract.id);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["contract", contract.id] });
      void queryClient.invalidateQueries({ queryKey: ["bounty", contract.id] });
    },
    // Even on failure: if another wallet funded under this id first, the
    // fresh read switches the form to that message.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["onchain-bounty", contract.id] }),
  });

  if (!visible || analysis?.status === "Failed") return null;
  if (onchainQuery.isError) {
    return (
      <p role="alert" className="mt-6 text-sm text-red-400">
        Could not read the bounty on-chain: {onchainQuery.error.message}
      </p>
    );
  }
  if (!onchainQuery.data) return null;

  if (ownership === "foreign") {
    return (
      <p role="alert" className="mt-6 text-sm text-amber-300">
        Another wallet has funded a bounty under this contract&apos;s id, so it can&apos;t be
        funded here. Cancel this contract and submit the file again.
      </p>
    );
  }

  if (fundedByUs) {
    return (
      <div className="mt-6">
        <p role="status" className="text-sm text-emerald-300">
          Bounty funded on-chain.{" "}
          {analysed ? "Auditors can claim this contract." : "Auditors can claim it once the analysis is done."}
        </p>
        {confirmQuery.isError && (
          <p className="mt-1 text-sm text-red-400">
            Funded on-chain, but the API could not confirm it: {confirmQuery.error.message}{" "}
            <button
              type="button"
              onClick={() => void confirmQuery.refetch()}
              className="font-medium text-emerald-300 underline"
            >
              Try again
            </button>
          </p>
        )}
      </div>
    );
  }

  // Ours but no longer open (paid or closed): nothing to fund.
  if (ownership !== "none") return null;

  const bounty = bountyQuery.data;
  const deadlinePassed = bounty ? new Date(bounty.deadline).getTime() <= openedAt : false;
  const error =
    inputError ?? (fundMutation.error instanceof Error ? fundMutation.error.message : null);

  return (
    <form
      className="mt-6 rounded-lg border border-slate-800 bg-slate-900 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!bounty) return;
        let deadline = new Date(bounty.deadline);
        if (deadlinePassed) {
          deadline = new Date(newDeadline);
          if (!newDeadline || !Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) {
            setInputError("Choose a new deadline in the future.");
            return;
          }
        }
        setInputError(null);
        fundMutation.mutate(deadline);
      }}
    >
      <p className="text-sm font-medium text-slate-200">
        Fund the bounty{bounty ? `: ${weiToEth(bounty.amount)} ${bounty.currency}` : ""}
      </p>
      <p className="mt-1 text-sm text-slate-400">
        {analysed
          ? "The analysis is done. Lock the bounty in escrow to list this contract for auditors."
          : "Funding opens once the analysis finishes."}
      </p>
      {analysed && deadlinePassed && (
        <div className="mt-3">
          <label htmlFor="fund-deadline" className="block text-sm text-amber-300">
            The deadline you entered has passed. Choose a new one.
          </label>
          <input
            id="fund-deadline"
            type="datetime-local"
            value={newDeadline}
            min={toLocalInput(new Date(openedAt))}
            onChange={(e) => setNewDeadline(e.target.value)}
            className="mt-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-white"
          />
        </div>
      )}
      <button
        type="submit"
        disabled={!analysed || !bounty || fundMutation.isPending}
        className="mt-3 rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {fundMutation.isPending ? "Funding..." : "Fund bounty"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
