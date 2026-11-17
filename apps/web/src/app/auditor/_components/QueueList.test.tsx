// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import { ethToWei } from "@/lib/money";
import { QueueList } from "./QueueList";
import { REQUIRED_STAKE_WEI } from "./StakeGate";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const ITEM = {
  id: "contract_q1",
  developerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  filename: "Vault.sol",
  sourceHash: "a".repeat(64),
  sourceReference: "contracts/contract_q1/a.sol",
  bountyId: "bounty_q1",
  status: "Open",
  createdAt: "2026-10-24T10:00:00.000Z",
  deadline: "2030-01-01T00:00:00.000Z",
  bounty: { amount: "1000000000000000000", currency: "ETH" },
};

const AUDITOR = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

function profileWithStake(stake: string) {
  return { id: AUDITOR, address: AUDITOR, stake, reputation: 0, claimedContractIds: [] };
}

function renderQueue() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <QueueList auditorId={AUDITOR} />
    </QueryClientProvider>,
  );
}

/** Renders the queue with one item and the claim answering `status` with `error`. */
async function claimRefusedWith(error: string, status = 409) {
  server.use(
    http.get("*/api/auditor/queue", () => HttpResponse.json([ITEM])),
    http.post("*/api/auditor/claim", () => HttpResponse.json({ error }, { status })),
  );
  renderQueue();
  fireEvent.click(await screen.findByRole("button", { name: "Claim" }));
}

describe("QueueList stake requirement", () => {
  it("disables Claim and says why when the auditor's stake is below the requirement", async () => {
    const claim = vi.fn(() => HttpResponse.json({}));
    server.use(
      http.get("*/api/auditor/queue", () => HttpResponse.json([ITEM])),
      http.get("*/api/auditor/profile", () => HttpResponse.json(profileWithStake(ethToWei("5000")))),
      http.post("*/api/auditor/claim", claim),
    );
    renderQueue();
    expect(await screen.findByText(/Post the required stake above to claim/)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Claim" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(claim).not.toHaveBeenCalled();
  });

  it("enables Claim once the stake meets the requirement", async () => {
    server.use(
      http.get("*/api/auditor/queue", () => HttpResponse.json([ITEM])),
      http.get("*/api/auditor/profile", () => HttpResponse.json(profileWithStake(REQUIRED_STAKE_WEI))),
    );
    renderQueue();
    const button = await screen.findByRole("button", { name: "Claim" });
    await waitFor(() => expect(screen.queryByText(/Post the required stake above/)).not.toBeInTheDocument());
    expect(button).toBeEnabled();
  });

  it("explains a 403 stake refusal from the API", async () => {
    await claimRefusedWith("Auditor stake is below the required stake", 403);
    expect(
      await screen.findByText(/Your stake is below the required stake. Post the required stake above/),
    ).toBeInTheDocument();
  });
});

describe("QueueList claim errors", () => {
  it("tells an auditor who already holds a claim to finish it first", async () => {
    await claimRefusedWith("auditor already holds an active claim");
    expect(
      await screen.findByText(/You already hold a claim on another contract/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Someone else already claimed/)).not.toBeInTheDocument();
  });

  it("says when the bounty is not funded on-chain yet", async () => {
    await claimRefusedWith("bounty not funded on-chain");
    expect(await screen.findByText(/isn’t funded on-chain yet/)).toBeInTheDocument();
  });

  it("still reports a contract someone else claimed", async () => {
    await claimRefusedWith("Contract contract_q1 is not open to claim");
    expect(
      await screen.findByText(/Someone else already claimed that contract/),
    ).toBeInTheDocument();
  });
});
