import { z } from "zod";
import { isAddressEqual, type Address } from "viem";
import { parseSiweMessage } from "viem/siwe";
import { ApiError, getJson, postJson } from "./http";

const NonceSchema = z.object({ nonce: z.string(), message: z.string() });
const SessionSchema = z.object({ address: z.string() });

/** What sign-in needs from a wallet: an anvil PrivateKeyAccount, or an
 * injected (MetaMask) account behind a viem wallet client. */
export interface MessageSigner {
  address: string;
  signMessage(args: { message: string }): Promise<string>;
}

// The session is one cookie, so sign-ins run one at a time: the last one
// requested is the last one to set it.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** Checks the API's Sign-In with Ethereum message before the signer sees it:
 * it must be SIWE, for this signer, and (in the browser) for this page's
 * domain. A wallet like MetaMask checks the domain too; an in-browser anvil
 * key does not, so this is its only check. */
function checkMessage(message: string, signer: MessageSigner): void {
  const parsed = parseSiweMessage(message);
  if (!parsed.domain || !parsed.address || !parsed.nonce) {
    throw new Error("The API did not send a Sign-In with Ethereum sign-in message.");
  }
  if (!isAddressEqual(parsed.address, signer.address as Address)) {
    throw new Error("The API's sign-in message is for another account.");
  }
  if (typeof window !== "undefined" && parsed.domain !== window.location.host) {
    throw new Error(`The API's sign-in message is for another site (${parsed.domain}).`);
  }
}

async function login(signer: MessageSigner): Promise<string> {
  const { message } = await postJson("/api/auth/nonce", { address: signer.address }, NonceSchema);
  checkMessage(message, signer);
  const signature = await signer.signMessage({ message });
  const session = await postJson("/api/auth/login", { message, signature }, SessionSchema);
  return session.address;
}

/** Signs in with the API's Sign-In with Ethereum (EIP-4361) flow; the API sets
 * a session cookie that every later request carries. */
export function signIn(signer: MessageSigner): Promise<string> {
  return serialized(() => login(signer));
}

/** The API session's address, or null when not signed in. */
export async function sessionAddress(): Promise<string | null> {
  try {
    return (await getJson("/api/auth/me", SessionSchema)).address;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/** Clears the API session cookie. */
export async function signOut(): Promise<void> {
  await postJson("/api/auth/logout", {}, z.unknown());
}

/** Makes sure the API session belongs to `signer`, signing in again if it is
 * missing or belongs to another account (another role, or another tab). */
export function ensureSignedIn(signer: MessageSigner): Promise<void> {
  return serialized(async () => {
    try {
      const { address } = await getJson("/api/auth/me", SessionSchema);
      if (address.toLowerCase() === signer.address.toLowerCase()) return;
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err;
    }
    await login(signer);
  });
}
