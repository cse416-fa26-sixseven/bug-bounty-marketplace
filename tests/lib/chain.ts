import { ChainInfoSchema, auditorStakingAbi, bountyEscrowAbi } from "@bbm/shared";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  parseEther,
  toBytes,
  toHex,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "./env.js";

/** Helpers for the chain-mode integration tier (integration/chain-flows):
 * anvil accounts, SIWE sign-in with a cookie jar, and user transactions. */

/** anvil's well-known dev accounts, the same keys as
 * apps/web/src/lib/chain/accounts.ts. Local chain only. */
export const ANVIL_KEYS = {
  /** #0: deployer, operator and arbiter. */
  arbiter: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  developer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  auditor: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
} as const satisfies Record<string, Hex>;

export const ANVIL_ACCOUNTS = {
  arbiter: privateKeyToAccount(ANVIL_KEYS.arbiter),
  developer: privateKeyToAccount(ANVIL_KEYS.developer),
  auditor: privateKeyToAccount(ANVIL_KEYS.auditor),
};

/** The operator signs as the API does (anvil #0). */
export const OPERATOR = ANVIL_ACCOUNTS.arbiter;

export const anvil: Chain = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.rpcUrl] } },
});

export const publicClient: PublicClient = createPublicClient({
  chain: anvil,
  transport: http(env.rpcUrl),
});

/** On-chain key of an API id: keccak256 of its bytes (apps/api/src/chain/ids.ts). */
export function onchainId(apiId: string): Hex {
  return keccak256(toBytes(apiId));
}

/** A fresh wallet with `eth` ETH (anvil_setBalance), so each test acts as its
 * own developer/auditor and reruns on the same stack never collide (an
 * auditor holds one claim at a time). */
export async function freshAccount(eth = "10"): Promise<PrivateKeyAccount> {
  const account = privateKeyToAccount(generatePrivateKey());
  await publicClient.request({
    method: "anvil_setBalance" as never,
    params: [account.address, toHex(parseEther(eth))] as never,
  });
  return account;
}

export interface ChainAddresses {
  auditorStaking: Address;
  bountyEscrow: Address;
  disputeResolution: Address;
  arbiter: Address;
  challengeWindowSeconds: number;
  requiredStakeWei: bigint;
}

/** Addresses from GET /api/chain, so the tests use exactly what the API was
 * started with (works for the CI bind mount and stack:demo's named volume). */
export async function chainAddresses(apiUrl: string): Promise<ChainAddresses> {
  const res = await fetch(`${apiUrl}/api/chain`);
  if (!res.ok) throw new Error(`GET /api/chain: HTTP ${res.status}`);
  const info = ChainInfoSchema.parse(await res.json());
  if (!info.configured) throw new Error(`the API at ${apiUrl} has no chain configured`);
  return {
    auditorStaking: info.addresses.auditorStaking as Address,
    bountyEscrow: info.addresses.bountyEscrow as Address,
    disputeResolution: info.addresses.disputeResolution as Address,
    arbiter: info.arbiter as Address,
    challengeWindowSeconds: info.challengeWindowSeconds,
    requiredStakeWei: BigInt(info.requiredStakeWei),
  };
}

