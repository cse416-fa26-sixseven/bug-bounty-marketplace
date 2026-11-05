"use client";

import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Finding } from "@bbm/shared";
import { auditorApi, ApiError } from "@/lib/api";
import { isOnChain, useChainInfo } from "@/lib/chain/config";

const SEVERITY_STYLES: Record<Finding["severity"], string> = {
  Critical: "bg-red-500/20 text-red-400",
  High: "bg-orange-500/20 text-orange-400",
  Medium: "bg-amber-500/20 text-amber-400",
  Low: "bg-sky-500/20 text-sky-400",
  Informational: "bg-slate-500/20 text-slate-300",
};

const STATUS_STYLES: Record<Finding["status"], string> = {
  Flagged: "bg-slate-700 text-slate-200",
  Submitted: "bg-sky-500/20 text-sky-400",
  Verified: "bg-emerald-500/20 text-emerald-400",
  Disputed: "bg-amber-500/20 text-amber-400",
  Rejected: "bg-red-500/20 text-red-400",
  Paid: "bg-emerald-500/30 text-emerald-300",
};

function lastChangedAt(finding: Finding): string | null {
  const last = finding.statusHistory[finding.statusHistory.length - 1];
  return last ? last.changedAt : null;
}

export function FindingCard({
  finding,
  auditorId,
  stakeMet,
  onChanged,
}: {
  finding: Finding;
  auditorId: string;
  stakeMet: boolean;
  onChanged: () => void;
}) {
  const onChain = isOnChain(useChainInfo());
  const [file, setFile] = useState<File | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const [fileError, setFileError] = useState<string | null>(null);

  const submitPocMutation = useMutation({
    mutationFn: () => {
      if (!file) throw new Error("No file selected");
      return auditorApi.submitPoc({ findingId: finding.id, auditorId, file });
    },
    onSuccess: () => {
      setFile(null);
      setFileError(null);
      onChanged();
    },
    onError: (err) => {
      setFileError(err instanceof ApiError ? err.message : "Failed to submit PoC.");
    },
  });

  const falsePositiveMutation = useMutation({
    mutationFn: () => auditorApi.markFalsePositive(finding.id, { auditorId }),
    onSuccess: onChanged,
  });

  const changedAt = lastChangedAt(finding);
  const ownsClaim =
    finding.claimedByAuditorId === auditorId &&
    !!finding.claimExpiresAt &&
    new Date(finding.claimExpiresAt).getTime() > now;
  const canActOnFinding = finding.status === "Flagged" && ownsClaim;
  const canUploadPoc = canActOnFinding && stakeMet;

  return (
    <li className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${SEVERITY_STYLES[finding.severity]}`}
        >
          {finding.severity}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_STYLES[finding.status]}`}
        >
          {finding.status}
        </span>
        <span className="text-xs text-slate-500">{finding.slitherDetector}</span>
        {changedAt && (
          <span className="ml-auto text-xs text-slate-500">
            updated {new Date(changedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      <p className="mt-2 text-sm text-slate-300">{finding.llmExplanation}</p>
      <details className="mt-4 text-xs text-slate-400">
        <summary className="text-emerald-300">Finding status history</summary>
        <ol className="mt-3 space-y-2">
          {finding.statusHistory.map((event, index) => (
            <li key={index}>
              {event.status} · {new Date(event.changedAt).toLocaleString()}
            </li>
          ))}
        </ol>
      </details>
      {!ownsClaim && finding.status === "Flagged" && (
        <p className="mt-3 text-sm text-amber-300">
          An active claim is required to review this finding.
        </p>
      )}
      {finding.status === "Verified" && (
        <p className="mt-3 text-sm text-emerald-300">
          {onChain
            ? "Exploit reproduced in the Foundry sandbox. The bounty is paid on-chain once the challenge window closes."
            : "Exploit verified in the demo sandbox. Awaiting the challenge window before payout."}
        </p>
      )}
      {finding.status === "Paid" && (
        <p className="mt-3 text-sm text-emerald-300">
          {onChain
            ? "Bounty paid on-chain. Withdraw it from your profile."
            : "Demo bounty paid. This finding has completed the review lifecycle."}
        </p>
      )}

      {finding.isFalsePositive && (
        <p className="mt-2 text-xs italic text-slate-500">Marked false positive by auditor.</p>
      )}

      {finding.status === "Submitted" && (
        <p className="mt-3 text-sm text-sky-400">PoC submitted - awaiting sandbox result...</p>
      )}

      {canActOnFinding && (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-3">
          <button
            type="button"
            onClick={() => falsePositiveMutation.mutate()}
            disabled={falsePositiveMutation.isPending}
            className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-50"
          >
            {falsePositiveMutation.isPending ? "Marking..." : "Mark false positive"}
          </button>

          {canUploadPoc ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!file) {
                  setFileError("Choose a .t.sol file first.");
                  return;
                }
                if (!file.name.endsWith(".t.sol")) {
                  setFileError("PoC file must be a Foundry test (filename ending in .t.sol).");
                  return;
                }
                if (file.size === 0 || file.size > 102_400) {
                  setFileError("Choose a nonempty PoC file up to 100 KB.");
                  return;
                }
                setFileError(null);
                submitPocMutation.mutate();
              }}
            >
              <input
                type="file"
                accept=".sol"
                aria-label="PoC test file"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setFileError(null);
                }}
                className="text-sm text-slate-300 file:mr-2 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-slate-200"
              />
              <button
                type="submit"
                disabled={submitPocMutation.isPending}
                className="rounded bg-emerald-500 px-3 py-1 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
              >
                {submitPocMutation.isPending ? "Submitting..." : "Submit PoC"}
              </button>
            </form>
          ) : (
            <span className="text-xs text-slate-500">
              Post the required stake to unlock PoC submission.
            </span>
          )}
        </div>
      )}

      {fileError && <p className="mt-2 text-sm text-red-400">{fileError}</p>}
      {falsePositiveMutation.isError && (
        <p role="alert" className="mt-2 text-sm text-red-400">
          Could not mark this finding as a false positive. Try again.
        </p>
      )}
    </li>
  );
}
