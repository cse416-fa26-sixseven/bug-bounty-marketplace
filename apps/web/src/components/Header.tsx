"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { RoleSwitcher } from "./RoleSwitcher";
import { WalletBadge } from "./WalletBadge";
import { Icon } from "./Icon";
import { useRoleStore } from "@/lib/role/store";
import { isLocalChain, useChainInfo } from "@/lib/chain/config";
import { isMockingEnabled } from "@/lib/mocking";
const links = [
  { href: "/", label: "Overview", icon: "grid" },
  { href: "/contracts", label: "My contracts", icon: "code", role: "developer" },
  { href: "/auditor", label: "Audit workspace", icon: "search", role: "auditor" },
  { href: "/arbiter", label: "Disputes", icon: "scales", role: "arbiter" },
  { href: "/guide", label: "Getting started", icon: "book" },
] as const;
export function Header() {
  const onChain = isLocalChain(useChainInfo());
  const pathname = usePathname();
  const setRole = useRoleStore((s) => s.setRole);
  const current = links.find((item) =>
    item.href === "/" ? pathname === "/" : pathname.startsWith(item.href),
  );
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/" className="brand">
          <span className="brand-mark">
            <Icon name="shield" size={26} />
          </span>
          <span>
            Bounty<span className="brand-light">Guard</span>
            <small>SMART CONTRACT SECURITY</small>
          </span>
        </Link>
        <div className="workspace-label">
          <span className="workspace-avatar">67</span>
          <div>
            SIXSEVEN workspace<small>Bug bounty marketplace</small>
          </div>
        </div>
        <p className="nav-caption">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={current?.href === link.href ? "page" : undefined}
              className={`nav-item ${current?.href === link.href ? "active" : ""}`}
              onClick={() => {
                if ("role" in link) setRole(link.role);
              }}
            >
              <Icon name={link.icon} />
              {link.label}
              {current?.href === link.href && <span className="nav-dot" />}
            </Link>
          ))}
        </nav>
        <Link
          href="/submit"
          className="button-primary sidebar-submit"
          onClick={() => setRole("developer")}
        >
          <Icon name="plus" size={17} /> New bounty
        </Link>
        <div className="sidebar-bottom">
          <Icon name="shield" size={25} />
          <strong>Security starts with proof.</strong>
          <p>
            AI surfaces the risks.
            <br />
            Researchers verify them.
          </p>
          <Link href="/guide">
            Explore the workflow <span aria-hidden>↗</span>
          </Link>
        </div>
        <div className="sidebar-footer">
          <span className="live-dot" /> Frontend MVP <span>v0.2</span>
        </div>
      </aside>
      <header className="topbar">
        <div className="breadcrumb">
          Workspace <span>/</span>{" "}
          <strong>
            {pathname === "/submit" ? "New bounty" : (current?.label ?? "Contract details")}
          </strong>
        </div>
        <div className="topbar-controls">
          <RoleSwitcher />
          <WalletBadge />
        </div>
      </header>
      {(onChain || isMockingEnabled()) && (
        <div className="demo-banner">
          <span className="live-dot" />
          {onChain ? (
            <>
              <strong>Local test chain</strong>
              <span>Transactions are real on a local Anvil network; no real funds.</span>
            </>
          ) : (
            <>
              <strong>Demo environment</strong>
              <span>Wallets, analysis, stakes, and payouts are simulated. Data resets on reload.</span>
            </>
          )}
          <Link href="/guide">
            How it works <span aria-hidden>↗</span>
          </Link>
        </div>
      )}
    </>
  );
}
