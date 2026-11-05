"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CONTRACT_SOURCE_MAX_BYTES } from "@bbm/shared";
import { developerApi, ApiError } from "@/lib/api";
import { useWallet } from "@/lib/wallet";
import { ethToWei, weiToEth } from "@/lib/money";
import { networkName } from "@/lib/chain/networks";
import { useChainCalls } from "@/lib/chain/use-chain";
import { isInjectedChain, isLocalChain, isOnChain, useChainInfo } from "@/lib/chain/config";

function validateFile(file: File | null): string | null {
  if (!file) return "Choose a .sol file to submit.";
  if (!file.name.toLowerCase().endsWith(".sol")) {
    return "Only .sol files are accepted.";
  }
  if (file.size === 0) return "The source file is empty.";
  if (file.size > CONTRACT_SOURCE_MAX_BYTES) {
    return "File is too large - the limit is 100 KB.";
  }
  return null;
}

export default function SubmitPage() {
  const router = useRouter();
  const wallet = useWallet();
  const chain = useChainCalls();
  const chainInfo = useChainInfo();
  const windowSeconds = isOnChain(chainInfo) ? chainInfo.challengeWindowSeconds : null;
  const stakeEth = isOnChain(chainInfo) ? weiToEth(chainInfo.requiredStakeWei) : null;
  const local = isLocalChain(chainInfo);
  const testnet = isInjectedChain(chainInfo) ? networkName(chainInfo.chainId) : null;
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [bountyAmount, setBountyAmount] = useState("1");
  const [currency, setCurrency] = useState("ETH");
  const [deadline, setDeadline] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);

  // Upload only: the bounty is funded from the contract page once the
  // analysis is done, so a contract that does not compile is never funded.
  const submitMutation = useMutation({
    mutationFn: async (terms: { deadline: string; bountyAmount: string; currency: string }) => {
      if (!wallet.address) {
        throw new Error("Connect a wallet before submitting a contract.");
      }
      const validationError = validateFile(file);
      if (validationError) {
        throw new Error(validationError);
      }
      if (!terms.deadline) {
        throw new Error("Choose a deadline.");
      }
      let bountyWei: string;
      try {
        bountyWei = ethToWei(terms.bountyAmount);
      } catch {
        throw new Error("Enter a bounty amount in ETH, up to 18 decimal places.");
      }
      if (bountyWei === "0") {
        throw new Error("Enter a bounty amount greater than zero.");
      }
      if (
        !Number.isFinite(new Date(terms.deadline).getTime()) ||
        new Date(terms.deadline).getTime() <= Date.now()
      ) {
        throw new Error("Choose a deadline in the future.");
      }
      return developerApi.submitContract({
        file: file!,
        developerAddress: wallet.address,
        bountyAmount: bountyWei,
        currency: terms.currency,
        // `datetime-local` inputs have no timezone/seconds info; normalize
        // to the full ISO 8601 string the shared Contract schema expects.
        deadline: new Date(terms.deadline).toISOString(),
      });
    },
    onSuccess: (contract) => {
      router.push(`/contracts/${contract.id}`);
    },
  });

  function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] ?? null;
    setFile(selected);
    setFileError(selected ? validateFile(selected) : null);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const validationError = validateFile(file);
    setFileError(validationError);
    if (validationError) return;
    const form = new FormData(event.currentTarget as HTMLFormElement);
    submitMutation.mutate({
      deadline: String(form.get("deadline") ?? ""),
      bountyAmount: String(form.get("bountyAmount") ?? ""),
      currency: String(form.get("currency") ?? "ETH"),
    });
  }

  const failed = submitMutation.error;
  const errorMessage =
    failed instanceof ApiError ? failed.message : failed instanceof Error ? failed.message : null;

  return (
    <div>
      <p className="eyebrow">DEVELOPER WORKSPACE / NEW BOUNTY</p>
      <h1 className="text-2xl font-semibold text-white">Submit a contract</h1>
      <p className="mt-2 text-slate-400">
        Give researchers a reason to find the risks before someone else does.
      </p>

      <div className="form-layout mt-8">
        <form onSubmit={handleSubmit} className="panel form-panel space-y-6">
          <div className="form-step">01 / CONTRACT SOURCE</div>
          <div className="upload-zone">
            <label htmlFor="file" className="block text-sm font-medium text-slate-200">
              Contract source (.sol, max 100 KB)
            </label>
            <input
              ref={fileInputRef}
              id="file"
              name="file"
              type="file"
              accept=".sol"
              onChange={handleFileChange}
              className="mt-2 block w-full text-sm text-slate-300 file:mr-4 file:rounded-md file:border-0 file:bg-emerald-500 file:px-4 file:py-2 file:text-sm file:font-medium file:text-slate-950 hover:file:bg-emerald-400"
            />
            {fileError && <p className="mt-2 text-sm text-red-400">{fileError}</p>}
            <p className="mt-3 text-xs text-slate-400">
              Single Solidity source file. Maximum size: 100 KB.
            </p>
            <a
              href={chain ? "/examples/Vault.sol" : "/examples/DemoVault.sol"}
              download
              className="mt-2 inline-block text-xs text-emerald-400"
            >
              Download a sample contract ↗
            </a>
          </div>
          <div className="form-step">02 / BOUNTY TERMS</div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label htmlFor="bountyAmount" className="block text-sm font-medium text-slate-200">
                Bounty amount
              </label>
              <input
                id="bountyAmount"
                name="bountyAmount"
                type="number"
                min="0.00000001"
                step="any"
                required
                value={bountyAmount}
                onChange={(e) => setBountyAmount(e.target.value)}
                className="mt-2 block w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              />
            </div>
            <div>
              <label htmlFor="currency" className="block text-sm font-medium text-slate-200">
                Currency
              </label>
              <select
                id="currency"
                name="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="mt-2 block w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
              >
                <option value="ETH">ETH</option>
                <option value="USDC">USDC</option>
                <option value="DAI">DAI</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="deadline" className="block text-sm font-medium text-slate-200">
              Deadline
            </label>
            <input
              id="deadline"
              name="deadline"
              type="datetime-local"
              required
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
              className="mt-2 block w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white"
            />
          </div>

          {errorMessage && (
            <p role="alert" className="text-sm text-red-400">
              {errorMessage}
            </p>
          )}
          {!wallet.address && (
            <p role="status" className="text-sm text-amber-300">
              Connect your {chain ? "wallet" : "demo wallet"} in the header before submitting.
            </p>
          )}
          <button
            type="submit"
            disabled={submitMutation.isPending || !wallet.address}
            className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitMutation.isPending ? "Submitting..." : "Submit contract"}
          </button>
        </form>
        <aside className="panel form-aside">
          <h2>What happens next?</h2>
          <p>
            <strong className="text-emerald-300">01 · Automated analysis</strong>
            <br />
            {chain
              ? "Slither findings appear in under a minute, with plain-English explanations. Once the analysis is done, fund the bounty from the contract page to list it for auditors."
              : "Simulated Slither findings appear in about 3 seconds, with plain-language explanations."}
          </p>
          <p>
            <strong className="text-emerald-300">02 · Independent review</strong>
            <br />
            {stakeEth !== null
              ? `An auditor stakes ${stakeEth} ETH, claims the contract and submits a Foundry proof of concept.`
              : "An auditor claims the contract and submits a Foundry proof of concept."}
          </p>
          <p>
            <strong className="text-emerald-300">03 · Verified resolution</strong>
            <br />
            {windowSeconds !== null
              ? `A reproduced exploit opens a ${windowSeconds}-second challenge window, then the bounty is paid on-chain.`
              : "A verified finding opens a challenge window before the simulated payout."}
          </p>
          <hr />
          <h2>Demo bounty</h2>
          <p>
            {local
              ? "After the analysis, your bounty is locked in the BountyEscrow contract on a local Anvil chain, using a dev account. No real funds are involved. A contract that fails analysis is never funded."
              : testnet
                ? `After the analysis, your bounty is locked in the BountyEscrow contract on the ${testnet} testnet, paid from your own wallet. Use test ETH only. A contract that fails analysis is never funded.`
                : "Funds and wallet actions are simulated. No real tokens are required. This session resets when you reload the page."}
          </p>
        </aside>
      </div>
    </div>
  );
}
