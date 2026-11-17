import { describe, expect, it } from "vitest";
import {
  AddressSchema,
  AuditorFindingReportSchema,
  DisputeRulingSchema,
  FindingSeveritySchema,
  FindingSourceSchema,
  FindingStatusHistoryEntrySchema,
  IdSchema,
  SandboxStatusSchema,
  TimestampSchema,
} from "../index";

const now = "2026-09-30T12:00:00.000Z";

describe("TimestampSchema", () => {
  it.each([now, "2026-09-30T12:00:00Z", "2026-09-30T12:00:00.123456Z"])("accepts %s", (value) => {
    expect(TimestampSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["a date only", "2026-09-30"],
    ["a non-UTC offset", "2026-09-30T12:00:00+02:00"],
    ["no seconds or zone", "2026-09-30T12:00"],
    ["free text", "yesterday"],
    ["an empty string", ""],
    ["epoch millis", 1_759_233_600_000],
    ["a Date object", new Date(now)],
    ["null", null],
  ])("rejects %s", (_label, value) => {
    expect(TimestampSchema.safeParse(value).success).toBe(false);
  });
});

describe("AddressSchema", () => {
  it.each([
    "0x1234567890123456789012345678901234567890",
    "0xABCDEFabcdef0123456789ABCDEFabcdef012345",
    "0x0000000000000000000000000000000000000000",
  ])("accepts %s", (value) => {
    expect(AddressSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["no 0x prefix", "1234567890123456789012345678901234567890"],
    ["39 hex chars", `0x${"1".repeat(39)}`],
    ["41 hex chars", `0x${"1".repeat(41)}`],
    ["a non-hex char", `0x${"g".repeat(40)}`],
    ["an uppercase 0X prefix", `0X${"1".repeat(40)}`],
    ["surrounding whitespace", ` 0x${"1".repeat(40)} `],
    ["an empty string", ""],
    ["a number", 123],
  ])("rejects %s", (_label, value) => {
    expect(AddressSchema.safeParse(value).success).toBe(false);
  });

  it("explains the expected format", () => {
    const result = AddressSchema.safeParse("0x123");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "Must be a valid 0x-prefixed 40 hex character address",
    );
  });
});

describe("IdSchema", () => {
  it.each(["contract_1", "x", "550e8400-e29b-41d4-a716-446655440000"])("accepts %s", (value) => {
    expect(IdSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["a number", 1],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(IdSchema.safeParse(value).success).toBe(false);
  });
});

describe("enum schemas", () => {
  it.each([
    [DisputeRulingSchema, ["Pending", "ForAuditor", "AgainstAuditor"]],
    [SandboxStatusSchema, ["Pending", "Passed", "Failed"]],
    [FindingSeveritySchema, ["Critical", "High", "Medium", "Low", "Informational"]],
    [FindingSourceSchema, ["slither", "auditor"]],
  ] as const)("accepts exactly the listed values (%#)", (schema, values) => {
    expect(schema.options).toEqual(values);
    for (const value of values) expect(schema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["DisputeRuling", DisputeRulingSchema, ["pending", "Ruled", "ForDeveloper", ""]],
    ["SandboxStatus", SandboxStatusSchema, ["passed", "Running", "Verified", ""]],
    ["FindingSeverity", FindingSeveritySchema, ["critical", "Info", "Severe", ""]],
    ["FindingSource", FindingSourceSchema, ["Slither", "llm", "developer", ""]],
  ] as const)("%s rejects unknown or mis-cased values", (_name, schema, values) => {
    for (const value of values) expect(schema.safeParse(value).success).toBe(false);
    expect(schema.safeParse(undefined).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
  });
});

describe("FindingStatusHistoryEntrySchema", () => {
  it("accepts a status with an ISO timestamp", () => {
    expect(FindingStatusHistoryEntrySchema.parse({ status: "Verified", changedAt: now })).toEqual({
      status: "Verified",
      changedAt: now,
    });
  });

  it.each([
    ["an unknown status", { status: "Closed", changedAt: now }],
    ["a missing status", { changedAt: now }],
    ["a missing changedAt", { status: "Flagged" }],
    ["a non-ISO changedAt", { status: "Flagged", changedAt: "30/09/2026" }],
  ])("rejects %s", (_label, value) => {
    expect(FindingStatusHistoryEntrySchema.safeParse(value).success).toBe(false);
  });
});

describe("AuditorFindingReportSchema", () => {
  const finding = {
    id: "finding_1",
    contractId: "contract_1",
    severity: "High",
    slitherDetector: "auditor-reported",
    rawOutputReference: "auditor://finding_1",
    llmExplanation: "sweep() has no access control.",
    status: "Submitted",
    statusHistory: [{ status: "Submitted", changedAt: now }],
    source: "auditor",
    title: "Unprotected sweep()",
    reportedByAuditorId: "auditor_1",
  };
  const poc = {
    id: "poc_1",
    findingId: "finding_1",
    auditorId: "auditor_1",
    testFileReference: "pocs/finding_1/Exploit.t.sol",
    submittedAt: now,
    sandboxStatus: "Pending",
  };

  it("accepts a finding with its queued PoC and fills the defaults", () => {
    const parsed = AuditorFindingReportSchema.parse({ finding, poc });
    expect(parsed.finding).toMatchObject({
      source: "auditor",
      claimedByAuditorId: null,
      isFalsePositive: false,
      developerNote: null,
    });
    expect(parsed.poc.sandboxLog).toBeNull();
  });

  it.each([
    ["a missing finding", { poc }],
    ["a missing poc", { finding }],
    ["an invalid finding severity", { finding: { ...finding, severity: "Severe" }, poc }],
    ["an invalid sandbox status", { finding, poc: { ...poc, sandboxStatus: "Running" } }],
    ["a poc without a file reference", { finding, poc: { ...poc, testFileReference: "" } }],
  ])("rejects %s", (_label, value) => {
    expect(AuditorFindingReportSchema.safeParse(value).success).toBe(false);
  });
});
