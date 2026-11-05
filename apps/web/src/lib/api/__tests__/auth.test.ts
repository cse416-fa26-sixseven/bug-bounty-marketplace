import { describe, expect, it, vi } from "vitest";
import { delay, http, HttpResponse } from "msw";
import { parseSiweMessage } from "viem/siwe";
import { server } from "@/mocks/server";
import { ANVIL_ACCOUNTS } from "@/lib/chain/accounts";
import { siweMessage } from "@/test/siwe";
import { ensureSignedIn, signIn, type MessageSigner } from "../auth";

/** Fake API sign-in: issues SIWE messages, records each completed login and,
 * like the real API, remembers the last one as the session. */
function fakeAuth(options: { slowFor?: string; messageFor?: (address: string) => string } = {}) {
  const state = {
    logins: [] as string[],
    bodies: [] as Record<string, unknown>[],
    session: null as string | null,
  };
  server.use(
    http.post("*/api/auth/nonce", async ({ request }) => {
      const { address } = (await request.json()) as { address: string };
      const message = options.messageFor?.(address) ?? siweMessage(address);
      return HttpResponse.json({ nonce: parseSiweMessage(message).nonce ?? "n", message });
    }),
    http.post("*/api/auth/login", async ({ request }) => {
      const body = (await request.json()) as { message: string };
      const address = parseSiweMessage(body.message).address!;
      if (address === options.slowFor) await delay(80);
      state.bodies.push(body);
      state.logins.push(address);
      state.session = address;
      return HttpResponse.json({ address });
    }),
    http.get("*/api/auth/me", () =>
      state.session
        ? HttpResponse.json({ address: state.session })
        : HttpResponse.json({ error: "sign in" }, { status: 401 }),
    ),
  );
  return state;
}

describe("signIn", () => {
  it("signs the API's SIWE message and sends the message with the signature", async () => {
    const state = fakeAuth();
    await signIn(ANVIL_ACCOUNTS.auditor);
    const [body] = state.bodies;
    expect(parseSiweMessage(String(body!.message)).address).toBe(ANVIL_ACCOUNTS.auditor.address);
    expect(body!.signature).toBe(
      await ANVIL_ACCOUNTS.auditor.signMessage({ message: String(body!.message) }),
    );
  });

  it("accepts any signer with an address and signMessage (an injected wallet)", async () => {
    const state = fakeAuth();
    const account = ANVIL_ACCOUNTS.developer;
    const signer: MessageSigner = {
      address: account.address.toLowerCase(),
      signMessage: vi.fn(({ message }: { message: string }) => account.signMessage({ message })),
    };
    expect(await signIn(signer)).toBe(account.address);
    expect(signer.signMessage).toHaveBeenCalledOnce();
    expect(state.logins).toEqual([account.address]);
  });

  it("refuses to sign a message for another account", async () => {
    fakeAuth({ messageFor: () => siweMessage(ANVIL_ACCOUNTS.arbiter.address) });
    const signMessage = vi.fn();
    await expect(
      signIn({ address: ANVIL_ACCOUNTS.auditor.address, signMessage }),
    ).rejects.toThrow(/another account/);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("refuses to sign a message that is not Sign-In with Ethereum", async () => {
    fakeAuth({ messageFor: (address) => `BountyGuard sign-in\nAddress: ${address}\nNonce: n` });
    const signMessage = vi.fn();
    await expect(
      signIn({ address: ANVIL_ACCOUNTS.auditor.address, signMessage }),
    ).rejects.toThrow(/sign-in message/);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("runs one sign-in at a time, so the last one requested owns the session", async () => {
    const state = fakeAuth({ slowFor: ANVIL_ACCOUNTS.developer.address });
    await Promise.all([signIn(ANVIL_ACCOUNTS.developer), signIn(ANVIL_ACCOUNTS.auditor)]);
    expect(state.logins).toEqual([
      ANVIL_ACCOUNTS.developer.address,
      ANVIL_ACCOUNTS.auditor.address,
    ]);
    expect(state.session).toBe(ANVIL_ACCOUNTS.auditor.address);
  });
});

describe("ensureSignedIn", () => {
  it("does nothing when the session is already this account's", async () => {
    const state = fakeAuth();
    state.session = ANVIL_ACCOUNTS.auditor.address.toLowerCase();
    await ensureSignedIn(ANVIL_ACCOUNTS.auditor);
    expect(state.logins).toEqual([]);
  });

  it("signs in when there is no session or it belongs to another account", async () => {
    const state = fakeAuth();
    await ensureSignedIn(ANVIL_ACCOUNTS.auditor);
    state.session = ANVIL_ACCOUNTS.developer.address;
    await ensureSignedIn(ANVIL_ACCOUNTS.auditor);
    expect(state.logins).toEqual([ANVIL_ACCOUNTS.auditor.address, ANVIL_ACCOUNTS.auditor.address]);
    expect(state.session).toBe(ANVIL_ACCOUNTS.auditor.address);
  });
});
