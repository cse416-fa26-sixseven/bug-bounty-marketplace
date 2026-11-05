// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { encodeFunctionData, verifyMessage, type Abi, type Address, type Hex } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { auditorStakingAbi, type ChainInfo } from "@bbm/shared";
import { server } from "@/mocks/server";
import { chainCalls } from "@/lib/chain/calls";
import { fakeEthereum, installEthereum } from "@/test/fake-ethereum";
import { siweMessage } from "@/test/siwe";
import {
  ACCOUNT_CHANGED,
  NO_WALLET,
  REJECTED,
  connectInjected,
  injectedTxClient,
  prepareInjectedSend,
  restoreInjected,
  useInjectedStore,
  watchInjected,
  wrongNetwork,
} from "../injected";

const KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const SEPOLIA: Extract<ChainInfo, { configured: true }> = {
  configured: true,
  chainId: 11155111,
  addresses: {
    auditorStaking: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    bountyEscrow: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    disputeResolution: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
  },
  arbiter: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  challengeWindowSeconds: 259200,
  requiredStakeWei: "100000000000000000",
};

/** Fake SIWE API that verifies signatures like the real one. */
function fakeAuth() {
  const state = { session: null as string | null, logins: 0 };
  server.use(
    http.post("*/api/auth/nonce", async ({ request }) => {
      const { address } = (await request.json()) as { address: string };
      return HttpResponse.json({
        nonce: "abcdef0123456789",
        message: siweMessage(address, { chainId: SEPOLIA.chainId }),
      });
    }),
    http.post("*/api/auth/login", async ({ request }) => {
      const { message, signature } = (await request.json()) as { message: string; signature: Hex };
      const { address, chainId } = parseSiweMessage(message);
      if (chainId !== SEPOLIA.chainId || !(await verifyMessage({ address: address!, message, signature }))) {
        return HttpResponse.json({ error: "bad signature" }, { status: 401 });
      }
      state.logins += 1;
      state.session = address!;
      return HttpResponse.json({ address });
    }),
    http.get("*/api/auth/me", () =>
      state.session ? HttpResponse.json({ address: state.session }) : HttpResponse.json({ error: "sign in" }, { status: 401 }),
    ),
    http.post("*/api/auth/logout", () => {
      state.session = null;
      return HttpResponse.json({ ok: true });
    }),
  );
  return state;
}

let uninstall: () => void = () => undefined;

beforeEach(() => {
  useInjectedStore.setState({ address: null, chainId: null, error: null, connecting: false });
});
afterEach(() => uninstall());

function wallet(options: { chainId?: number; knownChains?: number[] } = {}) {
  const fake = fakeEthereum({ key: KEY, chainId: options.chainId ?? 1, knownChains: options.knownChains });
  uninstall = installEthereum(fake.provider);
  return fake;
}

