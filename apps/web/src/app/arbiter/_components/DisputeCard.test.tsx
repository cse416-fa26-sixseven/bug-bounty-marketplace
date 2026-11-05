// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ArbiterDisputeView } from "@/lib/api/arbiter";
import { DisputeCard } from "./DisputeCard";

// DisputeCard relies on the automatic JSX runtime; see app/arbiter/page.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;

const at = "2026-11-01T12:00:00.000Z";

function dispute(source: "slither" | "auditor"): ArbiterDisputeView {
  const auditor = source === "auditor";
  return {
    id: "dispute_9",
    findingId: "finding_9",
    developerId: "0xdev",
    reason: "Not exploitable on mainnet.",
    openedAt: at,
    challengeWindowExpiresAt: at,
    ruling: "Pending",
    ruledAt: null,
    arbiterId: null,
    finding: {
      id: "finding_9",
      contractId: "contract_9",
      severity: "High",
      slitherDetector: auditor ? "auditor-reported" : "reentrancy-eth",
      rawOutputReference: "/api/findings/finding_9/raw",
      llmExplanation: auditor ? "sweep() has no access control." : "Re-entrancy in withdraw().",
      status: "Disputed",
      statusHistory: [],
      claimedByAuditorId: null,
      claimExpiresAt: null,
      isFalsePositive: false,
      challengeWindowExpiresAt: at,
      source,
      title: auditor ? "Unprotected sweep()" : null,
      reportedByAuditorId: auditor ? "0xauditor" : null,
      developerNote: null,
      developerNoteUpdatedAt: null,
    },
    pocSubmission: null,
  };
}

describe("DisputeCard", () => {
  it("labels an auditor-reported finding and drops the AI label", () => {
    render(<DisputeCard dispute={dispute("auditor")} onRule={vi.fn()} isRuling={false} />);
    expect(screen.getByText("Auditor-reported")).toBeInTheDocument();
    expect(screen.getByText("Unprotected sweep()")).toBeInTheDocument();
    expect(screen.getByText(/reported by 0xauditor/)).toBeInTheDocument();
    expect(screen.queryByText(/AI explanation/)).not.toBeInTheDocument();
  });

  it("labels a Slither finding's text as an AI explanation", () => {
    render(<DisputeCard dispute={dispute("slither")} onRule={vi.fn()} isRuling={false} />);
    expect(screen.getByText("Slither + AI")).toBeInTheDocument();
    expect(screen.getByText("reentrancy-eth")).toBeInTheDocument();
    expect(screen.getByText(/AI explanation/)).toBeInTheDocument();
  });
});