/** Sends a contract write from `account` and waits for a successful receipt. */
export async function write(
  account: PrivateKeyAccount,
  request: {
    address: Address;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
    value?: bigint;
  },
): Promise<Hash> {
  const wallet = createWalletClient({ account, chain: anvil, transport: http(env.rpcUrl) });
  // Simulate first so a revert surfaces with its decoded reason.
  const { request: simulated } = await publicClient.simulateContract({
    ...request,
    account,
  } as never);
  const hash = await wallet.writeContract(simulated as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${request.functionName} reverted (${hash})`);
  return hash;
}

/** BountyEscrow.fund(keccak(contractId), deadline) with `amount` wei. */
export function fund(
  account: PrivateKeyAccount,
  escrow: Address,
  contractId: string,
  amount: bigint,
  deadline: Date,
): Promise<Hash> {
  return write(account, {
    address: escrow,
    abi: bountyEscrowAbi,
    functionName: "fund",
    args: [onchainId(contractId), BigInt(Math.floor(deadline.getTime() / 1000))],
    value: amount,
  });
}

/** AuditorStaking.stake() with `amount` wei. */
export function stake(account: PrivateKeyAccount, staking: Address, amount: bigint): Promise<Hash> {
  return write(account, {
    address: staking,
    abi: auditorStakingAbi,
    functionName: "stake",
    value: amount,
  });
}

export async function readStaking(
  staking: Address,
  functionName: "stakeOf" | "activeSubmissions",
  auditor: Address,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: staking,
    abi: auditorStakingAbi,
    functionName,
    args: [auditor],
  })) as bigint;
}

/** The chain's latest block timestamp. */
export async function chainNow(): Promise<number> {
  const block = await publicClient.getBlock({ blockTag: "latest" });
  return Number(block.timestamp);
}

/** Moves anvil's clock forward and mines a block (permanent for the stack). */
export async function increaseTime(seconds: number): Promise<void> {
  await publicClient.request({
    method: "evm_increaseTime" as never,
    params: [toHex(seconds)] as never,
  });
  await publicClient.request({ method: "evm_mine" as never, params: [] as never });
}

/** A signed-in client: keeps the API's session cookie like a browser would. */
export class Session {
  private cookie: string | null = null;

  constructor(
    readonly apiUrl: string,
    readonly account: PrivateKeyAccount,
  ) {}

  get address(): Address {
    return this.account.address;
  }

  /** fetch against the API with the cookie jar. Picks up Set-Cookie (a
   * Max-Age=0 cookie empties the jar). */
  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    const res = await fetch(`${this.apiUrl}${path}`, { ...init, headers });
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";").map((part) => part.trim());
      const cleared = attrs.some((attr) => /^max-age=0$/i.test(attr)) || pair?.endsWith("=");
      this.cookie = cleared ? null : (pair ?? null);
    }
    return res;
  }

  async json<T = unknown>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ status: number; body: T }> {
    const res = await this.fetch(path, init);
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  postJson<T = unknown>(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.json<T>(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  /** The raw session cookie, for replaying it outside the jar. */
  get rawCookie(): string | null {
    return this.cookie;
  }

  /** POST /api/auth/nonce: the SIWE message to sign. */
  async nonce(
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: { message?: string; nonce?: string; error?: string } }> {
    return this.postJson("/api/auth/nonce", { address: this.address }, headers);
  }

  /** POST /api/auth/login with a signed message. */
  login(message: string, signature: Hex, headers: Record<string, string> = {}) {
    return this.postJson<{ address?: string; error?: string }>(
      "/api/auth/login",
      { message, signature },
      headers,
    );
  }

  /** nonce -> sign -> login, as scripts/demo-lifecycle.sh `sign_in` does.
   * Throws unless the API accepts it. */
  async signIn(): Promise<this> {
    const issued = await this.nonce();
    if (issued.status !== 200 || !issued.body.message) {
      throw new Error(`nonce failed: ${issued.status} ${JSON.stringify(issued.body)}`);
    }
    const signature = await this.account.signMessage({ message: issued.body.message });
    const res = await this.login(issued.body.message, signature);
    if (res.status !== 200 || !this.cookie) {
      throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return this;
  }
}

/** Signs in a fresh session for `account`. */
export function signIn(apiUrl: string, account: PrivateKeyAccount): Promise<Session> {
  return new Session(apiUrl, account).signIn();
}

/** Polls `read` until `done` holds, or throws after `timeoutMs` with the last
 * value seen. For indexer and analysis latency. */
export async function pollUntil<T>(
  label: string,
  read: () => Promise<T>,
  done: (value: T) => boolean,
  { timeoutMs = 30_000, intervalMs = 1_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (done(last)) return last;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${label}: not reached within ${timeoutMs} ms (last: ${JSON.stringify(last)}${
      lastError ? `, error: ${String(lastError)}` : ""
    })`,
  );
}
