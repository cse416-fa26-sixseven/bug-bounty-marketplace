// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuditorProfile } from "@bbm/shared";
import { StakeWithdraw } from "./StakeWithdraw";
import { ethToWei } from "@/lib/money";
import { auditorApi } from "@/lib/api";

// Wrap withdrawStake in a spy that still calls through to the real (MSW-mocked) API.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    auditorApi: { ...actual.auditorApi, withdrawStake: vi.fn(actual.auditorApi.withdrawStake) },
  };
});

const withdrawStake = vi.mocked(auditorApi.withdrawStake);

function profile(overrides: Partial<AuditorProfile> = {}): AuditorProfile {
  return {
    id: "auditor_1",
    address: "0xabc",
    stake: ethToWei("5000"),
    reputation: 12,
    claimedContractIds: [],
    activeSubmissions: 0,
    ...overrides,
  };
}

function withQueryClient(children: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe("StakeWithdraw", () => {
  beforeEach(() => {
    withdrawStake.mockClear();
  });

  it("is disabled and says why while a claim or pending finding holds a lock", () => {
    render(withQueryClient(<StakeWithdraw profile={profile({ activeSubmissions: 1 })} auditorId="auditor_1" onWithdrawn={vi.fn()} />));

    expect(screen.getByRole("button", { name: /withdraw stake/i })).toBeDisabled();
    expect(screen.getByText(/locked while you have an active claim/i)).toBeInTheDocument();
  });

  it("withdraws the full stake by default when nothing is locked", async () => {
    // The seeded mock auditor holds locks, so answer this call directly.
    withdrawStake.mockResolvedValueOnce(profile({ stake: "0" }));
    const onWithdrawn = vi.fn();
    render(withQueryClient(<StakeWithdraw profile={profile()} auditorId="auditor_1" onWithdrawn={onWithdrawn} />));

    fireEvent.click(screen.getByRole("button", { name: /withdraw stake/i }));

    await waitFor(() => expect(onWithdrawn).toHaveBeenCalled());
    expect(withdrawStake).toHaveBeenCalledWith({ auditorId: "auditor_1", amount: ethToWei("5000") });
  });

  it("refuses more than the stake without calling the API", () => {
    render(withQueryClient(<StakeWithdraw profile={profile()} auditorId="auditor_1" onWithdrawn={vi.fn()} />));

    fireEvent.change(screen.getByLabelText(/withdraw stake/i), { target: { value: "6000" } });
    fireEvent.click(screen.getByRole("button", { name: /withdraw stake/i }));

    expect(screen.getByText("That is more than your stake.")).toBeInTheDocument();
    expect(withdrawStake).not.toHaveBeenCalled();
  });
});
