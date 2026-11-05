// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AnalysisStatus, Contract, Finding } from "@bbm/shared";
import { auditorApi, developerApi } from "@/lib/api";
import { ChainTxError, type ChainCalls } from "@/lib/chain/calls";
import { ethToWei } from "@/lib/money";
import SubmitPage from "../submit/page";
import { StakeGate } from "../auditor/_components/StakeGate";
import { FindingCard } from "../contracts/_components/FindingCard";
import { FundBounty } from "../contracts/_components/FundBounty";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

// vi.mock factories are hoisted, so the fixtures they use are too.
const { DEADLINE, BOUNTY } = vi.hoisted(() => {
  const DEADLINE = "2030-01-01T00:00:00.000Z";
  const BOUNTY = {
    id: "bounty_1",
    contractId: "contract_1",
    amount: "1000000000000000000",
    currency: "ETH",
    fundedAt: "2026-10-20T12:00:00.000Z",
    deadline: DEADLINE,
  };
  return { DEADLINE, BOUNTY };
});

const chain = {
  fundBounty: vi.fn(),
  isFunded: vi.fn(),
  stake: vi.fn(),
  openDispute: vi.fn(),
  rule: vi.fn(),
  deleteBounty: vi.fn(),
  refund: vi.fn(),
  withdrawPayout: vi.fn(),
  withdrawStake: vi.fn(),
} satisfies Record<keyof ChainCalls, ReturnType<typeof vi.fn>>;

vi.mock("@/lib/chain/use-chain", () => ({
  useChainCalls: () => chain,
  useAuditorId: () => "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  useRequiredStakeWei: () => "100000000000000000",
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    developerApi: {
      ...actual.developerApi,
      // jsdom's FormData does not round-trip through MSW; return what the API would.
      submitContract: vi.fn(async (input: { deadline: string; developerAddress: string }) => ({
        id: "contract_1",
        developerAddress: input.developerAddress,
        filename: "Vault.sol",
        sourceHash: "a".repeat(64),
        sourceReference: "contracts/contract_1/a.sol",
        bountyId: "bounty_1",
        status: "Open" as const,
        createdAt: new Date().toISOString(),
        deadline: input.deadline,
      })),
      markFunded: vi.fn(async () => ({}) as never),
      getBounty: vi.fn(async () => BOUNTY),
      disputeFinding: vi.fn(async () => ({}) as never),
    },
    auditorApi: { ...actual.auditorApi, postStake: vi.fn(actual.auditorApi.postStake) },
  };
});

const CONTRACT: Contract = {
  id: "contract_1",
  developerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  filename: "Vault.sol",
  sourceHash: "a".repeat(64),
  sourceReference: "contracts/contract_1/a.sol",
  bountyId: "bounty_1",
  status: "Open",
  createdAt: "2026-10-20T12:00:00.000Z",
  deadline: DEADLINE,
};

function analysis(status: AnalysisStatus["status"]): AnalysisStatus {
  return {
    contractId: "contract_1",
    status,
    error: status === "Failed" ? "ParserError" : null,
    findingCount: 0,
    updatedAt: "2026-10-20T12:00:00.000Z",
  };
}

