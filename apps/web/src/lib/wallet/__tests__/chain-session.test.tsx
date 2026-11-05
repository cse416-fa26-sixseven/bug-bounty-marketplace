// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import { useRoleStore } from "@/lib/role/store";
import { ANVIL_ACCOUNTS } from "@/lib/chain/accounts";
import { parseSiweMessage } from "viem/siwe";
import { siweMessage } from "@/test/siwe";
import { ChainSession } from "../chain-session";

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

describe("ChainSession", () => {
  it("signs in as the selected role's account, and again when the role changes", async () => {
    const logins: string[] = [];
    server.use(
      http.get("*/api/chain", () => HttpResponse.json(CHAIN)),
      http.post("*/api/auth/nonce", async ({ request }) => {
        const { address } = (await request.json()) as { address: string };
        return HttpResponse.json({ nonce: "abcdef0123456789", message: siweMessage(address) });
      }),
      http.post("*/api/auth/login", async ({ request }) => {
        const { message } = (await request.json()) as { message: string };
        const address = parseSiweMessage(message).address!;
        logins.push(address);
        return HttpResponse.json({ address });
      }),
    );
    useRoleStore.setState({ role: "developer", connected: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ChainSession />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(logins).toEqual([ANVIL_ACCOUNTS.developer.address]));
    act(() => useRoleStore.getState().setRole("auditor"));
    await waitFor(() => expect(logins).toEqual([ANVIL_ACCOUNTS.developer.address, ANVIL_ACCOUNTS.auditor.address]));
  });

  it("does nothing without a chain", async () => {
    let called = false;
    server.use(
      http.post("*/api/auth/login", () => {
        called = true;
        return HttpResponse.json({});
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ChainSession />
      </QueryClientProvider>,
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(called).toBe(false);
  });
});
