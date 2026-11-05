// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import SubmitPage from "../page";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

function renderWithProviders() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SubmitPage />
    </QueryClientProvider>,
  );
}

describe("SubmitPage", () => {
  it("shows an inline error and blocks submission for a non-.sol file", async () => {
    renderWithProviders();

    const fileInput = screen.getByLabelText(/contract source/i) as HTMLInputElement;
    const badFile = new File(["hello"], "notes.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [badFile] } });

    expect(await screen.findByText(/only \.sol files are accepted/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/deadline/i), {
      target: { value: "2030-01-01T00:00" },
    });
    fireEvent.submit(screen.getByRole("button", { name: /submit contract/i }).closest("form")!);

    await waitFor(() => {
      expect(pushMock).not.toHaveBeenCalled();
    });
  });

  it("shows an inline error for a file over the 100 KB limit", async () => {
    renderWithProviders();

    const fileInput = screen.getByLabelText(/contract source/i) as HTMLInputElement;
    const oversized = new File([new Uint8Array(102_401)], "Big.sol", {
      type: "text/plain",
    });
    fireEvent.change(fileInput, { target: { files: [oversized] } });

    expect(await screen.findByText(/file is too large/i)).toBeInTheDocument();
  });

  describe("sidebar on a chain", () => {
    const CHAIN = {
      configured: true,
      addresses: {
        auditorStaking: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
        bountyEscrow: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
        disputeResolution: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
      },
      arbiter: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      challengeWindowSeconds: 600,
      requiredStakeWei: "250000000000000000",
    };

    it("names the Sepolia testnet and the contract's stake", async () => {
      server.use(http.get("*/api/chain", () => HttpResponse.json({ ...CHAIN, chainId: 11155111 })));
      renderWithProviders();
      expect(await screen.findByText(/on the Sepolia testnet/)).toBeInTheDocument();
      expect(screen.getByText(/An auditor stakes 0\.25 ETH/)).toBeInTheDocument();
      expect(screen.queryByText(/Anvil/)).not.toBeInTheDocument();
    });

    it("keeps the local Anvil wording on the local chain", async () => {
      server.use(
        http.get("*/api/chain", () =>
          HttpResponse.json({ ...CHAIN, chainId: 31337, rpcUrl: "http://localhost:8545" }),
        ),
      );
      renderWithProviders();
      expect(await screen.findByText(/on a local Anvil chain, using a dev account/)).toBeInTheDocument();
      expect(screen.getByText(/An auditor stakes 0\.25 ETH/)).toBeInTheDocument();
    });
  });

  it("accepts a valid .sol file under the size limit with no inline error", () => {
    renderWithProviders();

    const fileInput = screen.getByLabelText(/contract source/i) as HTMLInputElement;
    const goodFile = new File(["contract Foo {}"], "Foo.sol", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [goodFile] } });

    expect(screen.queryByText(/only \.sol files are accepted/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/file is too large/i)).not.toBeInTheDocument();
  });
});
