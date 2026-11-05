"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { developerApi, auditorApi } from "@/lib/api";
import { useAuditorId, useRequiredStakeWei } from "@/lib/chain/use-chain";
import { ClaimCountdown } from "../../_components/ClaimCountdown";
import { REQUIRED_STAKE_WEI, StakeGate, isStakeMet } from "../../_components/StakeGate";
import { FindingCard } from "../../_components/FindingCard";
import { ReportFindingForm } from "../../_components/ReportFindingForm";

/** True while a finding is still awaiting an auditor action or sandbox
 * result - used to decide whether to keep polling. */
function isInFlight(status: string): boolean {
  return (
    status === "Flagged" || status === "Submitted" || status === "Verified" || status === "Disputed"
  );
}

export default function ClaimedContractPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: contractId } = use(params);
  const queryClient = useQueryClient();
  const auditorId = useAuditorId();
  const requiredStakeWei = useRequiredStakeWei(REQUIRED_STAKE_WEI);
  // Ticks so the report form hides once the claim lapses.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const contractQuery = useQuery({
    queryKey: ["contract", contractId],
    queryFn: () => developerApi.getContract(contractId),
    refetchInterval: 2_000,
  });

  const findingsQuery = useQuery({
    queryKey: ["contract-findings", contractId],
    queryFn: () => developerApi.listFindings(contractId),
    refetchInterval: (query) => {
      const findings = query.state.data ?? [];
      return findings.some((f) => isInFlight(f.status)) || findings.length === 0 ? 2_000 : false;
    },
  });

  const profileQuery = useQuery({
    queryKey: ["auditor-profile", auditorId],
    queryFn: () => auditorApi.getProfile(auditorId),
  });

  const refetchFindings = () =>
    void queryClient.invalidateQueries({ queryKey: ["contract-findings", contractId] });
  const refetchProfile = () =>
    void queryClient.invalidateQueries({ queryKey: ["auditor-profile", auditorId] });

  if (contractQuery.isLoading || findingsQuery.isLoading || profileQuery.isLoading) {
    return <p className="text-slate-400">Loading contract...</p>;
  }
  if (contractQuery.isError || !contractQuery.data) {
    return <p className="text-red-400">Failed to load this contract.</p>;
  }
  if (profileQuery.isError || !profileQuery.data) {
    return <p className="text-red-400">Failed to load auditor profile.</p>;
  }
  if (findingsQuery.isError) {
    return (
      <div role="alert">
        <p className="text-red-400">Failed to load findings.</p>
        <button className="button-secondary mt-4" onClick={() => void findingsQuery.refetch()}>
          Try again
        </button>
      </div>
    );
  }

  const contract = contractQuery.data;
  const findings = findingsQuery.data ?? [];
  const profile = profileQuery.data;
  const stakeMet = isStakeMet(profile.stake, requiredStakeWei);

  // claimExpiresAt is set per-finding at claim time (see
  // mocks/db/auditors.ts's claimContract) rather than on the contract
  // itself; every finding on a given claimed contract shares the same
  // value, so the first one is representative.
  const claimExpiresAt = findings.find((f) => f.claimExpiresAt)?.claimExpiresAt ?? null;
  const ownsClaim =
    contract.status === "Claimed" &&
    findings.some(
      (f) =>
        f.claimedByAuditorId === auditorId &&
        !!f.claimExpiresAt &&
        new Date(f.claimExpiresAt).getTime() > now,
    );

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/auditor" className="text-sm text-emerald-400 hover:underline">
          Back to queue
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-white">{contract.filename}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-slate-400">
          <span>Status: {contract.status}</span>
          <span>Deadline: {new Date(contract.deadline).toLocaleDateString()}</span>
          {claimExpiresAt ? (
            <span>
              Claim expires in <ClaimCountdown expiresAt={claimExpiresAt} />
            </span>
          ) : (
            <span className="italic text-slate-500">Analysis still running...</span>
          )}
        </div>
      </div>

      <StakeGate profile={profile} auditorId={auditorId} onStaked={refetchProfile} />

      {ownsClaim && stakeMet && (
        <ReportFindingForm
          contractId={contractId}
          auditorId={auditorId}
          onReported={refetchFindings}
        />
      )}

      <section>
        <h2 className="text-xl font-semibold text-white">Findings</h2>
        {findings.length === 0 ? (
          <p className="mt-3 text-slate-400">
            No findings yet - the analysis pipeline is still running.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-3">
            {findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                auditorId={auditorId}
                stakeMet={stakeMet}
                onChanged={refetchFindings}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
