"use client";

import { useAuditorId } from "@/lib/chain/use-chain";
import { ProfileSummary } from "./_components/ProfileSummary";
import { QueueList } from "./_components/QueueList";

export default function AuditorPage() {
  const auditorId = useAuditorId();
  return (
    <div className="flex flex-col gap-8">
      <div>
        <p className="eyebrow">AUDITOR WORKSPACE</p>
        <h1 className="text-2xl font-semibold text-white">Audit queue</h1>
        <p className="mt-2 text-slate-400">
          Find your next review. Claim a contract, prove the exploit, and earn the bounty.
        </p>
      </div>

      {auditorId ? (
        <>
          <ProfileSummary auditorId={auditorId} />
          <QueueList auditorId={auditorId} />
        </>
      ) : (
        // Testnet mode before a wallet is connected: the account is the auditor.
        <p className="text-slate-400">Connect your wallet to see your auditor profile and the queue.</p>
      )}
    </div>
  );
}
