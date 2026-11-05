"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DEVELOPER_NOTE_MAX_LENGTH, type Finding } from "@bbm/shared";
import { developerApi, ApiError } from "@/lib/api";

/**
 * R16: the developer's own note on a finding. Only the developer edits it;
 * the claiming auditor and the arbiter see it read-only (DeveloperNoteView).
 */
export function FindingNoteEditor({
  finding,
  developerAddress,
}: {
  finding: Finding;
  developerAddress: string;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const mutation = useMutation({
    mutationFn: (note: string | null) =>
      developerApi.setFindingNote(finding.id, { developerId: developerAddress, note }),
    // The page polls findings; a list fetched before the save must not land
    // after it and show the old note.
    onMutate: () => queryClient.cancelQueries({ queryKey: ["findings", finding.contractId] }),
    onSuccess: (updated) => {
      setEditing(false);
      // Show the saved note at once, then refetch the list behind it.
      queryClient.setQueryData<Finding[]>(["findings", finding.contractId], (current) =>
        current?.map((f) => (f.id === updated.id ? updated : f)),
      );
      void queryClient.invalidateQueries({ queryKey: ["findings", finding.contractId] });
    },
  });

  const error =
    mutation.error instanceof ApiError
      ? mutation.error.message
      : mutation.error
        ? "Could not save the note. Try again."
        : null;

  const startEditing = () => {
    mutation.reset();
    setDraft(finding.developerNote ?? "");
    setEditing(true);
  };

  if (!editing) {
    return (
      <div className="mt-4 rounded-md border border-slate-800 bg-slate-950/50 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-slate-300">
            Your note
            {finding.developerNoteUpdatedAt && (
              <span className="font-normal text-slate-500">
                {" "}
                · saved {new Date(finding.developerNoteUpdatedAt).toLocaleString()}
              </span>
            )}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={startEditing}
              className="text-xs font-medium text-emerald-400 hover:text-emerald-300"
            >
              {finding.developerNote ? "Edit note" : "Add a note"}
            </button>
            {finding.developerNote && (
              <button
                type="button"
                disabled={mutation.isPending}
                onClick={() => mutation.mutate(null)}
                className="text-xs font-medium text-slate-400 hover:text-slate-200 disabled:opacity-50"
              >
                Clear note
              </button>
            )}
          </div>
        </div>
        {finding.developerNote ? (
          <p className="mt-1 whitespace-pre-line text-sm text-slate-300">{finding.developerNote}</p>
        ) : (
          <p className="mt-1 text-xs text-slate-500">
            No note yet. Notes are shown read-only to the claiming auditor and the arbiter.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-400">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      aria-label="Edit note"
      className="mt-4 space-y-2 rounded-md border border-slate-800 bg-slate-950/50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate(draft);
      }}
    >
      <label className="flex flex-col gap-1 text-xs font-semibold text-slate-300">
        Your note
        <textarea
          value={draft}
          rows={3}
          maxLength={DEVELOPER_NOTE_MAX_LENGTH}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="E.g. known issue, fixed in v2; or why you think this is a false positive."
          className="block w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm font-normal text-white"
        />
      </label>
      <p className="text-xs text-slate-500">
        {draft.length} / {DEVELOPER_NOTE_MAX_LENGTH} · visible to the claiming auditor and the
        arbiter. Saving an empty note clears it.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-60"
        >
          {mutation.isPending ? "Saving..." : "Save note"}
        </button>
        <button
          type="button"
          onClick={() => {
            mutation.reset();
            setEditing(false);
          }}
          className="rounded-md border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
