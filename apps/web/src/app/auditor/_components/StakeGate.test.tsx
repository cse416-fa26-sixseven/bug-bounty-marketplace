// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StakeGate, REQUIRED_STAKE, REQUIRED_STAKE_WEI } from "./StakeGate";
import { ethToWei } from "@/lib/money";
import { auditorApi } from "@/lib/api";

// Wrap postStake in a spy that still calls through to the real (MSW-mocked) API.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    auditorApi: { ...actual.auditorApi, postStake: vi.fn(actual.auditorApi.postStake) },
  };
});

const postStake = vi.mocked(auditorApi.postStake);

const INVALID_AMOUNT_MESSAGE = "Enter a stake in ETH, up to 18 decimal places.";

function withQueryClient(children: ReactNode) {
  const queryClient = new QueryClient();
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("StakeGate", () => {
  beforeEach(() => {
    postStake.mockClear();
  });


  it("locks PoC upload below the required stake and shows the shortfall", () => {
    render(
      withQueryClient(
        <StakeGate
          profile={{ id: "auditor_1", address: "0xabc", stake: ethToWei("5000"), reputation: 12, claimedContractIds: [] }}
          auditorId="auditor_1"
          onStaked={vi.fn()}
        />,
      ),
    );

    expect(screen.getByText("PoC upload locked")).toBeInTheDocument();
    expect(screen.getByText(`5,000 / ${REQUIRED_STAKE.toLocaleString()} required`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /post stake/i })).toBeInTheDocument();
    expect(screen.getByText(/Claiming a contract and submitting a PoC both need/)).toBeInTheDocument();
  });

  it("shows the unlocked state and hides the stake form once stake meets the requirement", () => {
    render(
      withQueryClient(
        <StakeGate
          profile={{
            id: "auditor_1",
            address: "0xabc",
            stake: REQUIRED_STAKE_WEI,
            reputation: 12,
            claimedContractIds: [],
          }}
          auditorId="auditor_1"
          onStaked={vi.fn()}
        />,
      ),
    );

    expect(screen.getByText("PoC upload unlocked")).toBeInTheDocument();
    expect(screen.queryByText(/Claiming a contract and submitting a PoC both need/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /post stake/i })).not.toBeInTheDocument();
  });

  it("calls onStaked after successfully posting stake via the mocked API", async () => {
    const onStaked = vi.fn();

    render(
      withQueryClient(
        <StakeGate
          profile={{ id: "auditor_1", address: "0xabc", stake: ethToWei("5000"), reputation: 12, claimedContractIds: [] }}
          auditorId="auditor_1"
          onStaked={onStaked}
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /post stake/i }));

    await waitFor(() => expect(onStaked).toHaveBeenCalledTimes(1));
  });

  function renderGateWithShortfall(onStaked = vi.fn()) {
    render(
      withQueryClient(
        <StakeGate
          profile={{ id: "auditor_1", address: "0xabc", stake: ethToWei("5000"), reputation: 12, claimedContractIds: [] }}
          auditorId="auditor_1"
          onStaked={onStaked}
        />,
      ),
    );
    return { onStaked, input: screen.getByLabelText("Post stake") as HTMLInputElement };
  }

  it("rejects exponent notation like 1e3 without calling postStake", () => {
    const { input } = renderGateWithShortfall();

    fireEvent.change(input, { target: { value: "1e3" } });
    fireEvent.click(screen.getByRole("button", { name: /post stake/i }));

    expect(screen.getByText(INVALID_AMOUNT_MESSAGE)).toBeInTheDocument();
    expect(postStake).not.toHaveBeenCalled();
  });

  it("rejects amounts with more than 18 decimal places without calling postStake", () => {
    const { input } = renderGateWithShortfall();

    fireEvent.change(input, { target: { value: "0.0000000000000000001" } });
    fireEvent.click(screen.getByRole("button", { name: /post stake/i }));

    expect(screen.getByText(INVALID_AMOUNT_MESSAGE)).toBeInTheDocument();
    expect(postStake).not.toHaveBeenCalled();
  });

  it("posts a valid decimal stake as a wei string", async () => {
    const { input, onStaked } = renderGateWithShortfall();

    fireEvent.change(input, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: /post stake/i }));

    await waitFor(() => expect(onStaked).toHaveBeenCalledTimes(1));
    expect(postStake).toHaveBeenCalledWith({ auditorId: "auditor_1", amount: "2500000000000000000" });
  });
});
