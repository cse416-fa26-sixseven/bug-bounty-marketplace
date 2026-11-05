import type { Finding } from "@bbm/shared";

/** True for a finding an auditor reported with a PoC (not raised by Slither). */
export function isAuditorReported(finding: Pick<Finding, "source">): boolean {
  return finding.source === "auditor";
}

/** Short heading for a finding: the auditor's title, or the Slither detector. */
export function findingHeading(
  finding: Pick<Finding, "source" | "title" | "slitherDetector">,
): string {
  return isAuditorReported(finding) && finding.title ? finding.title : finding.slitherDetector;
}

/** Labels where a finding came from, so auditor reports are never mistaken
 * for AI output. */
export function FindingOriginBadge({ finding }: { finding: Pick<Finding, "source"> }) {
  return isAuditorReported(finding) ? (
    <span className="rounded-full border border-violet-500/40 bg-violet-500/15 px-2 py-0.5 text-xs font-semibold text-violet-300">
      Auditor-reported
    </span>
  ) : (
    <span className="rounded-full border border-slate-600 px-2 py-0.5 text-xs text-slate-400">
      Slither + AI
    </span>
  );
}

/** The provenance line under a finding's description. */
export function FindingDescriptionNote({
  finding,
}: {
  finding: Pick<Finding, "source" | "reportedByAuditorId">;
}) {
  return (
    <p className="mt-2 text-xs text-slate-500">
      {isAuditorReported(finding)
        ? `Auditor's description · reported by ${finding.reportedByAuditorId ?? "the claiming auditor"} with a PoC`
        : "AI explanation · advisory only"}
    </p>
  );
}
