"use client";

import type { ArbiterDisputeView } from "@/lib/api/arbiter";
import {
  FindingDescriptionNote,
  FindingOriginBadge,
  findingHeading,
} from "@/components/FindingOrigin";

const SEVERITY_STYLES: Record<string, string> = {
  Critical: "bg-red-500/20 text-red-300",
  High: "bg-orange-500/20 text-orange-300",
  Medium: "bg-amber-500/20 text-amber-300",
  Low: "bg-sky-500/20 text-sky-300",
  Informational: "bg-slate-500/20 text-slate-300",
};

const RULING_STYLES: Record<string, string> = {
  Pending: "bg-slate-700 text-slate-200",
  ForAuditor: "bg-emerald-500/20 text-emerald-300",
  AgainstAuditor: "bg-red-500/20 text-red-300",
};

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface DisputeCardProps {
  dispute: ArbiterDisputeView;
  onRule: (ruling: "ForAuditor" | "AgainstAuditor") => void;
  isRuling: boolean;
}

/**
 * One dispute's full case file: the developer's challenge on one side, the
 * auditor's evidence (the original finding + its sandbox-verified PoC) on
 * the other, and - while still Pending - the ruling action.
 *
 * There is no dedicated "auditor rebuttal" field in the data model; the PoC
 * submission's passing sandbox log *is* the auditor's evidence that the
 * exploit is real, so it's surfaced verbatim as a transcript.
 */
export function DisputeCard({ dispute, onRule, isRuling }: DisputeCardProps) {
  const { finding, pocSubmission } = dispute;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-white">Dispute {dispute.id}</h2>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            RULING_STYLES[dispute.ruling] ?? RULING_STYLES.Pending
          }`}
        >
          {dispute.ruling}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Finding {dispute.findingId} · opened {formatTimestamp(dispute.openedAt)} · challenge window
        expires {formatTimestamp(dispute.challengeWindowExpiresAt)}
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <section className="rounded-md border border-slate-800 bg-slate-950/50 p-4">
          <h3 className="text-sm font-semibold text-slate-200">Developer&apos;s challenge</h3>
          <p className="mt-2 text-sm text-slate-300">{dispute.reason}</p>
        </section>

        <section className="rounded-md border border-slate-800 bg-slate-950/50 p-4">
          <h3 className="text-sm font-semibold text-slate-200">Auditor&apos;s evidence</h3>
          {finding ? (
            <div className="mt-2 space-y-2 text-sm text-slate-300">
              <div className="flex items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    SEVERITY_STYLES[finding.severity] ?? SEVERITY_STYLES.Informational
                  }`}
                >
                  {finding.severity}
                </span>
                <span className="text-xs text-slate-500">{findingHeading(finding)}</span>
                <FindingOriginBadge finding={finding} />
              </div>
              <p className="whitespace-pre-line">{finding.llmExplanation}</p>
              <FindingDescriptionNote finding={finding} />
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-500">Finding not found.</p>
          )}

          {pocSubmission ? (
            <div className="mt-3 space-y-1">
              <p className="text-xs text-slate-500">
                PoC test file: <span className="text-slate-400">{pocSubmission.testFileReference}</span>{" "}
                · sandbox: <span className="text-slate-400">{pocSubmission.sandboxStatus}</span>
              </p>
              {pocSubmission.sandboxLog ? (
                <pre className="max-h-48 overflow-auto rounded bg-black/60 p-3 font-mono text-xs text-slate-300">
                  {pocSubmission.sandboxLog}
                </pre>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-slate-500">No PoC submission on record.</p>
          )}
        </section>
      </div>

      {dispute.ruling === "Pending" ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={isRuling}
            onClick={() => onRule("ForAuditor")}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Rule for auditor
          </button>
          <button
            type="button"
            disabled={isRuling}
            onClick={() => onRule("AgainstAuditor")}
            className="rounded-md bg-red-500/90 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Rule against auditor
          </button>
          {isRuling ? <span className="text-xs text-slate-500">Submitting ruling…</span> : null}
        </div>
      ) : (
        <p className="mt-4 text-xs text-slate-500">
          Ruled {dispute.ruledAt ? formatTimestamp(dispute.ruledAt) : ""} by{" "}
          {dispute.arbiterId ?? "unknown arbiter"}.
        </p>
      )}
    </div>
  );
}
