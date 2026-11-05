"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { developerApi } from "@/lib/api";
import { useWallet } from "@/lib/wallet";
import { isOnChain, useChainInfo } from "@/lib/chain/config";
import { Icon } from "@/components/Icon";
import { StatusBadge } from "@/components/StatusBadge";
export default function ContractsPage() {
  const wallet = useWallet();
  const onChain = isOnChain(useChainInfo());
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("All");
  const query = useQuery({
    queryKey: ["contracts", wallet.address],
    queryFn: () => developerApi.listContracts({ developerAddress: wallet.address ?? undefined }),
    enabled: Boolean(wallet.address),
    refetchInterval: 3000,
  });
  const contracts = (query.data ?? [])
    .filter(
      (c) =>
        c.filename.toLowerCase().includes(search.toLowerCase()) &&
        (status === "All" || c.status === status),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <div>
      <div className="page-heading">
        <div>
          <p className="eyebrow">DEVELOPER WORKSPACE</p>
          <h1>Your contracts</h1>
          <p>Track your submissions, review findings, and manage bounty lifecycles.</p>
        </div>
        <Link className="button-primary" href="/submit">
          <Icon name="plus" size={17} />
          New bounty
        </Link>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>
            Contract portfolio <span className="text-slate-500">· {query.data?.length ?? 0}</span>
          </h2>
          <span className="text-xs text-slate-400">Updates automatically</span>
        </div>
        <div className="filter-bar">
          <label className="search-field">
            <Icon name="search" size={16} />
            <input
              aria-label="Search contracts"
              placeholder="Search by contract name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            {["All", "Open", "Claimed", "Resolved", "Expired"].map((s) => (
              <option key={s} value={s}>
                {s === "All" ? "All statuses" : s}
              </option>
            ))}
          </select>
        </div>
        {!wallet.address ? (
          <div className="empty-state">
            <Icon name="shield" size={32} />
            <h2>Connect your {onChain ? "wallet" : "demo wallet"}</h2>
            <p>Your contracts will appear once you connect.</p>
            <button className="button-primary" onClick={() => void wallet.connect()}>
              Connect wallet
            </button>
          </div>
        ) : query.isLoading ? (
          <div className="empty-state" role="status">
            Loading contracts…
          </div>
        ) : query.isError ? (
          <div className="empty-state" role="alert">
            <p>Unable to load your contracts.</p>
            <button className="button-secondary" onClick={() => void query.refetch()}>
              Try again
            </button>
          </div>
        ) : contracts.length === 0 ? (
          <div className="empty-state">
            <Icon name="code" size={36} />
            <h2>
              {search || status !== "All"
                ? "No matching contracts"
                : "Your next security review starts here"}
            </h2>
            <p>
              {search || status !== "All"
                ? "Try a different name or status."
                : "Upload a Solidity file to create your first bounty."}
            </p>
            <Link href="/submit">Submit a contract →</Link>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="contract-table">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Deadline</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/contracts/${c.id}`} className="contract-name">
                        <span className="file-icon">
                          <Icon name="code" size={19} />
                        </span>
                        <span>
                          {c.filename}
                          <small>{c.id} · Solidity</small>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td className="table-date">{new Date(c.createdAt).toLocaleDateString()}</td>
                    <td className="table-date">{new Date(c.deadline).toLocaleDateString()}</td>
                    <td>
                      <Link href={`/contracts/${c.id}`} aria-label={`View ${c.filename}`}>
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
    </div>
  );
}
