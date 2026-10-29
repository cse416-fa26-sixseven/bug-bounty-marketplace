// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import { Header } from "../Header";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/" }));

const CHAIN = {
  configured: true,
  chainId: 31337,
  rpcUrl: "http://localhost:8545",
  addresses: {
    auditorStaking: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    bountyEscrow: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    disputeResolution: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  },
  arbiter: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  challengeWindowSeconds: 60,
  requiredStakeWei: "100000000000000000",
};

function renderHeader() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Header />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Header banner", () => {
  it("says the demo is simulated without a chain", async () => {
    renderHeader();
    expect(await screen.findByText(/are simulated/i)).toBeInTheDocument();
  });

  it("says transactions are real on the local chain", async () => {
    server.use(http.get("*/api/chain", () => HttpResponse.json(CHAIN)));
    renderHeader();
    expect(await screen.findByText(/Local test chain/)).toBeInTheDocument();
    expect(screen.getByText(/Transactions are real on a local Anvil network; no real funds\./)).toBeInTheDocument();
  });

  describe("against the real API (staging/prod)", () => {
    it("shows no banner without a chain", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
      const chainFetched = vi.fn();
      server.use(
        http.get("*/api/chain", () => {
          chainFetched();
          return HttpResponse.json({ configured: false });
        }),
      );
      renderHeader();
      await waitFor(() => expect(chainFetched).toHaveBeenCalled());
      expect(screen.queryByText(/Demo environment/)).not.toBeInTheDocument();
      expect(screen.queryByText(/are simulated/i)).not.toBeInTheDocument();
    });

    it("shows no banner on Sepolia", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
      const chainFetched = vi.fn();
      server.use(
        http.get("*/api/chain", () => {
          chainFetched();
          return HttpResponse.json({ ...CHAIN, chainId: 11155111, rpcUrl: undefined });
        }),
      );
      renderHeader();
      await waitFor(() => expect(chainFetched).toHaveBeenCalled());
      expect(screen.queryByText(/Demo environment/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Local test chain/)).not.toBeInTheDocument();
    });

    it("still shows the local chain banner on anvil", async () => {
      vi.stubEnv("NEXT_PUBLIC_API_MOCKING", "disabled");
      server.use(http.get("*/api/chain", () => HttpResponse.json(CHAIN)));
      renderHeader();
      expect(await screen.findByText(/Local test chain/)).toBeInTheDocument();
    });
  });
});
