import { createSiweMessage } from "viem/siwe";
import type { Address } from "viem";

/** A SIWE sign-in message like the API's POST /api/auth/nonce returns. The
 * domain defaults to the page's (jsdom: localhost:3000). */
export function siweMessage(
  address: string,
  options: { nonce?: string; domain?: string; chainId?: number } = {},
): string {
  const origin =
    typeof window === "undefined" ? "http://localhost:3000" : window.location.origin;
  const domain = options.domain ?? new URL(origin).host;
  return createSiweMessage({
    domain,
    address: address as Address,
    statement: "Sign in to BountyGuard.",
    uri: `http://${domain}`,
    version: "1",
    chainId: options.chainId ?? 31337,
    nonce: options.nonce ?? "abcdef0123456789",
    issuedAt: new Date("2026-10-20T12:00:00.000Z"),
    expirationTime: new Date("2026-10-20T12:05:00.000Z"),
  });
}
