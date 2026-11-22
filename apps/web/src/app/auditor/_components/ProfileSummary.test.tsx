// @vitest-environment jsdom
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuditorProfile } from "@bbm/shared";
import { auditorApi, developerApi } from "@/lib/api";
import type { ChainCalls } from "@/lib/chain/calls";
import { ethToWei } from "@/lib/money";
import { ProfileSummary } from "./ProfileSummary";

const chain = {
  fundBounty: vi.fn(),
  readBounty: vi.fn(),
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
    auditorApi: { ...actual.auditorApi, getProfile: vi.fn(), withdrawStake: vi.fn() },
    developerApi: { ...actual.developerApi, listContracts: vi.fn(async () => []) },
  };
});

const AUDITOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const getProfile = vi.mocked(auditorApi.getProfile);

function profile(overrides: Partial<AuditorProfile> = {}): AuditorProfile {
  return {
    id: AUDITOR,
    address: AUDITOR,
    stake: ethToWei("2"),
    reputation: 3,
    claimedContractIds: [],
    activeSubmissions: 0,
    pendingPayout: ethToWei("1.5"),
    ...overrides,
  };
}

function renderSummary() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ProfileSummary auditorId={AUDITOR} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(chain)) fn.mockReset();
  getProfile.mockReset();
  vi.mocked(auditorApi.withdrawStake).mockReset();
  vi.mocked(developerApi.listContracts).mockClear();
});

// Regression for PR #123: the payout and the stake each have their own
// button, and each calls its own on-chain action.
describe("ProfileSummary withdraw buttons", () => {
  it("renders 'Withdraw' (payout) and 'Withdraw stake' as distinct buttons", async () => {
    getProfile.mockResolvedValue(profile());
    renderSummary();

    const payout = await screen.findByRole("button", { name: /^withdraw$/i });
    const stake = screen.getByRole("button", { name: /^withdraw stake$/i });
    expect(payout).not.toBe(stake);
    expect(screen.getByText("1.5 ETH")).toBeInTheDocument();
  });

  it("'Withdraw' withdraws the payout, not the stake", async () => {
    getProfile.mockResolvedValue(profile());
    chain.withdrawPayout.mockResolvedValueOnce(undefined);
    renderSummary();

    fireEvent.click(await screen.findByRole("button", { name: /^withdraw$/i }));

    await waitFor(() => expect(chain.withdrawPayout).toHaveBeenCalledTimes(1));
    expect(chain.withdrawStake).not.toHaveBeenCalled();
    expect(auditorApi.withdrawStake).not.toHaveBeenCalled();
  });

  it("'Withdraw stake' withdraws the stake, not the payout", async () => {
    getProfile.mockResolvedValue(profile());
    chain.withdrawStake.mockResolvedValueOnce(undefined);
    renderSummary();

    fireEvent.click(await screen.findByRole("button", { name: /^withdraw stake$/i }));

    await waitFor(() => expect(chain.withdrawStake).toHaveBeenCalledWith(ethToWei("2")));
    expect(chain.withdrawPayout).not.toHaveBeenCalled();
  });

  it("hides the payout button when nothing is pending", async () => {
    getProfile.mockResolvedValue(profile({ pendingPayout: "0" }));
    renderSummary();

    expect(await screen.findByRole("button", { name: /^withdraw stake$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^withdraw$/i })).not.toBeInTheDocument();
  });

  it("hides the stake form when there is no stake", async () => {
    getProfile.mockResolvedValue(profile({ stake: "0" }));
    renderSummary();

    expect(await screen.findByRole("button", { name: /^withdraw$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^withdraw stake$/i })).not.toBeInTheDocument();
  });

  it("shows the payout withdrawal error", async () => {
    getProfile.mockResolvedValue(profile());
    chain.withdrawPayout.mockRejectedValueOnce(new Error("NothingToWithdraw"));
    renderSummary();

    fireEvent.click(await screen.findByRole("button", { name: /^withdraw$/i }));

    expect(await screen.findByText("NothingToWithdraw")).toBeInTheDocument();
  });
});
