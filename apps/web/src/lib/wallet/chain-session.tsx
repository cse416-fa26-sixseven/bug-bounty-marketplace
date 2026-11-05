"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { signIn } from "@/lib/api/auth";
import { ANVIL_ACCOUNTS } from "@/lib/chain/accounts";
import { isInjectedChain, isLocalChain, useChainInfo } from "@/lib/chain/config";
import { useRoleStore } from "@/lib/role/store";
import { restoreInjected, watchInjected } from "./injected";

/**
 * Keeps the API session in step with who is signing. Renders nothing.
 *
 * - Local chain: signs in with the selected role's anvil account on load and
 *   on every role switch, then refetches so pages show that account's data.
 * - Injected wallet (another chain): restores a still-valid session for the
 *   wallet's shared account without prompting, and follows accountsChanged /
 *   chainChanged. Signing in is the user's Connect click.
 */
export function ChainSession() {
  const info = useChainInfo();
  const role = useRoleStore((s) => s.role);
  const queryClient = useQueryClient();
  const local = isLocalChain(info);

  useEffect(() => {
    if (!local) return;
    let cancelled = false;
    void signIn(ANVIL_ACCOUNTS[role])
      .then(() => {
        if (!cancelled) return queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "chain" });
      })
      .catch((err: unknown) => console.error("sign-in failed", err));
    return () => {
      cancelled = true;
    };
  }, [local, role, queryClient]);

  useEffect(() => {
    if (!isInjectedChain(info)) return;
    const refetch = () => void queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== "chain" });
    void restoreInjected(info)
      .then(refetch)
      .catch((err: unknown) => console.error("wallet restore failed", err));
    return watchInjected(info, refetch);
  }, [info, queryClient]);

  return null;
}
