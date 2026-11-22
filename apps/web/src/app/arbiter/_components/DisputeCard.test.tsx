// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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

  it("shows the developer's note read-only", () => {
    const view = dispute("slither");
    view.finding = {
      ...view.finding!,
      developerNote: "Mitigated by the pause guard.",
      developerNoteUpdatedAt: at,
    };
    render(<DisputeCard dispute={view} onRule={vi.fn()} isRuling={false} />);
    expect(screen.getByText(/Developer.s note/)).toBeInTheDocument();
    expect(screen.getByText("Mitigated by the pause guard.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /note/i })).not.toBeInTheDocument();
  });

  it("'Rule for auditor' and 'Rule against auditor' report their own ruling", () => {
    const onRule = vi.fn();
    render(<DisputeCard dispute={dispute("slither")} onRule={onRule} isRuling={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Rule for auditor" }));
    expect(onRule).toHaveBeenLastCalledWith("ForAuditor");

    fireEvent.click(screen.getByRole("button", { name: "Rule against auditor" }));
    expect(onRule).toHaveBeenLastCalledWith("AgainstAuditor");
    expect(onRule).toHaveBeenCalledTimes(2);
  });

  it("disables both ruling buttons while a ruling is submitting", () => {
    render(<DisputeCard dispute={dispute("slither")} onRule={vi.fn()} isRuling />);
    expect(screen.getByRole("button", { name: "Rule for auditor" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rule against auditor" })).toBeDisabled();
    expect(screen.getByText(/Submitting ruling/)).toBeInTheDocument();
  });

  it("shows who ruled instead of the buttons once ruled", () => {
    const view = { ...dispute("slither"), ruling: "ForAuditor" as const, ruledAt: at, arbiterId: "0xarbiter" };
    render(<DisputeCard dispute={view} onRule={vi.fn()} isRuling={false} />);
    expect(screen.queryByRole("button", { name: /rule for auditor/i })).not.toBeInTheDocument();
    expect(screen.getByText(/by 0xarbiter/)).toBeInTheDocument();
  });

  it("labels a Slither finding's text as an AI explanation", () => {
    render(<DisputeCard dispute={dispute("slither")} onRule={vi.fn()} isRuling={false} />);
    expect(screen.getByText("Slither + AI")).toBeInTheDocument();
    expect(screen.getByText("reentrancy-eth")).toBeInTheDocument();
    expect(screen.getByText(/AI explanation/)).toBeInTheDocument();
  });
});
