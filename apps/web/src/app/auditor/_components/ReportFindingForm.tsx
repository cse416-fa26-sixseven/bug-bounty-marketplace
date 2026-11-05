"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AUDITOR_FINDING_DESCRIPTION_MAX_LENGTH,
  AUDITOR_FINDING_TITLE_MAX_LENGTH,
  AuditorFindingFieldsSchema,
  FindingSeveritySchema,
  POC_SOURCE_MAX_BYTES,
  type FindingSeverity,
} from "@bbm/shared";
import { auditorApi, ApiError } from "@/lib/api";

/**
 * US5, second half: the auditor holding the claim reports a vulnerability
 * Slither did not flag, with the Foundry PoC that proves it. The finding is
 * created Submitted and the sandbox verifies it like any other PoC.
 */
export function ReportFindingForm({
  contractId,
  auditorId,
  onReported,
}: {
  contractId: string;
  auditorId: string;
  onReported: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState<FindingSeverity>("High");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setSeverity("High");
    setDescription("");
    setFile(null);
    setError(null);
  };

  const mutation = useMutation({
    mutationFn: (input: { title: string; description: string; file: File }) =>
      auditorApi.reportFinding({ contractId, auditorId, severity, ...input }),
    onSuccess: () => {
      reset();
      setOpen(false);
      onReported();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Failed to report the finding.");
    },
  });

  if (!open) {
    return (
      <button type="button" className="button-secondary self-start" onClick={() => setOpen(true)}>
        Report a new finding
      </button>
    );
  }

  return (
    <form
      aria-label="Report a new finding"
      className="flex flex-col gap-3 rounded-lg border border-violet-500/40 bg-slate-900 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const fields = AuditorFindingFieldsSchema.safeParse({
          contractId,
          title,
          severity,
          description,
        });
        if (!fields.success) {
          setError(fields.error.issues[0]?.message ?? "Check the report fields.");
          return;
        }
        if (!file || !file.name.endsWith(".t.sol")) {
          setError("Attach a Foundry PoC test (filename ending in .t.sol).");
          return;
        }
        if (file.size === 0 || file.size > POC_SOURCE_MAX_BYTES) {
          setError("Choose a nonempty PoC file up to 100 KB.");
          return;
        }
        setError(null);
        mutation.mutate({ title: fields.data.title, description: fields.data.description, file });
      }}
    >
      <div>
        <h3 className="text-sm font-semibold text-white">Report a new finding</h3>
        <p className="mt-1 text-xs text-slate-400">
          For a vulnerability the AI analysis missed. Your PoC is re-run in the sandbox; the finding
          is paid like any other once it is verified.
        </p>
      </div>
      <label className="flex flex-col gap-1 text-sm text-slate-300">
        Title
        <input
          value={title}
          maxLength={AUDITOR_FINDING_TITLE_MAX_LENGTH}
          onChange={(e) => setTitle(e.target.value)}
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-white"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-300">
        Severity
        <select
          value={severity}
          onChange={(e) => setSeverity(FindingSeveritySchema.parse(e.target.value))}
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-white"
        >
          {FindingSeveritySchema.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-300">
        Description
        <textarea
          value={description}
          rows={4}
          maxLength={AUDITOR_FINDING_DESCRIPTION_MAX_LENGTH}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What is vulnerable, how the PoC exploits it, and the impact."
          className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-white"
        />
        <span className="text-xs text-slate-500">
          {description.length} / {AUDITOR_FINDING_DESCRIPTION_MAX_LENGTH}
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm text-slate-300">
        PoC test file
        <input
          type="file"
          accept=".sol"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
          }}
          className="text-sm text-slate-300 file:mr-2 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-slate-200"
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded bg-emerald-500 px-3 py-1 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {mutation.isPending ? "Submitting..." : "Submit finding and PoC"}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:border-slate-500"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
