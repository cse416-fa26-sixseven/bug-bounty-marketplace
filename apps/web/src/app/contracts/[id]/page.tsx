"use client";

import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { developerApi, ApiError } from "@/lib/api";
import { AnalysisNotice } from "../_components/AnalysisNotice";
import { ContractActions } from "../_components/ContractActions";
import { FindingCard } from "../_components/FindingCard";
import { FundBounty } from "../_components/FundBounty";

const POLL_INTERVAL_MS = 2000;

const STATUS_STYLES: Record<string, string> = {
  Open: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40",
  Claimed: "bg-sky-500/20 text-sky-300 border-sky-500/40",
  Resolved: "bg-slate-500/20 text-slate-300 border-slate-500/40",
  Expired: "bg-red-500/20 text-red-300 border-red-500/40",
};

export default function ContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const contractQuery = useQuery({
    queryKey: ["contract", id],
    queryFn: () => developerApi.getContract(id),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const findingsQuery = useQuery({
    queryKey: ["findings", id],
    queryFn: () => developerApi.listFindings(id),
    refetchInterval: POLL_INTERVAL_MS,
  });

  const analysisQuery = useQuery({
    queryKey: ["analysis", id],
    queryFn: () => developerApi.getAnalysisStatus(id),
    // Stop polling once the analysis has finished either way.
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "Done" || status === "Failed" ? false : POLL_INTERVAL_MS;
    },
    retry: false,
  });

  if (contractQuery.isLoading) {
    return <p className="text-slate-400">Loading contract...</p>;
  }

  if (contractQuery.isError || !contractQuery.data) {
    const message =
      contractQuery.error instanceof ApiError ? contractQuery.error.message : "Contract not found.";
    return <p className="text-red-400">{message}</p>;
  }

  const contract = contractQuery.data;
  const findings = findingsQuery.data ?? [];
  return (
    <div>
      <Link href="/contracts" className="text-xs text-emerald-400 inline-block mb-5">
        ← Back to contracts
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white">{contract.filename}</h1>
          <p className="mt-1 text-sm text-slate-400">Contract {contract.id}</p>
        </div>
        <span
          className={`rounded-full border px-3 py-1 text-sm font-semibold ${
            STATUS_STYLES[contract.status] ?? "bg-slate-500/20 text-slate-300 border-slate-500/40"
          }`}
        >
          {contract.status}
        </span>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">Created</dt>
          <dd className="text-slate-200">{new Date(contract.createdAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Deadline</dt>
          <dd className="text-slate-200">{new Date(contract.deadline).toLocaleString()}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Developer</dt>
          <dd className="truncate text-slate-200">{contract.developerAddress}</dd>
        </div>
      </dl>

      <ContractActions contract={contract} findings={findings} />

      <FundBounty contract={contract} analysis={analysisQuery.data} />

      <h2 className="mt-10 text-lg font-semibold text-white">Findings</h2>
      {findingsQuery.isError ? (
        <p role="alert" className="text-red-400 mt-3">
          Could not load findings. Retrying automatically.
        </p>
      ) : findings.length === 0 ? (
        contract.status === "Expired" ? (
          <p className="mt-3 text-sm text-slate-400">
            This contract is closed. No findings are available.
          </p>
        ) : (
          <AnalysisNotice status={analysisQuery.data} unavailable={analysisQuery.isError} />
        )
      ) : (
        <div className="mt-4 space-y-4">
          {findings.map((finding) => (
            <FindingCard
              key={finding.id}
              finding={finding}
              developerAddress={contract.developerAddress}
            />
          ))}
        </div>
      )}
    </div>
  );
}
