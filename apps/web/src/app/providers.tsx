"use client";

import { useState, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ChainSession } from "@/lib/wallet/chain-session";
import { isMockingEnabled } from "@/lib/mocking";

// The frontend MVP is self-contained by default; live integration is opt-in.
const MOCKING_ENABLED = isMockingEnabled();

// ssr:false keeps `msw/browser` (and its "browser"-only export condition)
// entirely out of the server/SSR compilation graph - see mocks/msw-provider.tsx.
const MswProvider = dynamic(() => import("@/mocks/msw-provider").then((mod) => mod.MswProvider), {
  ssr: false,
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      {MOCKING_ENABLED ? (
        <MswProvider>
          <ChainSession />
          {children}
        </MswProvider>
      ) : (
        <>
          <ChainSession />
          {children}
        </>
      )}
    </QueryClientProvider>
  );
}
