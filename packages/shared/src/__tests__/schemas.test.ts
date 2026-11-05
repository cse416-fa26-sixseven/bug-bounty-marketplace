import { describe, expect, it } from "vitest";
import {
  AnalysisStatusSchema,
  AuditorProfileSchema,
  BountySchema,
  CONTRACT_SOURCE_MAX_BYTES,
  ContractSchema,
  ContractSourceFilenameSchema,
  ContractSourceSizeSchema,
  ContractSubmissionFieldsSchema,
  DisputeSchema,
  AUDITOR_FINDING_DESCRIPTION_MAX_LENGTH,
  AUDITOR_FINDING_TITLE_MAX_LENGTH,
  AuditorFindingFieldsSchema,
  FindingSchema,
  FindingStatusSchema,
  PoCSubmissionSchema,
  POC_SOURCE_MAX_BYTES,
  PocSourceFilenameSchema,
  PocSourceSizeSchema,
} from "../index";

const now = "2026-09-30T12:00:00.000Z";
const later = "2026-10-30T12:00:00.000Z";
const address = "0x1234567890123456789012345678901234567890";

describe("ContractSchema", () => {
  const valid = {
    id: "contract_1",
    developerAddress: address,
    filename: "Vault.sol",
    sourceHash: "0xdeadbeef",
    sourceReference: "contracts/contract_1/0xdeadbeef.sol",
    bountyId: "bounty_1",
    status: "Open",
    createdAt: now,
    deadline: later,
  };

  it("accepts a well-formed contract", () => {
    expect(ContractSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a missing required field", () => {
    const { filename: _filename, ...missingFilename } = valid;
    expect(ContractSchema.safeParse(missingFilename).success).toBe(false);
  });

  it("rejects an invalid status enum value", () => {
    expect(ContractSchema.safeParse({ ...valid, status: "NotAStatus" }).success).toBe(false);
  });

  it("rejects a malformed address", () => {
    expect(ContractSchema.safeParse({ ...valid, developerAddress: "not-an-address" }).success).toBe(
      false,
    );
  });
});

describe("ContractSourceFilenameSchema", () => {
  it("accepts a .sol filename, case-insensitively", () => {
    expect(ContractSourceFilenameSchema.safeParse("Vault.sol").success).toBe(true);
    expect(ContractSourceFilenameSchema.safeParse("VAULT.SOL").success).toBe(true);
  });

  it("rejects other extensions and a bare .sol-looking suffix", () => {
    expect(ContractSourceFilenameSchema.safeParse("Vault.txt").success).toBe(false);
    expect(ContractSourceFilenameSchema.safeParse("Vault.sol.exe").success).toBe(false);
    expect(ContractSourceFilenameSchema.safeParse("").success).toBe(false);
  });
});

describe("ContractSourceSizeSchema", () => {
  it("accepts sizes from 1 byte up to the limit", () => {
    expect(ContractSourceSizeSchema.safeParse(1).success).toBe(true);
    expect(ContractSourceSizeSchema.safeParse(CONTRACT_SOURCE_MAX_BYTES).success).toBe(true);
  });

  it("rejects an empty file and a file over the limit", () => {
    expect(ContractSourceSizeSchema.safeParse(0).success).toBe(false);
    expect(ContractSourceSizeSchema.safeParse(CONTRACT_SOURCE_MAX_BYTES + 1).success).toBe(false);
  });
});

describe("ContractSubmissionFieldsSchema", () => {
  const valid = {
    developerAddress: address,
    bountyAmount: "2500000000000000000",
    currency: "USDC",
    deadline: later,
  };

  it("keeps a multipart wei amount as a decimal string", () => {
    const parsed = ContractSubmissionFieldsSchema.parse(valid);
    expect(parsed.bountyAmount).toBe("2500000000000000000");
  });

  it("defaults the currency to ETH when omitted", () => {
    const { currency: _currency, ...withoutCurrency } = valid;
    expect(ContractSubmissionFieldsSchema.parse(withoutCurrency).currency).toBe("ETH");
  });

  it("rejects a zero, non-numeric or leading-zero bounty amount", () => {
    expect(ContractSubmissionFieldsSchema.safeParse({ ...valid, bountyAmount: "0" }).success).toBe(
      false,
    );
    expect(ContractSubmissionFieldsSchema.safeParse({ ...valid, bountyAmount: "abc" }).success).toBe(
      false,
    );
  });

  it("rejects a malformed developer address and a non-datetime deadline", () => {
    expect(
      ContractSubmissionFieldsSchema.safeParse({ ...valid, developerAddress: "0x123" }).success,
    ).toBe(false);
    expect(ContractSubmissionFieldsSchema.safeParse({ ...valid, deadline: "soon" }).success).toBe(
      false,
    );
  });
});

describe("BountySchema", () => {
  const valid = {
    id: "bounty_1",
    contractId: "contract_1",
    amount: "1000",
    currency: "USDC",
    fundedAt: now,
    deadline: later,
  };

  it("accepts a well-formed bounty", () => {
    expect(BountySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a zero amount", () => {
    expect(BountySchema.safeParse({ ...valid, amount: "0" }).success).toBe(false);
  });

  it("rejects a numeric (non-string) amount", () => {
    expect(BountySchema.safeParse({ ...valid, amount: 1000 }).success).toBe(false);
  });
});

describe("FindingStatusSchema", () => {
  it("accepts every documented status", () => {
    for (const status of [
      "Flagged",
      "Submitted",
      "Verified",
      "Disputed",
      "Rejected",
      "Paid",
    ]) {
      expect(FindingStatusSchema.safeParse(status).success).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    expect(FindingStatusSchema.safeParse("Closed").success).toBe(false);
  });
});

describe("FindingSchema", () => {
  const valid = {
    id: "finding_1",
    contractId: "contract_1",
    severity: "High",
    slitherDetector: "reentrancy-eth",
    rawOutputReference: "s3://bucket/slither/finding_1.json",
    llmExplanation: "This function is vulnerable to a reentrancy attack because ...",
    status: "Flagged",
    statusHistory: [{ status: "Flagged", changedAt: now }],
    claimedByAuditorId: null,
    claimExpiresAt: null,
    isFalsePositive: false,
    challengeWindowExpiresAt: null,
  };

  it("accepts a well-formed finding", () => {
    expect(FindingSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an invalid severity", () => {
    expect(FindingSchema.safeParse({ ...valid, severity: "Catastrophic" }).success).toBe(false);
  });

  it("rejects a missing llmExplanation", () => {
    const { llmExplanation: _llmExplanation, ...missing } = valid;
    expect(FindingSchema.safeParse(missing).success).toBe(false);
  });

  it("accepts a Verified finding with an open challenge window", () => {
    const verified = {
      ...valid,
      status: "Verified",
      challengeWindowExpiresAt: now,
    };
    expect(FindingSchema.safeParse(verified).success).toBe(true);
  });
});

describe("FindingSchema origin", () => {
  const slither = {
    id: "finding_1",
    contractId: "contract_1",
    severity: "High",
    slitherDetector: "reentrancy-eth",
    rawOutputReference: "/api/findings/finding_1/raw",
    llmExplanation: "Re-entrancy in withdraw().",
    status: "Flagged",
  };

  it("defaults a finding without origin fields to a Slither finding", () => {
    const parsed = FindingSchema.parse(slither);
    expect(parsed.source).toBe("slither");
    expect(parsed.title).toBeNull();
    expect(parsed.reportedByAuditorId).toBeNull();
  });

  it("accepts an auditor-reported finding", () => {
    const parsed = FindingSchema.parse({
      ...slither,
      slitherDetector: "auditor-reported",
      source: "auditor",
      title: "Owner can be front-run",
      reportedByAuditorId: "auditor_1",
      status: "Submitted",
    });
    expect(parsed.source).toBe("auditor");
  });

  it("rejects an unknown source", () => {
    expect(FindingSchema.safeParse({ ...slither, source: "llm" }).success).toBe(false);
  });
});

describe("AuditorFindingFieldsSchema", () => {
  const valid = {
    contractId: "contract_1",
    title: "  Missing access control on sweep()  ",
    severity: "Critical",
    description: "Anyone can call sweep() and take the balance.",
  };

  it("accepts and trims a well-formed report", () => {
    const parsed = AuditorFindingFieldsSchema.parse(valid);
    expect(parsed.title).toBe("Missing access control on sweep()");
  });

  it("rejects a blank title or description", () => {
    expect(AuditorFindingFieldsSchema.safeParse({ ...valid, title: "   " }).success).toBe(false);
    expect(AuditorFindingFieldsSchema.safeParse({ ...valid, description: "" }).success).toBe(false);
  });

  it("enforces the title and description length limits", () => {
    const at = (n: number) => "a".repeat(n);
    expect(
      AuditorFindingFieldsSchema.safeParse({ ...valid, title: at(AUDITOR_FINDING_TITLE_MAX_LENGTH) })
        .success,
    ).toBe(true);
    expect(
      AuditorFindingFieldsSchema.safeParse({
        ...valid,
        title: at(AUDITOR_FINDING_TITLE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
    expect(
      AuditorFindingFieldsSchema.safeParse({
        ...valid,
        description: at(AUDITOR_FINDING_DESCRIPTION_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects NUL characters, which Postgres text columns cannot store", () => {
    expect(AuditorFindingFieldsSchema.safeParse({ ...valid, title: "a\u0000b" }).success).toBe(
      false,
    );
    expect(
      AuditorFindingFieldsSchema.safeParse({ ...valid, description: "a\u0000b" }).success,
    ).toBe(false);
  });

  it("rejects an unknown severity", () => {
    expect(AuditorFindingFieldsSchema.safeParse({ ...valid, severity: "Severe" }).success).toBe(
      false,
    );
  });
});

describe("PoCSubmissionSchema", () => {
  const valid = {
    id: "poc_1",
    findingId: "finding_1",
    auditorId: "auditor_1",
    testFileReference: "s3://bucket/poc/poc_1.t.sol",
    submittedAt: now,
    sandboxStatus: "Pending",
    sandboxLog: null,
  };

  it("accepts a well-formed PoC submission", () => {
    expect(PoCSubmissionSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an invalid sandboxStatus", () => {
    expect(PoCSubmissionSchema.safeParse({ ...valid, sandboxStatus: "Running" }).success).toBe(
      false,
    );
  });
});

describe("DisputeSchema", () => {
  const valid = {
    id: "dispute_1",
    findingId: "finding_1",
    developerId: "dev_1",
    reason: "The PoC does not actually reproduce the finding.",
    openedAt: now,
    challengeWindowExpiresAt: later,
    ruling: "Pending",
    ruledAt: null,
    arbiterId: null,
  };

  it("accepts a well-formed dispute", () => {
    expect(DisputeSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an invalid ruling value", () => {
    expect(DisputeSchema.safeParse({ ...valid, ruling: "Undecided" }).success).toBe(false);
  });

  it("rejects a non-datetime openedAt", () => {
    expect(DisputeSchema.safeParse({ ...valid, openedAt: "not-a-date" }).success).toBe(false);
  });
});

describe("AuditorProfileSchema", () => {
  const valid = {
    id: "auditor_1",
    address,
    stake: "500000000000000000",
    reputation: 12.5,
    claimedContractIds: ["contract_1"],
  };

  it("accepts a well-formed auditor profile", () => {
    expect(AuditorProfileSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a negative stake", () => {
    expect(AuditorProfileSchema.safeParse({ ...valid, stake: "-1" }).success).toBe(false);
  });

  it("rejects a malformed address", () => {
    expect(AuditorProfileSchema.safeParse({ ...valid, address: "0x123" }).success).toBe(false);
  });
});

describe("AnalysisStatusSchema", () => {
  const valid = {
    contractId: "contract_1",
    status: "Failed",
    error: "ParserError: Expected ';'",
    findingCount: 0,
    updatedAt: now,
  };

  it("accepts a failed analysis with its error", () => {
    expect(AnalysisStatusSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a running analysis with no error", () => {
    expect(AnalysisStatusSchema.safeParse({ ...valid, status: "Running", error: null }).success).toBe(true);
  });

  it("rejects a negative finding count", () => {
    expect(AnalysisStatusSchema.safeParse({ ...valid, findingCount: -1 }).success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(AnalysisStatusSchema.safeParse({ ...valid, status: "Pending" }).success).toBe(false);
  });
});

describe("PoC upload limits", () => {
  it("caps PoC files at 100 KB", () => {
    expect(POC_SOURCE_MAX_BYTES).toBe(102_400);
    expect(PocSourceSizeSchema.safeParse(102_400).success).toBe(true);
    const tooBig = PocSourceSizeSchema.safeParse(102_401);
    expect(tooBig.success).toBe(false);
    expect(tooBig.error?.issues[0]?.message).toBe("PoC file exceeds the 100 KB limit");
  });

  it("rejects an empty PoC file", () => {
    expect(PocSourceSizeSchema.safeParse(0).success).toBe(false);
  });

  it("only accepts .t.sol filenames", () => {
    expect(PocSourceFilenameSchema.safeParse("Exploit.t.sol").success).toBe(true);
    expect(PocSourceFilenameSchema.safeParse("Exploit.T.SOL").success).toBe(true);
    const plain = PocSourceFilenameSchema.safeParse("Exploit.sol");
    expect(plain.success).toBe(false);
    expect(plain.error?.issues[0]?.message).toBe("Filename must end in .t.sol");
  });
});
