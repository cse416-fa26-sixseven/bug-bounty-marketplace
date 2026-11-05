import { keccak256, numberToHex, toHex, type Address, type EIP1193Provider, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Listener = (...args: unknown[]) => void;

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/**
 * An in-memory EIP-1193 provider (window.ethereum) for tests: one account
 * backed by a private key, a current chain, the chains it knows, and the
 * requests it saw. Nothing reaches a network. `reject` makes a method fail
 * as if the user clicked Reject (4001).
 */
export function fakeEthereum(options: { key: Hex; chainId: number; knownChains?: number[] }) {
  const account = privateKeyToAccount(options.key);
  const listeners = new Map<string, Set<Listener>>();
  const state = {
    chainId: options.chainId,
    authorized: false,
    known: new Set(options.knownChains ?? [1, options.chainId]),
    /** Methods that fail with 4001. */
    reject: new Set<string>(),
    /** wallet_switchEthereumChain resolves but leaves the chain unchanged. */
    ignoreSwitch: false,
    calls: [] as { method: string; params: unknown[] }[],
    sent: [] as Record<string, string>[],
  };

  function emit(event: string, ...args: unknown[]) {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  }

  async function request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
    state.calls.push({ method, params });
    if (state.reject.has(method)) throw rpcError(4001, "User rejected the request.");
    switch (method) {
      case "eth_requestAccounts":
        state.authorized = true;
        return [account.address.toLowerCase()];
      case "eth_accounts":
        return state.authorized ? [account.address.toLowerCase()] : [];
      case "eth_chainId":
        return numberToHex(state.chainId);
      case "wallet_switchEthereumChain": {
        const id = Number((params[0] as { chainId: string }).chainId);
        if (!state.known.has(id)) throw rpcError(4902, `Unrecognized chain ID ${id}`);
        if (state.ignoreSwitch) return null;
        state.chainId = id;
        emit("chainChanged", numberToHex(id));
        return null;
      }
      case "wallet_addEthereumChain": {
        const id = Number((params[0] as { chainId: string }).chainId);
        state.known.add(id);
        state.chainId = id;
        emit("chainChanged", numberToHex(id));
        return null;
      }
      case "personal_sign": {
        const [data, from] = params as [Hex, Address];
        if (from.toLowerCase() !== account.address.toLowerCase()) throw rpcError(4100, "unknown account");
        return account.signMessage({ message: { raw: data } });
      }
      case "eth_call":
        return "0x";
      case "eth_blockNumber":
        return "0x10";
      case "eth_sendTransaction": {
        state.sent.push(params[0] as Record<string, string>);
        return keccak256(toHex(`tx-${state.sent.length}`));
      }
      case "eth_getTransactionReceipt": {
        const hash = params[0] as Hex;
        const index = state.sent.findIndex((_, i) => keccak256(toHex(`tx-${i + 1}`)) === hash);
        if (index < 0) return null;
        const tx = state.sent[index]!;
        return {
          transactionHash: hash,
          transactionIndex: "0x0",
          blockHash: keccak256(toHex("block")),
          blockNumber: "0x10",
          from: tx.from,
          to: tx.to,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          effectiveGasPrice: "0x1",
          contractAddress: null,
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          type: "0x2",
        };
      }
      default:
        throw rpcError(-32601, `fake wallet does not support ${method}`);
    }
  }

  const provider = {
    request,
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
    },
  } as unknown as EIP1193Provider;

  return { provider, account, state, emit };
}

/** Installs `provider` as window.ethereum; returns a function that removes it. */
export function installEthereum(provider: EIP1193Provider | undefined): () => void {
  const target = window as Window & { ethereum?: EIP1193Provider };
  target.ethereum = provider;
  return () => {
    delete target.ethereum;
  };
}
