import type { FastifyInstance } from "fastify";
import type { PrivateKeyAccount } from "viem/accounts";
import { privateKeyToAccount } from "viem/accounts";

/** anvil's well-known dev accounts, as the demo uses them. */
export const ARBITER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
export const DEVELOPER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
export const AUDITOR = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");

/** Signs in through the auth routes and returns the session `cookie` header value. */
export async function signIn(app: FastifyInstance, account: PrivateKeyAccount): Promise<string> {
  const nonce = await app.inject({ method: "POST", url: "/api/auth/nonce", payload: { address: account.address } });
  const { message } = nonce.json() as { message: string };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { message, signature: await account.signMessage({ message }) },
  });
  if (login.statusCode !== 200) throw new Error(`sign-in failed: ${login.body}`);
  return String(login.headers["set-cookie"]).split(";")[0]!;
}
