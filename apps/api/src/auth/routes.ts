import type { FastifyInstance } from "fastify";
import { isAddress, isHex } from "viem";
import type { Auth } from "./session.js";

export function registerAuthRoutes(app: FastifyInstance, auth: Auth): void {
  app.post<{ Body: { address?: unknown } | undefined }>("/api/auth/nonce", async (request, reply) => {
    const address = request.body?.address;
    if (typeof address !== "string" || !isAddress(address)) {
      return reply.code(400).send({ error: "address must be a 0x address" });
    }
    const origin = auth.originOf(request);
    const issued = origin ? auth.issueNonce(address, origin) : null;
    if (!issued) {
      return reply
        .code(400)
        .send({ error: "cannot tell which site this sign-in is for: open the web app by its domain, or set AUTH_ORIGIN" });
    }
    return issued;
  });

  app.post<{ Body: { message?: unknown; signature?: unknown; address?: unknown } | undefined }>(
    "/api/auth/login",
    async (request, reply) => {
      const { message, signature, address } = request.body ?? {};
      if (
        typeof message !== "string" ||
        typeof signature !== "string" ||
        !isHex(signature) ||
        (address !== undefined && typeof address !== "string")
      ) {
        return reply.code(400).send({ error: "message and signature are required" });
      }
      const result = await auth.login(message, signature, auth.originOf(request), address);
      if (!result.ok) return reply.code(401).send({ error: `sign-in rejected: ${result.reason}` });
      void reply.header("set-cookie", auth.sessionCookie(result.token));
      return { address: result.address };
    },
  );

  app.get("/api/auth/me", async (request, reply) => {
    const address = auth.requireSession(request, reply);
    if (!address) return reply;
    return { address };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    void reply.header("set-cookie", auth.clearedCookie());
    return { ok: true };
  });
}
