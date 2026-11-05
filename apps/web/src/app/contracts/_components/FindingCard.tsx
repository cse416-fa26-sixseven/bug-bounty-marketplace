"use client";

import React, { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Finding, FindingSeverity } from "@bbm/shared";
import { developerApi } from "@/lib/api";
import { useChainCalls } from "@/lib/chain/use-chain";
import {
  FindingDescriptionNote,
  FindingOriginBadge,
  findingHeading,
  isAuditorReported,
} from "@/components/FindingOrigin";
import { FindingNoteEditor } from "./FindingNoteEditor";

const SEVERITY_STYLES: Record<FindingSeverity, string> = {
  Critical: "bg-red-500/20 text-red-300 border-red-500/40",
  High: "bg-orange-500/20 text-orange-300 border-orange-500/40",
  Medium: "bg-yellow-500/20 text-yellow-300 border-yellow-500/40",
  Low: "bg-blue-500/20 text-blue-300 border-blue-500/40",
  Informational: "bg-slate-500/20 text-slate-300 border-slate-500/40",
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

function lastChangedAt(finding: Finding): string | null {
  const last = finding.statusHistory[finding.statusHistory.length - 1];
  return last ? last.changedAt : null;
}

/** Live "mm:ss remaining" countdown against a future ISO timestamp, ticking
 * every second. Returns null once the deadline has passed. */
function useCountdown(expiresAt: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  if (!expiresAt) return null;
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (remainingMs <= 0) return null;
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

interface FindingCardProps {
  finding: Finding;
  developerAddress: string;
}

export function FindingCard({ finding, developerAddress }: FindingCardProps) {
  const queryClient = useQueryClient();
  const [showRaw, setShowRaw] = useState(false);
  const [showDisputeForm, setShowDisputeForm] = useState(false);
  const [reason, setReason] = useState("");

  const remaining = useCountdown(finding.challengeWindowExpiresAt);
  const canDispute = finding.status === "Verified" && remaining !== null;

  const chain = useChainCalls();
  const disputeMutation = useMutation({
    mutationFn: async () => {
      // On-chain the developer opens the dispute (freezing the payout) first.
      if (chain) await chain.openDispute(finding.contractId, finding.id, reason);
      return developerApi.disputeFinding(finding.id, { developerId: developerAddress, reason });
    },
    onSuccess: () => {
      setShowDisputeForm(false);
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["findings", finding.contractId] });
    },
  });

  const disputeError =
    disputeMutation.error instanceof Error ? disputeMutation.error.message : null;

  const changedAt = lastChangedAt(finding);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${SEVERITY_STYLES[finding.severity]}`}
          >
            {finding.severity}
          </span>
          <span className="text-sm font-medium text-slate-200">{findingHeading(finding)}</span>
          <FindingOriginBadge finding={finding} />
        </div>
        <div className="text-xs text-slate-400">
          Status: <span className="font-semibold text-slate-200">{finding.status}</span>
          {changedAt && <span> · last changed {formatTimestamp(changedAt)}</span>}
        </div>
      </div>

      <p className="mt-3 whitespace-pre-line text-sm text-slate-300">{finding.llmExplanation}</p>
      <FindingDescriptionNote finding={finding} />
      <FindingNoteEditor finding={finding} developerAddress={developerAddress} />
      <details className="mt-4 text-xs text-slate-400">
        <summary className="text-emerald-300">Finding status history</summary>
        <ol className="mt-3 space-y-2">
          {finding.statusHistory.map((event, index) => (
            <li key={index}>
              {event.status} · {formatTimestamp(event.changedAt)}
            </li>
          ))}
        </ol>
      </details>

      {/* Auditor reports have no Slither output: their description is above. */}
      {!isAuditorReported(finding) && (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => setShowRaw((v) => !v)}
            className="text-xs font-medium text-emerald-400 hover:text-emerald-300"
          >
            {showRaw ? "Hide raw Slither output" : "Show raw Slither output"}
          </button>
          {showRaw &&
            (finding.rawOutputReference.startsWith("/api/") ? (
              <a
                href={finding.rawOutputReference}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block text-xs text-emerald-400 underline hover:text-emerald-300"
              >
                Open raw Slither JSON<span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <div>
                <p className="mt-2 text-xs text-slate-500">
                  Output reference only. Full Slither output requires the analysis service
                  integration.
                </p>
                <pre className="mt-2 overflow-x-auto rounded-md bg-slate-950 p-3 text-xs text-slate-400">
                  {finding.rawOutputReference}
                </pre>
              </div>
            ))}
        </div>
      )}

      {canDispute && (
        <div className="mt-4 border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-400">
            Challenge window closes in{" "}
            <span className="font-semibold text-amber-400">{remaining}</span>
          </p>
          {!showDisputeForm ? (
            <button
              type="button"
              onClick={() => setShowDisputeForm(true)}
              className="mt-2 rounded-md border border-amber-500/60 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/10"
            >
              Dispute this finding
            </button>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                disputeMutation.mutate();
              }}
              className="mt-2 space-y-2"
            >
              <textarea
                aria-label="Reason for dispute"
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why do you think this finding shouldn't be paid out?"
                className="block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
                rows={3}
              />
              {disputeError && <p className="text-sm text-red-400">{disputeError}</p>}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={disputeMutation.isPending || !reason.trim()}
                  className="rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-slate-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {disputeMutation.isPending ? "Submitting..." : "Submit dispute"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowDisputeForm(false)}
                  className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