describe("connectInjected", () => {
  it("requests an account, switches to the API's chain and signs in with SIWE", async () => {
    const fake = wallet({ knownChains: [1, SEPOLIA.chainId] });
    const auth = fakeAuth();

    await expect(connectInjected(SEPOLIA)).resolves.toBe(fake.account.address);

    const methods = fake.state.calls.map((c) => c.method);
    expect(methods.indexOf("eth_requestAccounts")).toBeLessThan(methods.indexOf("wallet_switchEthereumChain"));
    expect(methods.indexOf("wallet_switchEthereumChain")).toBeLessThan(methods.indexOf("personal_sign"));
    expect(fake.state.calls.find((c) => c.method === "wallet_switchEthereumChain")?.params).toEqual([
      { chainId: "0xaa36a7" },
    ]);
    expect(fake.state.chainId).toBe(SEPOLIA.chainId);
    expect(auth.session).toBe(fake.account.address);
    expect(useInjectedStore.getState()).toMatchObject({ address: fake.account.address, error: null });
  });

  it("adds the chain when the wallet does not know it (4902)", async () => {
    const fake = wallet({ knownChains: [1] });
    fakeAuth();

    await connectInjected(SEPOLIA);

    const add = fake.state.calls.find((c) => c.method === "wallet_addEthereumChain");
    expect(add?.params).toEqual([
      expect.objectContaining({
        chainId: "0xaa36a7",
        chainName: "Sepolia",
        blockExplorerUrls: ["https://sepolia.etherscan.io"],
        rpcUrls: [expect.stringMatching(/^https:\/\//)],
      }),
    ]);
    expect(fake.state.chainId).toBe(SEPOLIA.chainId);
  });

  it("explains a rejected account request", async () => {
    const fake = wallet();
    fake.state.reject.add("eth_requestAccounts");
    await expect(connectInjected(SEPOLIA)).rejects.toThrow(REJECTED);
    expect(useInjectedStore.getState()).toMatchObject({ address: null, error: REJECTED, connecting: false });
  });

  it("explains a rejected sign-in signature", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    const auth = fakeAuth();
    fake.state.reject.add("personal_sign");
    await expect(connectInjected(SEPOLIA)).rejects.toThrow(REJECTED);
    expect(auth.session).toBeNull();
  });

  it("explains a wallet that stays on the wrong network", async () => {
    const fake = wallet({ knownChains: [1, SEPOLIA.chainId] });
    fake.state.ignoreSwitch = true;
    fakeAuth();
    await expect(connectInjected(SEPOLIA)).rejects.toThrow(wrongNetwork(SEPOLIA.chainId));
    expect(wrongNetwork(SEPOLIA.chainId)).toBe("Wrong network: switch your wallet to Sepolia.");
  });

  it("explains a missing wallet", async () => {
    uninstall = installEthereum(undefined);
    await expect(connectInjected(SEPOLIA)).rejects.toThrow(NO_WALLET);
  });
});

describe("restoreInjected", () => {
  it("counts an already-shared account as connected while the session is its, without prompting", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    fake.state.authorized = true;
    const auth = fakeAuth();
    auth.session = fake.account.address;

    await restoreInjected(SEPOLIA);

    expect(useInjectedStore.getState().address).toBe(fake.account.address);
    expect(fake.state.calls.map((c) => c.method)).not.toContain("eth_requestAccounts");
    expect(fake.state.calls.map((c) => c.method)).not.toContain("personal_sign");
  });

  it("leaves the wallet disconnected when the session is someone else's", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    fake.state.authorized = true;
    const auth = fakeAuth();
    auth.session = SEPOLIA.arbiter;
    await restoreInjected(SEPOLIA);
    expect(useInjectedStore.getState()).toMatchObject({ address: null, error: null });
    // Pages must not keep reading as the other account.
    expect(auth.session).toBeNull();
  });

  it("signs out a leftover session when the wallet shares no account", async () => {
    wallet({ chainId: SEPOLIA.chainId });
    const auth = fakeAuth();
    auth.session = SEPOLIA.arbiter;
    await restoreInjected(SEPOLIA);
    expect(auth.session).toBeNull();
  });

  it("reports a wallet on the wrong network", async () => {
    const fake = wallet({ chainId: 1 });
    fake.state.authorized = true;
    fakeAuth().session = fake.account.address;
    await restoreInjected(SEPOLIA);
    expect(useInjectedStore.getState()).toMatchObject({ chainId: 1, error: wrongNetwork(SEPOLIA.chainId) });
  });

  it("does not undo a connection made while it was waiting", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    fake.state.authorized = true;
    fakeAuth();
    const restoring = restoreInjected(SEPOLIA);
    useInjectedStore.setState({ address: fake.account.address });
    await restoring;
    expect(useInjectedStore.getState().address).toBe(fake.account.address);
  });
});

