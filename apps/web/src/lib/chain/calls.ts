import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hash,
} from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  auditorStakingAbi,
  bountyEscrowAbi,
  disputeResolutionAbi,
  type ChainInfo,
} from "@bbm/shared";
import { onchainId } from "./ids";

/** GET /api/chain for a configured chain (local anvil or a testnet). */
export type ConfiguredChainInfo = Extract<ChainInfo, { configured: true }>;
/** The same shape; named for the local anvil chain the demo keys live on. */
export type LocalChainInfo = ConfiguredChainInfo;

/** A transaction the user signs. */
export interface ContractWrite {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/** What chainCalls needs from a chain client; tests pass a fake. */
export interface TxClient {
  /** Throws ChainTxError with the revert reason when the call would revert. */
  simulate(request: ContractWrite): Promise<void>;
  write(request: ContractWrite): Promise<Hash>;
  /** True when the transaction's receipt says it succeeded. */
  waitForSuccess(hash: Hash): Promise<boolean>;
  /** Calls a view function. */
  read(request: Omit<ContractWrite, "value">): Promise<unknown>;
}

/** BountyEscrow.BountyState, in the contract's order. */
export const BOUNTY_STATE = { None: 0, Open: 1, Paid: 2, Closed: 3 } as const;

/** A bounty as BountyEscrow stores it under a contract's id. */
export interface OnchainBounty {
  developer: Address;
  /** One of BOUNTY_STATE. */
  state: number;
}

/** Plain-English text for the contracts' custom errors users can hit. */
const READABLE_REVERTS: Record<string, string> = {
  PastDeadline: "The deadline has already passed on the chain. Pick a later deadline.",
  BountyExists: "This contract already has a bounty on-chain.",
  BountyNotOpen: "This bounty is no longer open on-chain.",
  HasSubmissions: "This bounty already has a PoC submission, so it can’t be cancelled.",
  FrozenBounty: "This bounty is frozen by an open dispute.",
  AlreadyVerified: "A finding on this bounty is already verified, so it can’t be refunded.",
  RefundNotDue:
    "The refund isn’t available yet: it opens shortly after the deadline. Try again in a minute.",
  NotDeveloper: "Only the developer who funded this bounty can do that.",
  NotArbiter: "Only the arbiter can rule on disputes.",
  ChallengeWindowClosed:
    "The challenge window has closed, so this finding can no longer be disputed.",
  DisputeNotFound: "There is no open dispute on-chain for this finding.",
  RulingWindowClosed: "The ruling window for this dispute has closed.",
  NothingToWithdraw: "There is no payout to withdraw.",
  InsufficientStake: "Your stake is below the amount this action needs.",
  ActiveSubmissions:
    "Your stake is locked by an active claim or a finding still awaiting its verdict, payout or ruling.",
  ZeroAmount: "Enter an amount greater than zero.",
};

/** A user transaction that reverted or could not be sent. `reason` is the
 * contract's error name or viem's short message; `message` is readable text
 * for the UI. */
export class ChainTxError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(READABLE_REVERTS[reason] ?? reason);
    this.name = "ChainTxError";
    this.reason = reason;
  }
}

/** The revert's error name, or viem's short message, for ChainTxError. */
export function reasonOf(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? revert.shortMessage;
    }
    return err.shortMessage;
  }
  return err instanceof Error ? err.message : String(err);
}

