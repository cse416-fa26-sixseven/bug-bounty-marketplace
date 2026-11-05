import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common";

/**
 * - Flagged: raised by Slither + explained by the LLM, not yet claimed.
 * - Submitted: an auditor has claimed the contract and submitted a PoC
 *   against this finding; awaiting sandbox re-run.
 * - Verified: the sandbox successfully reproduced the PoC.
 * - Disputed: the developer opened a dispute during the challenge window.
 * - Rejected: sandbox failed to reproduce, or an auditor marked it a false
 *   positive, or a dispute ruled against the auditor.
 * - Paid: challenge window passed undisputed (or dispute ruled for the
 *   auditor) and escrow paid out.
 */
export const FindingStatusSchema = z.enum([
  "Flagged",
  "Submitted",
  "Verified",
  "Disputed",
  "Rejected",
  "Paid",
]);
export type FindingStatus = z.infer<typeof FindingStatusSchema>;

export const FindingSeveritySchema = z.enum([
  "Critical",
  "High",
  "Medium",
  "Low",
  "Informational",
]);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const FindingStatusHistoryEntrySchema = z.object({
  status: FindingStatusSchema,
  changedAt: TimestampSchema,
});
export type FindingStatusHistoryEntry = z.infer<typeof FindingStatusHistoryEntrySchema>;

/**
 * Where a finding came from.
 * - slither: raised by the analysis worker (Slither + LLM explanation).
 * - auditor: reported by the auditor holding the contract's claim, together
 *   with the PoC that proves it (POST /api/auditor/findings). It starts
 *   Submitted and runs the same sandbox → Verified/Rejected path.
 */
export const FindingSourceSchema = z.enum(["slither", "auditor"]);
export type FindingSource = z.infer<typeof FindingSourceSchema>;

/** `slitherDetector` of an auditor-reported finding: no detector raised it,
 * but the field stays non-empty so every existing consumer keeps working. */
export const AUDITOR_FINDING_DETECTOR = "auditor-reported";

export const AUDITOR_FINDING_TITLE_MAX_LENGTH = 120;
export const AUDITOR_FINDING_DESCRIPTION_MAX_LENGTH = 4000;

export const FindingSchema = z.object({
  id: IdSchema,
  contractId: IdSchema,
  severity: FindingSeveritySchema,
  /** Slither detector id, e.g. "reentrancy-eth". */
  slitherDetector: z.string().min(1),
  /** Reference to the raw Slither output for this finding (storage key or URI). */
  rawOutputReference: z.string().min(1),
  /** Plain-English explanation from the LLM (or Slither's own description if
   * the LLM was unavailable). Advisory only - never affects status or payout.
   * For an auditor-reported finding this holds the auditor's description. */
  llmExplanation: z.string().min(1),
  status: FindingStatusSchema,
  statusHistory: z.array(FindingStatusHistoryEntrySchema).default([]),
  /** Set while an auditor holds the exclusive claim on this finding's
   * contract; both null together outside of a claim window. */
  claimedByAuditorId: IdSchema.nullable().default(null),
  claimExpiresAt: TimestampSchema.nullable().default(null),
  /** Set by an auditor who reviewed the AI finding and judged it bogus. */
  isFalsePositive: z.boolean().default(false),
  /** Set when the finding becomes Verified; null otherwise. The developer
   * may dispute until this passes, after which escrow pays out if the
   * finding is still Verified (no dispute opened). */
  challengeWindowExpiresAt: TimestampSchema.nullable().default(null),
  /** Origin of the finding; see FindingSourceSchema. */
  source: FindingSourceSchema.default("slither"),
  /** Short title the reporting auditor gave the finding; null for Slither
   * findings. */
  title: z.string().min(1).nullable().default(null),
  /** The auditor who reported the finding; null for Slither findings. */
  reportedByAuditorId: IdSchema.nullable().default(null),
});
export type Finding = z.infer<typeof FindingSchema>;

/** Text fields of an auditor-reported finding (the PoC file travels with them
 * in the same multipart request). Plain text, trimmed. */
export const AuditorFindingFieldsSchema = z.object({
  contractId: IdSchema,
  title: z
    .string()
    .trim()
    .min(1, { error: "Title is required" })
    .max(AUDITOR_FINDING_TITLE_MAX_LENGTH, {
      error: `Title must be at most ${AUDITOR_FINDING_TITLE_MAX_LENGTH} characters`,
    })
    .refine(hasNoNul, { error: "Title must not contain NUL characters" }),
  severity: FindingSeveritySchema,
  description: z
    .string()
    .trim()
    .min(1, { error: "Description is required" })
    .max(AUDITOR_FINDING_DESCRIPTION_MAX_LENGTH, {
      error: `Description must be at most ${AUDITOR_FINDING_DESCRIPTION_MAX_LENGTH} characters`,
    })
    .refine(hasNoNul, { error: "Description must not contain NUL characters" }),
});

/** Postgres text and jsonb cannot hold U+0000. */
function hasNoNul(value: string): boolean {
  return !value.includes("\u0000");
}
export type AuditorFindingFields = z.infer<typeof AuditorFindingFieldsSchema>;
