"use client";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { developerApi, auditorApi, arbiterApi } from "@/lib/api";
import { Icon } from "@/components/Icon";
import { StatusBadge } from "@/components/StatusBadge";
import { useRoleStore } from "@/lib/role/store";
import { isOnChain, useChainInfo } from "@/lib/chain/config";

export default function HomePage() {
  const setRole = useRoleStore((s) => s.setRole);
  const onChain = isOnChain(useChainInfo());
  const contracts = useQuery({
    queryKey: ["overview-contracts"],
    queryFn: () => developerApi.listContracts(),
    refetchInterval: 3000,
  });
  const queue = useQuery({
    queryKey: ["auditor-queue", "newest"],
    queryFn: () => auditorApi.listQueue({ sort: "newest" }),
    refetchInterval: 3000,
  });
  const disputes = useQuery({
    queryKey: ["arbiter", "disputes", "Pending"],
    queryFn: () => arbiterApi.listDisputes({ ruling: "Pending" }),
    refetchInterval: 3000,
  });
  const items = contracts.data ?? [];
  const metrics = [
    {
      label: "Total contracts",
      value: contracts.data?.length,
      sub: onChain ? "Across your workspace" : "Across your demo workspace",
      icon: "code",
    },
    {
      label: "Open for audit",
      value: queue.data?.length,
      sub: "Ready for a researcher",
      icon: "search",
    },
    {
      label: "Resolved contracts",
      value: contracts.data ? items.filter((c) => c.status === "Resolved").length : undefined,
      sub: "Completed bounty lifecycles",
      icon: "shield",
    },
    {
      label: "Open disputes",
      value: disputes.data?.length,
      sub: "Awaiting an arbiter ruling",
      icon: "scales",
    },
  ] as const;
  return (
    <div className="dashboard">
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR SECURITY WORKSPACE</p>
          <h1>Overview</h1>
          <p>Better code. Verified findings. More secure contracts.</p>
        </div>
        <Link className="button-primary" href="/submit" onClick={() => setRole("developer")}>
          <Icon name="plus" size={17} />
          Create a bounty
        </Link>
      </div>
      <section className="hero-panel">
        <div className="hero-copy">
          <span className="hero-tag">
            <span className="live-dot" /> BUILT FOR PROOF, NOT PROMISES
          </span>
          <h2>
            Find the risk.
            <br />
            <span>Reward the research.</span>
          </h2>
          <p>
            Bring your smart contracts into the open. Pair AI-assisted analysis with human expertise
            to turn potential risks into verified results.
          </p>
          <Link href="/auditor" className="button-primary" onClick={() => setRole("auditor")}>
            Explore audit workspace <Icon name="arrow" size={17} />
          </Link>
          <Link href="/guide" className="hero-secondary">
            See how it works ↗
          </Link>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="shield-core">
            <Icon name="shield" size={96} />
          </div>
          <span className="art-label art-label-top">
            <span className="live-dot" /> Static analysis
          </span>
          <span className="art-label art-label-bottom">
            <Icon name="code" size={16} /> Proof of concept
          </span>
          <div className="art-cross cross-one">+</div>
          <div className="art-cross cross-two">+</div>
        </div>
      </section>
      <section className="metrics-grid" aria-label="Workspace statistics">
        {metrics.map((metric) => (
          <article className="metric-card" key={metric.label}>
            <div>
              <span>{metric.label}</span>
              <Icon name={metric.icon} size={18} />
            </div>
            <strong>{metric.value ?? "—"}</strong>
            <p>{metric.sub}</p>
          </article>
        ))}
      </section>
      <div className="dashboard-columns">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recent contracts</h2>
              <p>Your latest security reviews, in one place.</p>
            </div>
            <Link href="/contracts" onClick={() => setRole("developer")}>
              View all <span aria-hidden>↗</span>
            </Link>
          </div>
          {contracts.isLoading ? (
            <div className="empty-state" role="status">
              Loading your workspace…
            </div>
          ) : contracts.isError ? (
            <div className="empty-state" role="alert">
              Could not load contracts.
              <button className="button-secondary" onClick={() => void contracts.refetch()}>
                Try again
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="empty-state">
              No contracts yet. <Link href="/submit">Create your first bounty →</Link>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="contract-table">
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Status</th>
                    <th>Deadline</th>
                    <th>
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[...items]
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .slice(0, 5)
                    .map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link
                            className="contract-name"
                            href={`/contracts/${c.id}`}
                            onClick={() => setRole("developer")}
                          >
                            <span className="file-icon">
                              <Icon name="code" size={18} />
                            </span>
                            <span>
                              {c.filename}
                              <small>Solidity · {c.id.replace("contract_", "#")}</small>
                            </span>
                          </Link>
                        </td>
                        <td>
                          <StatusBadge status={c.status} />
                        </td>
                        <td className="table-date">
                          {new Date(c.deadline).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </td>
                        <td>
                          <Link
                            aria-label={`View ${c.filename}`}
                            href={`/contracts/${c.id}`}
                            onClick={() => setRole("developer")}
                          >
                            ↗
                          </Link>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="panel workflow-panel">
          <div className="panel-heading">
            <div>
              <h2>From code to confidence</h2>
              <p>One transparent workflow.</p>
            </div>
            <Icon name="activity" />
          </div>
          <ol className="workflow-list">
            {[
              ["Submit & fund", "Upload Solidity and set your bounty."],
              ["Analyze & review", "Review AI-assisted security findings."],
              ["Prove & verify", "Researchers reproduce the exploit."],
              ["Resolve & reward", "Challenge a finding or release the reward."],
            ].map(([title, body], i) => (
              <li key={title}>
                <span>{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ol>
          <Link className="workflow-link" href="/guide">
            Read the demo guide <Icon name="arrow" size={16} />
          </Link>
        </section>
      </div>
      {(queue.isError || disputes.isError) && (
        <p role="alert" className="text-amber-300 text-sm">
          Some workspace statistics are unavailable. Reopen the page to retry.
        </p>
      )}
      <footer className="page-footer">
        <span>
          <Icon name="shield" size={14} /> AI advises. Reproduced exploits verify.
        </span>
        <span>Powered by Slither · Foundry · Ethereum</span>
      </footer>
    </div>
  );
}