/** viem clients on the API-described chain, signing with `account`. */
export function viemTxClient(info: LocalChainInfo, account: PrivateKeyAccount): TxClient {
  if (!info.rpcUrl) throw new ChainTxError("the API did not publish a chain RPC URL");
  const chain = defineChain({
    id: info.chainId,
    name: "Local chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [info.rpcUrl] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(info.rpcUrl) });
  const walletClient = createWalletClient({ chain, transport: http(info.rpcUrl), account });
  return {
    async simulate(request) {
      try {
        await publicClient.simulateContract({ ...request, account } as never);
      } catch (err) {
        throw new ChainTxError(reasonOf(err));
      }
    },
    async write(request) {
      try {
        return await walletClient.writeContract({ ...request, account, chain } as never);
      } catch (err) {
        throw new ChainTxError(reasonOf(err));
      }
    },
    async waitForSuccess(hash) {
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      return receipt.status === "success";
    },
    async read(request) {
      return publicClient.readContract(request as never);
    },
  };
}

/**
 * The lifecycle transactions users sign in the browser. Each one first runs
 * `beforeSend` (the caller's check that the API session belongs to this
 * account), is simulated (so a revert shows its reason and nothing is sent),
 * then sent and awaited; it resolves only on a successful receipt. Callers
 * call the matching API route only after it resolves.
 *
 * A step that already happened on-chain (an earlier attempt whose API call
 * failed) resolves null instead of failing, so retrying the flow goes straight
 * on to the API call. `onSent` hears each confirmed transaction's hash (the
 * explorer link the UI shows).
 *
 * `client` is viemTxClient (an anvil key) or injectedTxClient (MetaMask).
 */
export function chainCalls(
  info: ConfiguredChainInfo,
  client: TxClient,
  options: { beforeSend?: () => Promise<void>; onSent?: (hash: Hash) => void } = {},
) {
  const auditorStaking = info.addresses.auditorStaking as Address;
  const bountyEscrow = info.addresses.bountyEscrow as Address;
  const disputeResolution = info.addresses.disputeResolution as Address;

  async function readBounty(contractId: string): Promise<OnchainBounty> {
    const bounty = (await client.read({
      address: bountyEscrow,
      abi: bountyEscrowAbi as Abi,
      functionName: "bounties",
      args: [onchainId(contractId)],
    })) as readonly unknown[];
    return { developer: bounty[0] as Address, state: Number(bounty[3]) };
  }

  async function bountyState(contractId: string): Promise<number> {
    return (await readBounty(contractId)).state;
  }

  /** Sends `request`. When the simulation reverts with one of `doneErrors`
   * and `isDone` (if given) confirms it, the step already happened: null. */
  async function send(
    request: ContractWrite,
    doneErrors: readonly string[] = [],
    isDone: () => Promise<boolean> = async () => true,
  ): Promise<Hash | null> {
    await options.beforeSend?.();
    try {
      await client.simulate(request);
    } catch (err) {
      if (err instanceof ChainTxError && doneErrors.includes(err.reason) && (await isDone()))
        return null;
      throw err;
    }
    const hash = await client.write(request);
    if (!(await client.waitForSuccess(hash))) throw new ChainTxError("transaction reverted");
    options.onSent?.(hash);
    return hash;
  }

  const closed = (contractId: string) => async () =>
    (await bountyState(contractId)) === BOUNTY_STATE.Closed;

  return {
    /** Funds the contract's bounty from `developer`'s wallet. A bounty that
     * already exists counts as done only when `developer` funded it: one
     * another wallet funded under this id fails with BountyExists. */
    fundBounty: (contractId: string, deadline: Date, amountWei: string, developer: string) =>
      send(
        {
          address: bountyEscrow,
          abi: bountyEscrowAbi as Abi,
          functionName: "fund",
          args: [onchainId(contractId), BigInt(Math.floor(deadline.getTime() / 1000))],
          value: BigInt(amountWei),
        },
        ["BountyExists"],
        async () =>
          (await readBounty(contractId)).developer.toLowerCase() === developer.toLowerCase(),
      ),
    /** Who funded the bounty under the contract's id, and its state. */
    readBounty,
    stake: (amountWei: string) =>
      send({
        address: auditorStaking,
        abi: auditorStakingAbi as Abi,
        functionName: "stake",
        args: [],
        value: BigInt(amountWei),
      }),
    openDispute: (contractId: string, findingId: string, reason: string) =>
      send(
        {
          address: disputeResolution,
          abi: disputeResolutionAbi as Abi,
          functionName: "openDispute",
          args: [onchainId(contractId), onchainId(findingId), reason],
        },
        ["DisputeExists"],
      ),
    rule: (contractId: string, findingId: string, auditorWon: boolean) =>
      send(
        {
          address: disputeResolution,
          abi: disputeResolutionAbi as Abi,
          functionName: "rule",
          args: [onchainId(contractId), onchainId(findingId), auditorWon],
        },
        ["AlreadyResolved"],
      ),
    deleteBounty: (contractId: string) =>
      send(
        {
          address: bountyEscrow,
          abi: bountyEscrowAbi as Abi,
          functionName: "deleteBounty",
          args: [onchainId(contractId)],
        },
        ["BountyNotOpen"],
        closed(contractId),
      ),
    refund: (contractId: string) =>
      send(
        {
          address: bountyEscrow,
          abi: bountyEscrowAbi as Abi,
          functionName: "refund",
          args: [onchainId(contractId)],
        },
        ["BountyNotOpen"],
        closed(contractId),
      ),
    /** AuditorStaking.withdraw: reverts while any claim or finding holds a lock. */
    withdrawStake: (amountWei: string) =>
      send({
        address: auditorStaking,
        abi: auditorStakingAbi as Abi,
        functionName: "withdraw",
        args: [BigInt(amountWei)],
      }),
    withdrawPayout: () =>
      send({
        address: bountyEscrow,
        abi: bountyEscrowAbi as Abi,
        functionName: "withdrawPayout",
        args: [],
      }),
  };
}

export type ChainCalls = ReturnType<typeof chainCalls>;
