"use client";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { useRoleStore } from "@/lib/role/store";
import { isLocalChain, isOnChain, useChainInfo } from "@/lib/chain/config";
import { networkName } from "@/lib/chain/networks";
import { weiToEth } from "@/lib/money";

/** Steps on the local chain, where analysis, the sandbox and payouts are real. */
function chainGuides(stakeEth: string, windowSeconds: number) {
  return [
    {
      ...guides[0],
      steps: [
        "Upload a .sol file up to 100 KB, choose a bounty and a future deadline, and fund it from your developer account.",
        "Open the contract: Slither findings with AI explanations appear in under a minute. Explanations are advisory.",
        `When a PoC is verified you have ${windowSeconds} seconds to dispute it on-chain; otherwise the bounty is paid out.`,
      ],
    },
    {
      ...guides[1],
      steps: [
        "Claim an open, funded contract exclusively for 10 minutes. You hold one claim at a time.",
        `Stake ${stakeEth} ETH from your auditor account to unlock PoC uploads.`,
        "Upload a Foundry .t.sol test that imports the target as ../src/<filename>. It runs in an isolated sandbox; a passing test verifies the finding.",
      ],
    },
    {
      ...guides[2],
      steps: [
        "Open a pending dispute and read the developer’s reason alongside the original finding.",
        "Check the proof of concept and the sandbox result.",
        "Rule for the auditor to release the payout, or against them to reject the finding and slash half their stake.",
      ],
    },
  ];
}

const guides = [
  {
    role: "developer",
    title: "Protect your contracts",
    icon: "code",
    href: "/submit",
    action: "Create a bounty",
    steps: [
      "Upload a .sol file up to 100 KB, choose a positive bounty, and set a future deadline.",
      "Open the contract to see simulated findings appear after about 3 seconds. AI explanations are advisory.",
      "After a PoC is verified, you have 30 seconds in this demo to dispute it. Otherwise the simulated bounty pays automatically.",
    ],
  },
  {
    role: "auditor",
    title: "Prove the vulnerability",
    icon: "search",
    href: "/auditor",
    action: "Open audit workspace",
    steps: [
      "Claim an open contract exclusively for 10 minutes, or resume a claimed contract from your profile.",
      "Post the required demo stake to unlock PoC uploads. Stake values are simulated units.",
      "Upload a nonempty Foundry .t.sol test. The demo resolves it after about 3 seconds; it does not execute your code. You can also mark flagged findings as false positives.",
    ],
  },
  {
    role: "arbiter",
    title: "Resolve with evidence",
    icon: "scales",
    href: "/arbiter",
    action: "Review disputes",
    steps: [
      "Open a pending dispute and read the developer’s reason alongside the original finding.",
      "Inspect the proof-of-concept reference and simulated sandbox log.",
      "Rule for the auditor to release payment, or against the auditor to reject the finding and slash the demo stake.",
    ],
  },
] as const;
export default function GuidePage() {
  const chainInfo = useChainInfo();
  const setRole = useRoleStore((s) => s.setRole);
  const onChain = isOnChain(chainInfo);
  const local = isLocalChain(chainInfo);
  const chainName = onChain ? networkName(chainInfo.chainId) : "";
  const shown = onChain
    ? chainGuides(weiToEth(chainInfo.requiredStakeWei), chainInfo.challengeWindowSeconds)
    : guides;
  return (
    <div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">GETTING STARTED</p>
          <h1>Three roles. One secure workflow.</h1>
          <p>Walk through the complete bounty lifecycle with the frontend demo.</p>
          {onChain ? (
            <p className="mt-2 text-emerald-300">
              Running on {local ? "a local test chain" : `the ${chainName} testnet`}:
              findings appear in under a minute, auditors stake{" "}
              {weiToEth(chainInfo.requiredStakeWei)} ETH, the challenge window is{" "}
              {chainInfo.challengeWindowSeconds} seconds, and losing a dispute slashes half the
              auditor&apos;s stake. {local ? "No real funds are involved." : "Use test ETH only."}
            </p>
          ) : null}
        </div>
      </div>
      <div className="guide-grid">
        {shown.map((g) => (
          <section className="panel guide-card" key={g.role}>
            <Icon name={g.icon} size={29} />
            <p className="eyebrow mt-5">{g.role.toUpperCase()}</p>
            <h2>{g.title}</h2>
            <ol>
              {g.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <Link className="button-primary" href={g.href} onClick={() => setRole(g.role)}>
              {g.action}
              <Icon name="arrow" size={16} />
            </Link>
          </section>
        ))}
      </div>
      <section className="panel form-aside mt-6">
        <h2>About this MVP environment</h2>
        {local ? (
          <p>
            This app runs against the real API on a local Anvil chain. Each role signs its own
            transactions with an Anvil test account and signs in to the API with Sign-In with
            Ethereum when you switch roles. Slither, the AI explanations and the Foundry sandbox run
            for real; no real funds are involved. Data persists until the demo stack is restarted.
          </p>
        ) : onChain ? (
          <p>
            This app runs against the real API on {chainName}. Connect your
            browser wallet (MetaMask): you sign in with Sign-In with Ethereum and sign every
            transaction yourself, and your connected account is your identity in every role. The
            role selector only picks the workspace you see; rulings need the arbiter&apos;s account.
          </p>
        ) : (
          <>
            <p>
              This frontend uses a mock API and one identity per role. No real wallet is connected,
              no funds move, and analysis and sandbox outcomes are fixtures. Use the role selector
              to move between actors. Reloading the page resets the demo data and timers.
            </p>
            <p>
              The sample workspace contains an open contract, an active review, and a disputed
              finding. Real wallet authentication, private source storage, Slither, Gemini, Foundry
              execution, and on-chain settlement require backend integration.
            </p>
          </>
        )}
        <div className="flex flex-wrap gap-3 mt-5">
          <a
            className="button-secondary"
            href={onChain ? "/examples/Vault.sol" : "/examples/DemoVault.sol"}
            download
          >
            Download sample contract
          </a>
          <a
            className="button-secondary"
            href={onChain ? "/examples/VaultExploit.t.sol" : "/examples/DemoExploit.t.sol"}
            download
          >
            Download sample PoC
          </a>
        </div>
      </section>
    </div>
  );
}
