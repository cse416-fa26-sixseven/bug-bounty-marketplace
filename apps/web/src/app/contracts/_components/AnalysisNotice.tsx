import React from "react";
import Link from "next/link";
import type { AnalysisStatus } from "@bbm/shared";

/** What the developer sees in place of findings while there are none: the
 * analysis is still running, it failed (with the compiler's message), it
 * finished clean, or its status can't be loaded. Status changes arrive by
 * polling, so the text sits in a live region. */
export function AnalysisNotice({
  status,
  unavailable = false,
}: {
  status: AnalysisStatus | undefined;
  /** The status request failed (e.g. no analysis was ever queued). */
  unavailable?: boolean;
}) {
  if (status?.status === "Failed") {
    return (
      <div role="alert" className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 p-3">
        <p className="text-sm font-medium text-red-300">Analysis failed</p>
        {status.error && (
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-red-200">
            {status.error}
          </pre>
        )}
        <p className="mt-2 text-sm text-red-200">
          This contract can't be funded or claimed. Fix the error and{" "}
          <Link href="/submit" className="font-medium text-emerald-300 underline">
            submit the fixed file
          </Link>
          .
        </p>
      </div>
    );
  }
  let message = "Analysis is still running - findings will appear here automatically once ready.";
  if (status?.status === "Done") {
    // The findings query polls separately; don't claim "no issues" while it catches up.
    message =
      status.findingCount === 0
        ? "Slither found no issues in this contract."
        : "Loading findings...";
  } else if (!status && unavailable) {
    message = "Analysis status unavailable. Findings will appear here once analysis runs.";
  }
  return (
    <p role="status" className="mt-3 text-sm text-slate-400">
      {message}
    </p>
  );
}