describe("watchInjected", () => {
  it("signs out when the wallet disconnects", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    const auth = fakeAuth();
    await connectInjected(SEPOLIA);
    const onIdentityChange = vi.fn();
    const stop = watchInjected(SEPOLIA, onIdentityChange);
    fake.emit("accountsChanged", []);
    await vi.waitFor(() => expect(onIdentityChange).toHaveBeenCalledOnce());
    expect(auth.session).toBeNull();
    expect(useInjectedStore.getState()).toMatchObject({ address: null, error: null });
    stop();
  });

  it("follows chainChanged and drops the connection on accountsChanged", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    const auth = fakeAuth();
    await connectInjected(SEPOLIA);
    const onIdentityChange = vi.fn();
    const stop = watchInjected(SEPOLIA, onIdentityChange);

    fake.emit("chainChanged", "0x1");
    expect(useInjectedStore.getState().error).toBe(wrongNetwork(SEPOLIA.chainId));
    fake.emit("chainChanged", "0xaa36a7");
    expect(useInjectedStore.getState().error).toBeNull();

    fake.emit("accountsChanged", [SEPOLIA.arbiter.toLowerCase()]);
    expect(useInjectedStore.getState()).toMatchObject({ address: null, error: ACCOUNT_CHANGED });
    // The old account's cookie is cleared before pages refetch.
    await vi.waitFor(() => expect(onIdentityChange).toHaveBeenCalledOnce());
    expect(auth.session).toBeNull();

    stop();
    fake.emit("chainChanged", "0x1");
    expect(useInjectedStore.getState().chainId).toBe(SEPOLIA.chainId);
  });
});

describe("injectedTxClient", () => {
  it("sends a write through the wallet and reports the confirmed hash", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    fakeAuth();
    const address = await connectInjected(SEPOLIA);
    const onSent = vi.fn();
    const calls = chainCalls(SEPOLIA, injectedTxClient(SEPOLIA, address, fake.provider), {
      beforeSend: () => prepareInjectedSend(SEPOLIA, address, fake.provider),
      onSent,
    });

    const hash = await calls.stake("100000000000000000");

    expect(fake.state.sent).toHaveLength(1);
    const tx = fake.state.sent[0] as { from: string; to: string; value: string };
    expect(tx.from.toLowerCase()).toBe(address.toLowerCase());
    expect(tx.to.toLowerCase()).toBe(SEPOLIA.addresses.auditorStaking.toLowerCase());
    expect(BigInt(tx.value)).toBe(100000000000000000n);
    expect(onSent).toHaveBeenCalledWith(hash);
    // Already signed in as this account: no second signature prompt.
    expect(fake.state.calls.filter((c) => c.method === "personal_sign")).toHaveLength(1);
  });

  it("withdraws stake through the wallet", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    fakeAuth();
    const address = await connectInjected(SEPOLIA);
    const calls = chainCalls(SEPOLIA, injectedTxClient(SEPOLIA, address, fake.provider), {
      beforeSend: () => prepareInjectedSend(SEPOLIA, address, fake.provider),
    });

    await calls.withdrawStake("50000000000000000");

    const tx = fake.state.sent[0] as { to: string; data: string; value?: string };
    expect(tx.to.toLowerCase()).toBe(SEPOLIA.addresses.auditorStaking.toLowerCase());
    // AuditorStaking.withdraw(uint256), no ETH attached.
    expect(tx.data).toBe(
      encodeFunctionData({ abi: auditorStakingAbi as Abi, functionName: "withdraw", args: [50000000000000000n] }),
    );
    expect(BigInt(tx.value ?? "0x0")).toBe(0n);
  });

  it("refuses to read through a wallet on another chain", async () => {
    const fake = wallet({ chainId: 1 });
    const client = injectedTxClient(SEPOLIA, null, fake.provider);
    await expect(chainCalls(SEPOLIA, client).isFunded("contract_1")).rejects.toThrow(
      wrongNetwork(SEPOLIA.chainId),
    );
    expect(fake.state.calls.map((c) => c.method)).not.toContain("eth_call");
  });

  it("explains a rejected transaction and a missing connection", async () => {
    const fake = wallet({ chainId: SEPOLIA.chainId });
    fakeAuth();
    const address = (await connectInjected(SEPOLIA)) as Address;
    fake.state.reject.add("eth_sendTransaction");
    const calls = chainCalls(SEPOLIA, injectedTxClient(SEPOLIA, address, fake.provider), {
      beforeSend: () => prepareInjectedSend(SEPOLIA, address, fake.provider),
    });
    await expect(calls.withdrawPayout()).rejects.toThrow(REJECTED);

    const disconnected = chainCalls(SEPOLIA, injectedTxClient(SEPOLIA, null, fake.provider), {
      beforeSend: () => prepareInjectedSend(SEPOLIA, null, fake.provider),
    });
    await expect(disconnected.withdrawPayout()).rejects.toThrow("Connect your wallet first.");
  });
});