/** The fund button once the bounty terms have loaded. */
async function enabledFundButton() {
  const button = await screen.findByRole("button", { name: /fund bounty/i });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

function withClient(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

beforeEach(() => {
  for (const fn of Object.values(chain)) fn.mockReset();
  vi.mocked(developerApi.markFunded).mockClear();
  vi.mocked(developerApi.getBounty).mockClear();
  vi.mocked(developerApi.submitContract).mockClear();
  vi.mocked(developerApi.disputeFinding).mockClear();
  vi.mocked(auditorApi.postStake).mockClear();
});

async function submitVault() {
  withClient(<SubmitPage />);
  fireEvent.change(screen.getByLabelText(/contract source/i), {
    target: {
      files: [
        new File(["pragma solidity ^0.8.19; contract V {}"], "Vault.sol", { type: "text/plain" }),
      ],
    },
  });
  fireEvent.change(screen.getByLabelText(/deadline/i), { target: { value: "2030-01-01T00:00" } });
  fireEvent.submit(screen.getByRole("button", { name: /submit contract/i }).closest("form")!);
}

describe("lifecycle flows on the local chain", () => {
  it("uploads the contract without funding it: funding waits for the analysis", async () => {
    await submitVault();
    await waitFor(() => expect(developerApi.submitContract).toHaveBeenCalledOnce());
    expect(vi.mocked(developerApi.submitContract).mock.calls[0]![0]).toMatchObject({
      bountyAmount: ethToWei("1"),
      deadline: new Date("2030-01-01T00:00").toISOString(),
    });
    expect(chain.fundBounty).not.toHaveBeenCalled();
    expect(developerApi.markFunded).not.toHaveBeenCalled();
  });

  it("funds the stored bounty on-chain once the analysis is done, then tells the API", async () => {
    chain.isFunded.mockResolvedValue(false);
    chain.fundBounty.mockResolvedValue("0xhash");
    withClient(<FundBounty contract={CONTRACT} analysis={analysis("Done")} />);
    fireEvent.click(await enabledFundButton());
    await waitFor(() => expect(developerApi.markFunded).toHaveBeenCalledWith("contract_1"));
    expect(chain.fundBounty).toHaveBeenCalledWith("contract_1", new Date(DEADLINE), BOUNTY.amount);
  });

  it("keeps the fund button disabled while the analysis runs, and hides it when it failed", async () => {
    chain.isFunded.mockResolvedValue(false);
    const { unmount } = withClient(<FundBounty contract={CONTRACT} analysis={analysis("Running")} />);
    expect(await screen.findByText("Funding opens once the analysis finishes.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fund bounty/i })).toBeDisabled();
    unmount();

    withClient(<FundBounty contract={CONTRACT} analysis={analysis("Failed")} />);
    expect(screen.queryByRole("button", { name: /fund bounty/i })).not.toBeInTheDocument();
  });

  it("asks for a new deadline when the upload's deadline has passed", async () => {
    chain.isFunded.mockResolvedValue(false);
    chain.fundBounty.mockResolvedValue("0xhash");
    vi.mocked(developerApi.getBounty).mockResolvedValueOnce({ ...BOUNTY, deadline: "2020-01-01T00:00:00.000Z" });
    withClient(<FundBounty contract={CONTRACT} analysis={analysis("Done")} />);
    const button = await enabledFundButton();

    fireEvent.click(button);
    expect(await screen.findByText("Choose a new deadline in the future.")).toBeInTheDocument();
    expect(chain.fundBounty).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/choose a new one/i), { target: { value: "2031-06-01T00:00" } });
    fireEvent.click(button);
    await waitFor(() => expect(developerApi.markFunded).toHaveBeenCalled());
    expect(chain.fundBounty).toHaveBeenCalledWith(
      "contract_1",
      new Date("2031-06-01T00:00"),
      BOUNTY.amount,
    );
  });

  it("shows a failed funding transaction and does not mark the bounty funded", async () => {
    chain.isFunded.mockResolvedValue(false);
    chain.fundBounty.mockRejectedValue(new ChainTxError("PastDeadline"));
    withClient(<FundBounty contract={CONTRACT} analysis={analysis("Done")} />);
    fireEvent.click(await enabledFundButton());
    expect(await screen.findByText(/The deadline has already passed/)).toBeInTheDocument();
    expect(developerApi.markFunded).not.toHaveBeenCalled();
  });

  it("confirms a bounty already funded on-chain with the API instead of funding it again", async () => {
    chain.isFunded.mockResolvedValue(true);
    withClient(<FundBounty contract={CONTRACT} analysis={analysis("Done")} />);
    expect(await screen.findByText(/Bounty funded on-chain/)).toBeInTheDocument();
    await waitFor(() => expect(developerApi.markFunded).toHaveBeenCalledWith("contract_1"));
    expect(chain.fundBounty).not.toHaveBeenCalled();
  });

  it("stakes on-chain instead of posting to the API", async () => {
    const onStaked = vi.fn();
    chain.stake.mockResolvedValue("0xhash");
    withClient(
      <StakeGate
        profile={{
          id: "a",
          address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
          stake: "0",
          reputation: 0,
          claimedContractIds: [],
        }}
        auditorId="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
        onStaked={onStaked}
      />,
    );
    expect(screen.getByText("0 / 0.1 required")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /post stake/i }));
    await waitFor(() => expect(onStaked).toHaveBeenCalled());
    expect(chain.stake).toHaveBeenCalledWith(ethToWei("0.1"));
    expect(auditorApi.postStake).not.toHaveBeenCalled();
  });

  const verified: Finding = {
    id: "finding_1",
    contractId: "contract_1",
    severity: "High",
    slitherDetector: "reentrancy-eth",
    rawOutputReference: "/api/findings/finding_1/raw",
    llmExplanation: "x",
    status: "Verified",
    statusHistory: [{ status: "Verified", changedAt: new Date().toISOString() }],
    claimedByAuditorId: null,
    claimExpiresAt: null,
    isFalsePositive: false,
    source: "slither" as const,
    title: null,
    reportedByAuditorId: null,
    developerNote: null,
    developerNoteUpdatedAt: null,
    challengeWindowExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };

  async function dispute() {
    withClient(
      <FindingCard
        finding={verified}
        developerAddress="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /dispute this finding/i }));
    fireEvent.change(screen.getByLabelText(/reason for dispute/i), {
      target: { value: "PoC asserts true" },
    });
    fireEvent.click(screen.getByRole("button", { name: /submit dispute/i }));
  }

  it("opens the dispute on-chain before recording it", async () => {
    chain.openDispute.mockResolvedValue("0xhash");
    await dispute();
    await waitFor(() => expect(developerApi.disputeFinding).toHaveBeenCalled());
    expect(chain.openDispute).toHaveBeenCalledWith("contract_1", "finding_1", "PoC asserts true");
    expect(chain.openDispute.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(developerApi.disputeFinding).mock.invocationCallOrder[0]!,
    );
  });

  it("shows a reverted dispute and records nothing", async () => {
    chain.openDispute.mockRejectedValue(new ChainTxError("ChallengeWindowClosed"));
    await dispute();
    expect(await screen.findByText(/challenge window has closed/)).toBeInTheDocument();
    expect(developerApi.disputeFinding).not.toHaveBeenCalled();
  });
});
