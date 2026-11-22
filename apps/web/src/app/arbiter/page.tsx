"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { arbiterApi, ApiError } from "@/lib/api";
import { useWallet } from "@/lib/wallet";
import { useChainCalls, useWalletGate } from "@/lib/chain/use-chain";
import { DisputeCard } from "./_components/DisputeCard";

type Tab = "Pending" | "ForAuditor" | "AgainstAuditor" | "All";

const TABS: { id: Tab; label: string }[] = [
  { id: "Pending", label: "Open" },
  { id: "ForAuditor", label: "Ruled for auditor" },
  { id: "AgainstAuditor", label: "Ruled against auditor" },
  { id: "All", label: "All" },
];

const FALLBACK_ARBITER_ID = "arbiter_1";

/** The API answers 403 to a signed-in account that is not the arbiter. */
function isNotArbiter(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

export default function ArbiterPage() {
  const [tab, setTab] = useState<Tab>("Pending");
  const [notice, setNotice] = useState<string | null>(null);
  const wallet = useWallet();
  const arbiterId = wallet.address ?? FALLBACK_ARBITER_ID;
  const queryClient = useQueryClient();
  // Testnet mode before a wallet is connected: the API would refuse the list,
  // so ask for the wallet instead of loading. Nothing loads until the mode is known.
  const gate = useWalletGate();
  const walletMissing = gate === "missing";

  const filter = tab === "All" ? undefined : { ruling: tab };
  const queryKey = ["arbiter", "disputes", tab] as const;

  const disputesQuery = useQuery({
    queryKey,
    queryFn: () => arbiterApi.listDisputes(filter),
    // The API's refusal of a non-arbiter account is final for this session:
    // stop polling. Switching accounts signs out and re-enables the query.
    refetchInterval: (query) => (isNotArbiter(query.state.error) ? false : 3_000),
    enabled: gate === "ready",
  });
  const notArbiter = isNotArbiter(disputesQuery.error);

  const chain = useChainCalls();
  const ruleMutation = useMutation({
    mutationFn: async (input: {
      disputeId: string;
      ruling: "ForAuditor" | "AgainstAuditor";
      contractId?: string;
      findingId: string;
    }) => {
      // On-chain the arbiter rules first (unfreezing or slashing), then the API records it.
      if (chain) {
        if (!input.contractId) throw new Error("This dispute's finding is not loaded yet.");
        await chain.rule(input.contractId, input.findingId, input.ruling === "ForAuditor");
      }
      return arbiterApi.ruleOnDispute(input.disputeId, { arbiterId, ruling: input.ruling });
    },
    onSuccess: () => {
      setNotice(null);
      void queryClient.invalidateQueries({ queryKey: ["arbiter", "disputes"] });
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        setNotice("Someone else already ruled on this dispute. Refreshing the list.");
      } else {
        setNotice(err instanceof Error ? err.message : "Failed to submit ruling.");
      }
      void queryClient.invalidateQueries({ queryKey: ["arbiter", "disputes"] });
    },
  });

  function handleRule(disputeId: string, ruling: "ForAuditor" | "AgainstAuditor") {
    const verb =
      ruling === "ForAuditor"
        ? "FOR the auditor (pays out)"
        : "AGAINST the auditor (rejects + slashes stake)";
    const confirmed = window.confirm(
      `Rule ${verb} on dispute ${disputeId}? This cannot be undone.`,
    );
    if (!confirmed) return;
    const dispute = disputesQuery.data?.find((d) => d.id === disputeId);
    ruleMutation.mutate({
      disputeId,
      ruling,
      findingId: dispute?.findingId ?? "",
      contractId: dispute?.finding?.contractId,
    });
  }

  const disputes = disputesQuery.data ?? [];

  return (
    <div>
      <p className="eyebrow">ARBITER WORKSPACE</p>
      <h1 className="text-2xl font-semibold text-white">Open disputes</h1>
      <p className="mt-2 text-slate-400">
        Review the developer&apos;s challenge against the auditor&apos;s original finding and
        sandbox-verified PoC, then rule for or against the auditor.
      </p>

      <div className="mt-6 flex flex-wrap gap-1 rounded-full border border-slate-700 bg-slate-900 p-1 w-fit">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            aria-pressed={tab === t.id}
            className={`rounded-full px-3 py-1 text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-emerald-500 text-slate-950"
                : "text-slate-300 hover:bg-slate-800 hover:text-white"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {notice ? (
        <div className="mt-4 rounded-md border border-amber-700 bg-amber-900/30 px-4 py-2 text-sm text-amber-200">
          {notice}
        </div>
      ) : null}

      <div className="mt-6 space-y-4">
        {walletMissing ? (
          <p className="text-slate-400">Connect your wallet to see disputes.</p>
        ) : null}

        {disputesQuery.isLoading ? <p className="text-slate-400">Loading disputes…</p> : null}

        {gate === "ready" && notArbiter ? (
          <p className="text-slate-400">Only the arbiter can view and rule on disputes.</p>
        ) : null}

        {gate === "ready" && disputesQuery.isError && !notArbiter ? (
          <p className="text-red-400">Failed to load disputes.</p>
        ) : null}

        {gate === "ready" && !disputesQuery.isLoading && !disputesQuery.isError && disputes.length === 0 ? (
          <p className="text-slate-400">
            {tab === "Pending" ? "No open disputes right now." : "No disputes match this filter."}
          </p>
        ) : null}

        {(gate === "ready" ? disputes : []).map((dispute) => (
          <DisputeCard
            key={dispute.id}
            dispute={dispute}
            onRule={(ruling) => handleRule(dispute.id, ruling)}
            isRuling={ruleMutation.isPending && ruleMutation.variables?.disputeId === dispute.id}
          />
        ))}
      </div>
    </div>
  );
}
