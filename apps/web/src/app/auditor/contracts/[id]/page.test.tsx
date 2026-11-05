// @vitest-environment jsdom
import React, { Suspense } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { auditorApi } from "@/lib/api";
import { ethToWei } from "@/lib/money";
import { cancelAllScheduled, cancelScheduled, createContract, db, resetMockDb } from "@/mocks/db";
import { QueueList } from "../../_components/QueueList";
import ClaimedContractPage from "./page";

// Rendered components rely on the automatic JSX runtime; see app/arbiter/page.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;

const AUDITOR = "auditor_report_test";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/chain/use-chain", () => ({
  useAuditorId: () => AUDITOR,
  useChainCalls: () => null,
  useRequiredStakeWei: (mockDefault: string) => mockDefault,
}));
vi.mock("@/lib/chain/config", () => ({ isLocalChain: () => false, useChainInfo: () => null }));

/** A fresh Open contract whose analysis found nothing: no findings, ever. */
function contractWithNoFindings(): string {
  const contract = createContract({
    developerAddress: `0x${"d1".repeat(20)}`,
    filename: "Clean.sol",
    sourceHash: "mock-sha256-clean",
    bountyAmount: ethToWei("1"),
    currency: "ETH",
    deadline: new Date(Date.now() + 86_400_000).toISOString(),
  });
  cancelScheduled(`analysis:${contract.id}`);
  return contract.id;
}

function newClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function renderPage(client: QueryClient, contractId: string) {
  const params = Promise.resolve({ id: contractId });
  await act(async () => {
    render(
      <QueryClientProvider client={client}>
        <Suspense fallback={null}>
          <ClaimedContractPage params={params} />
        </Suspense>
      </QueryClientProvider>,
    );
  });
  await screen.findByRole("heading", { name: "Clean.sol" });
}

beforeEach(() => {
  resetMockDb();
  db.auditorProfiles.push({
    id: AUDITOR,
    address: `0x${"a9".repeat(20)}`,
    stake: ethToWei("10000"),
    reputation: 0,
    claimedContractIds: [],
  });
});

afterEach(() => {
  cancelAllScheduled();
});

describe("ClaimedContractPage report form", () => {
  it("offers the report form on a claimed contract with no findings, right after claiming", async () => {
    const contractId = contractWithNoFindings();
    const client = newClient();
    // The profile was cached before the claim, as on the queue page.
    await client.fetchQuery({
      queryKey: ["auditor-profile", AUDITOR],
      queryFn: () => auditorApi.getProfile(AUDITOR),
    });
    render(
      <QueryClientProvider client={client}>
        <QueueList auditorId={AUDITOR} />
      </QueryClientProvider>,
    );
    await screen.findByText("Clean.sol");
    const row = screen.getByText("Clean.sol").closest("li")!;
    fireEvent.click(within(row).getByRole("button", { name: "Claim" }));
    await vi.waitFor(() => expect(db.claims[contractId]?.auditorId).toBe(AUDITOR));

    await renderPage(client, contractId);
    expect(screen.getByText(/No findings yet/)).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Report a new finding" })).toBeInTheDocument();
  });

  it("offers the report form on reload of a claimed contract with no findings", async () => {
    const contractId = contractWithNoFindings();
    await auditorApi.claimContract({ contractId, auditorId: AUDITOR });
    await renderPage(newClient(), contractId);
    expect(await screen.findByRole("button", { name: "Report a new finding" })).toBeInTheDocument();
  });

  it("hides the form when another auditor holds the claim", async () => {
    const contractId = contractWithNoFindings();
    db.claims[contractId] = {
      auditorId: "someone_else",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    db.contracts.find((c) => c.id === contractId)!.status = "Claimed";
    await renderPage(newClient(), contractId);
    expect(screen.queryByRole("button", { name: "Report a new finding" })).not.toBeInTheDocument();
  });

  it("hides the form once the contract is no longer claimed", async () => {
    const contractId = contractWithNoFindings();
    await auditorApi.claimContract({ contractId, auditorId: AUDITOR });
    db.contracts.find((c) => c.id === contractId)!.status = "Open";
    await renderPage(newClient(), contractId);
    expect(screen.queryByRole("button", { name: "Report a new finding" })).not.toBeInTheDocument();
  });
});
