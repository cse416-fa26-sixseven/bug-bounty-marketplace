import { z } from "zod";
import { IdSchema, TimestampSchema } from "./common";
import { FindingSchema } from "./finding";

export const SandboxStatusSchema = z.enum(["Pending", "Passed", "Failed"]);
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

export const PoCSubmissionSchema = z.object({
  id: IdSchema,
  findingId: IdSchema,
  auditorId: IdSchema,
  /** Reference to the submitted Foundry `.t.sol` test (storage key or URI). */
  testFileReference: z.string().min(1),
  submittedAt: TimestampSchema,
  sandboxStatus: SandboxStatusSchema,
  /** Populated once the sandbox has run; null while Pending. */
  sandboxLog: z.string().nullable().default(null),
});
export type PoCSubmission = z.infer<typeof PoCSubmissionSchema>;

/** 201 body of POST /api/auditor/findings: the auditor-reported finding
 * (already Submitted) and the PoC queued against it. */
export const AuditorFindingReportSchema = z.object({
  finding: FindingSchema,
  poc: PoCSubmissionSchema,
});
export type AuditorFindingReport = z.infer<typeof AuditorFindingReportSchema>;

/** Upper bound on an uploaded PoC test file, in bytes. The API enforces it;
 * keep the web form in sync through this constant. */
export const POC_SOURCE_MAX_BYTES = 102_400; // 100 KB

/** PoCs are Foundry test files. */
export const PocSourceFilenameSchema = z
  .string()
  .min(1)
  .regex(/\.t\.sol$/i, { error: "Filename must end in .t.sol" });

/** Size check for an uploaded PoC file, applied to its byte length. */
export const PocSourceSizeSchema = z
  .number()
  .int()
  .min(1, { error: "PoC file must not be empty" })
  .max(POC_SOURCE_MAX_BYTES, { error: "PoC file exceeds the 100 KB limit" });
