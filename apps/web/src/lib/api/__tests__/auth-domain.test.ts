// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/mocks/server";
import { ANVIL_ACCOUNTS } from "@/lib/chain/accounts";
import { siweMessage } from "@/test/siwe";
import { signIn } from "../auth";

describe("signIn in the browser", () => {
  it("refuses to sign a message for another site than the page's", async () => {
    server.use(
      http.post("*/api/auth/nonce", () =>
        HttpResponse.json({
          nonce: "abcdef0123456789",
          message: siweMessage(ANVIL_ACCOUNTS.auditor.address, { domain: "evil.example" }),
        }),
      ),
    );
    const signMessage = vi.fn();
    await expect(
      signIn({ address: ANVIL_ACCOUNTS.auditor.address, signMessage }),
    ).rejects.toThrow(/another site/);
    expect(signMessage).not.toHaveBeenCalled();
  });
});
