// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Finding } from "@bbm/shared";
import { auditorApi } from "@/lib/api";
import { FindingCard } from "./FindingCard";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    auditorApi: {
      ...actual.auditorApi,
      submitPoc: vi.fn(),
      markFalsePositive: vi.fn(),
    },
  };
});

const submitPoc = vi.mocked(auditorApi.submitPoc);
const markFalsePositive = vi.mocked(auditorApi.markFalsePositive);

const AUDITOR = "auditor_1";

// `satisfies` (not `as`) so a field added to or renamed in FindingSchema fails typecheck here.
const BASE_FINDING = {
  id: "finding_1",
  contractId: "contract_1",
  severity: "High",
  slitherDetector: "reentrancy-eth",
  rawOutputReference: "mock://slither/contract_1/reentrancy-eth.json",
  llmExplanation: "A reentrancy bug lets an attacker drain funds.",
  status: "Flagged",
  statusHistory: [{ status: "Flagged", changedAt: "2026-10-20T12:00:00.000Z" }],
  claimedByAuditorId: AUDITOR,
  // Far in the future, so the claim is live whatever the clock says.
  claimExpiresAt: "2099-01-01T00:00:00.000Z",
  isFalsePositive: false,
  source: "slither",
  title: null,
  reportedByAuditorId: null,
  developerNote: null,
  developerNoteUpdatedAt: null,
  challengeWindowExpiresAt: null,
} satisfies Finding;

function finding(overrides: Partial<Finding> = {}): Finding {
  return { ...BASE_FINDING, ...overrides };
}

function renderCard(props: { finding?: Finding; stakeMet?: boolean; onChanged?: () => void } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onChanged = props.onChanged ?? vi.fn();
  render(
    <QueryClientProvider client={client}>
      <FindingCard
        finding={props.finding ?? finding()}
        auditorId={AUDITOR}
        stakeMet={props.stakeMet ?? true}
        onChanged={onChanged}
      />
    </QueryClientProvider>,
  );
  return { onChanged };
}

function choosePoc(file: File) {
  fireEvent.change(screen.getByLabelText(/poc test file/i), { target: { files: [file] } });
}

describe("auditor FindingCard", () => {
  beforeEach(() => {
    submitPoc.mockReset();
    markFalsePositive.mockReset();
  });

  it("submits a .t.sol PoC for the claimed finding and reports the change", async () => {
    submitPoc.mockResolvedValueOnce({} as never);
    const { onChanged } = renderCard();
    const file = new File(["contract ExploitTest {}"], "Exploit.t.sol", { type: "text/plain" });

    choosePoc(file);
    fireEvent.click(screen.getByRole("button", { name: /submit poc/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(submitPoc).toHaveBeenCalledWith({ findingId: "finding_1", auditorId: AUDITOR, file });
  });

  it("asks for a file before submitting", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /submit poc/i }));
    expect(screen.getByText("Choose a .t.sol file first.")).toBeInTheDocument();
    expect(submitPoc).not.toHaveBeenCalled();
  });

  it("refuses a file that is not a Foundry test", () => {
    renderCard();
    choosePoc(new File(["contract V {}"], "Vault.sol"));
    fireEvent.click(screen.getByRole("button", { name: /submit poc/i }));
    expect(screen.getByText(/must be a Foundry test/i)).toBeInTheDocument();
    expect(submitPoc).not.toHaveBeenCalled();
  });

  it("refuses an empty PoC file", () => {
    renderCard();
    choosePoc(new File([], "Empty.t.sol"));
    fireEvent.click(screen.getByRole("button", { name: /submit poc/i }));
    expect(screen.getByText(/nonempty PoC file up to 100 KB/i)).toBeInTheDocument();
    expect(submitPoc).not.toHaveBeenCalled();
  });

  it("shows a generic error when the PoC upload fails", async () => {
    submitPoc.mockRejectedValueOnce(new Error("network"));
    const { onChanged } = renderCard();
    choosePoc(new File(["contract T {}"], "Exploit.t.sol"));
    fireEvent.click(screen.getByRole("button", { name: /submit poc/i }));

    expect(await screen.findByText("Failed to submit PoC.")).toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("hides the PoC form until the stake is met, but still allows a false positive", () => {
    renderCard({ stakeMet: false });
    expect(screen.queryByRole("button", { name: /submit poc/i })).not.toBeInTheDocument();
    expect(screen.getByText(/post the required stake/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark false positive/i })).toBeEnabled();
  });

  it("marks the finding a false positive", async () => {
    markFalsePositive.mockResolvedValueOnce(finding({ status: "Rejected", isFalsePositive: true }));
    const { onChanged } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: /mark false positive/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(markFalsePositive).toHaveBeenCalledWith("finding_1", { auditorId: AUDITOR });
  });

  it("says so when marking a false positive fails", async () => {
    markFalsePositive.mockRejectedValueOnce(new Error("409"));
    const { onChanged } = renderCard();

    fireEvent.click(screen.getByRole("button", { name: /mark false positive/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not mark this finding/i);
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("offers no actions without a live claim held by this auditor", () => {
    renderCard({ finding: finding({ claimedByAuditorId: "auditor_2" }) });
    expect(screen.queryByRole("button", { name: /mark false positive/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /submit poc/i })).not.toBeInTheDocument();
    expect(screen.getByText(/an active claim is required/i)).toBeInTheDocument();
  });

  it("offers no actions on an expired claim", () => {
    renderCard({ finding: finding({ claimExpiresAt: "2000-01-01T00:00:00.000Z" }) });
    expect(screen.queryByRole("button", { name: /mark false positive/i })).not.toBeInTheDocument();
  });

  it("offers no actions once the finding has moved past Flagged", () => {
    renderCard({
      finding: finding({
        status: "Submitted",
        statusHistory: [{ status: "Submitted", changedAt: "2026-10-20T12:00:00.000Z" }],
      }),
    });
    expect(screen.queryByRole("button", { name: /mark false positive/i })).not.toBeInTheDocument();
    expect(screen.getByText(/awaiting sandbox result/i)).toBeInTheDocument();
  });
});
