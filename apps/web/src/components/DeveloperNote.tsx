import type { Finding } from "@bbm/shared";

/** Read-only view of the developer's note on a finding, for the claiming
 * auditor and the arbiter. Renders nothing when there is no note. */
export function DeveloperNoteView({
  finding,
}: {
  finding: Pick<Finding, "developerNote" | "developerNoteUpdatedAt">;
}) {
  if (!finding.developerNote) return null;
  return (
    <div className="mt-3 rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
      <p className="text-xs font-semibold text-sky-300">
        Developer&apos;s note
        {finding.developerNoteUpdatedAt && (
          <span className="font-normal text-slate-500">
            {" "}
            · {new Date(finding.developerNoteUpdatedAt).toLocaleString()}
          </span>
        )}
      </p>
      <p className="mt-1 whitespace-pre-line text-sm text-slate-300">{finding.developerNote}</p>
    </div>
  );
}
