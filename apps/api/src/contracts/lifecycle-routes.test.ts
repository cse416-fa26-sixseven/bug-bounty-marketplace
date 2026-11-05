import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { buildApp } from "../app.js";
import type { BountyEscrowPort, OnchainBounty } from "../chain/bounty-escrow.js";
import { onchainId } from "../chain/ids.js";
import { MemoryChainActionStore } from "../chain/memory-action-store.js";
import { MemoryPipelineRepository, MemoryStore } from "../pipeline/memory-repository.js";
import { multipartBody } from "../testing/http.js";
import { markAnalysed } from "../testing/repository-suite.js";
import { MemoryContractRepository } from "./memory-repository.js";
import { AUDITOR, DEVELOPER, signIn } from "../testing/session.js";

const ZERO = `0x${"0".repeat(64)}` as Hex;
const NOBODY = "0x0000000000000000000000000000000000000000" as Address;
const DEADLINE = "2030-01-01T00:00:00.000Z";
const AMOUNT = "1000000000000000000";

function setup(options: { chainActions?: unknown } = {}) {
  const bounties = new Map<Hex, OnchainBounty>();
  const bountyEscrow = {
    readBounty: vi.fn(
      async (id: Hex): Promise<OnchainBounty> =>
        bounties.get(id) ?? {
          developer: NOBODY,
          amount: 0n,
          deadline: 0n,
          state: 0,
          submissionCount: 0n,
          verifiedFinding: ZERO,
          verifiedAuditor: NOBODY,
          frozen: false,
        },
    ),
  } satisfies Pick<BountyEscrowPort, "readBounty">;
  const store = new MemoryStore();
  const app = buildApp({
    sessionSecret: "s",
    bountyEscrow,
    chainActions: options.chainActions as never,
    repository: new MemoryContractRepository(store),
    pipeline: new MemoryPipelineRepository(store),
    findingStatus: new MemoryChainActionStore(store),
  });
  function fundOnChain(
    contractId: string,
    state = 1,
    developer: Address = DEVELOPER.address,
    deadline = DEADLINE,
  ) {
    bounties.set(onchainId(contractId), {
      developer,
      amount: BigInt(AMOUNT),
      deadline: BigInt(Date.parse(deadline) / 1000),
      state,
      submissionCount: 0n,
      verifiedFinding: ZERO,
      verifiedAuditor: NOBODY,
      frozen: false,
    });
  }
  /** Uploads a contract; unless `analysed` is false, the worker is taken to
   * have finished its analysis. */
  async function upload(
    cookie: string,
    developerAddress: string = DEVELOPER.address,
    analysed = true,
  ) {
    const response = await app.inject({
      method: "POST",
      url: "/api/contracts",
      headers: { cookie, ...multipartBody({}).headers },
      payload: multipartBody(
        { developerAddress, bountyAmount: AMOUNT, currency: "ETH", deadline: DEADLINE },
        { name: "Vault.sol", content: Buffer.from("pragma solidity ^0.8.19; contract V {}") },
      ).payload,
    });
    if (response.statusCode === 201 && analysed) markAnalysed(store, response.json().id as string);
    return response;
  }
  return { app, store, bounties, fundOnChain, upload };
}

describe("contract lifecycle routes with a chain", () => {
  it("uploads as the signed-in developer and rejects another developerAddress", async () => {
    const { app, upload } = setup();
    const dev = await signIn(app, DEVELOPER);
    expect((await upload(dev)).statusCode).toBe(201);
    expect((await upload(dev, AUDITOR.address)).statusCode).toBe(403);
    expect((await upload("")).statusCode).toBe(401);
  });

  it("marks a bounty funded once the chain holds it, idempotently", async () => {
    const { app, upload, fundOnChain } = setup();
    const dev = await signIn(app, DEVELOPER);
    const id = (await upload(dev)).json().id as string;
    fundOnChain(id);
    for (let i = 0; i < 2; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: `/api/contracts/${id}/funded`,
        headers: { cookie: dev },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
    }
  });

  it("refuses to mark funded until the analysis is done, even when the chain holds it", async () => {
    const { app, store, upload, fundOnChain } = setup();
    const dev = await signIn(app, DEVELOPER);
    const id = (await upload(dev, DEVELOPER.address, false)).json().id as string;
    fundOnChain(id);
    const funded = () =>
      app.inject({ method: "POST", url: `/api/contracts/${id}/funded`, headers: { cookie: dev } });

    const early = await funded();
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: "analysis not finished" });

    const job = [...store.jobs.values()].find((j) => j.subjectId === id)!;
    job.status = "failed";
    expect((await funded()).statusCode).toBe(409);

    job.status = "done";
    expect((await funded()).statusCode).toBe(200);
  });

  it("adopts a later on-chain deadline for an unfunded bounty, but not a past one or a funded one's", async () => {
    const { app, upload, fundOnChain } = setup();
    const dev = await signIn(app, DEVELOPER);
    const funded = (id: string) =>
      app.inject({ method: "POST", url: `/api/contracts/${id}/funded`, headers: { cookie: dev } });

    const past = (await upload(dev)).json().id as string;
    fundOnChain(past, 1, DEVELOPER.address, "2020-01-01T00:00:00.000Z");
    expect((await funded(past)).statusCode).toBe(409);

    const id = (await upload(dev)).json().id as string;
    const LATER = "2031-06-01T00:00:00.000Z";
    fundOnChain(id, 1, DEVELOPER.address, LATER);
    const res = await funded(id);
    expect(res.statusCode).toBe(200);
    expect(res.json().deadline).toBe(LATER);

    // Funded: its terms no longer move.
    fundOnChain(id, 1, DEVELOPER.address, "2032-01-01T00:00:00.000Z");
    expect((await funded(id)).statusCode).toBe(409);
    fundOnChain(id, 1, DEVELOPER.address, LATER);
    expect((await funded(id)).statusCode).toBe(200);
  });

  it("refuses to mark funded when the chain does not hold the bounty", async () => {
    const { app, upload } = setup();
    const dev = await signIn(app, DEVELOPER);
    const id = (await upload(dev)).json().id as string;
    const res = await app.inject({
      method: "POST",
      url: `/api/contracts/${id}/funded`,
      headers: { cookie: dev },
    });
    expect(res.statusCode).toBe(409);
    const queue = await app.inject({ method: "GET", url: "/api/auditor/queue" });
    expect(queue.json().map((c: { id: string }) => c.id)).not.toContain(id);
  });

  it("only the developer may mark their bounty funded", async () => {
    const { app, upload, fundOnChain } = setup();
    const id = (await upload(await signIn(app, DEVELOPER))).json().id as string;
    fundOnChain(id);
    const auditor = await signIn(app, AUDITOR);
    const res = await app.inject({
      method: "POST",
      url: `/api/contracts/${id}/funded`,
      headers: { cookie: auditor },
    });
    expect(res.statusCode).toBe(403);
  });

  it("lists only funded contracts in the queue", async () => {
    const { app, upload, fundOnChain } = setup();
    const dev = await signIn(app, DEVELOPER);
    const funded = (await upload(dev)).json().id as string;
    const unfunded = (await upload(dev)).json().id as string;
    fundOnChain(funded);
    await app.inject({
      method: "POST",
      url: `/api/contracts/${funded}/funded`,
      headers: { cookie: dev },
    });
    const ids = (await app.inject({ method: "GET", url: "/api/auditor/queue" }))
      .json()
      .map((c: { id: string }) => c.id);
    expect(ids).toContain(funded);
    expect(ids).not.toContain(unfunded);
  });

  it("cancel and reclaim expire the contract only after the bounty is closed on-chain", async () => {
    const { app, upload, fundOnChain } = setup();
    const dev = await signIn(app, DEVELOPER);
    for (const action of ["cancel", "reclaim"]) {
      const id = (await upload(dev)).json().id as string;
      fundOnChain(id, 1);
      const open = await app.inject({
        method: "POST",
        url: `/api/contracts/${id}/${action}`,
        headers: { cookie: dev },
      });
      expect(open.statusCode).toBe(409);
      fundOnChain(id, 3);
      const closed = await app.inject({
        method: "POST",
        url: `/api/contracts/${id}/${action}`,
        headers: { cookie: dev },
      });
      expect(closed.statusCode).toBe(200);
      expect(closed.json().status).toBe("Expired");
    }
  });

  it("claims for the signed-in auditor and rejects a different body auditorId", async () => {
    const { app, upload, fundOnChain } = setup();
    const dev = await signIn(app, DEVELOPER);
    const id = (await upload(dev)).json().id as string;
    fundOnChain(id);
    await app.inject({
      method: "POST",
      url: `/api/contracts/${id}/funded`,
      headers: { cookie: dev },
    });
    const auditor = await signIn(app, AUDITOR);
    const wrong = await app.inject({
      method: "POST",
      url: "/api/auditor/claim",
      headers: { cookie: auditor },
      payload: { contractId: id, auditorId: DEVELOPER.address },
    });
    expect(wrong.statusCode).toBe(403);
    const noSession = await app.inject({
      method: "POST",
      url: "/api/auditor/claim",
      payload: { contractId: id },
    });
    expect(noSession.statusCode).toBe(401);
    const ok = await app.inject({
      method: "POST",
      url: "/api/auditor/claim",
      headers: { cookie: auditor },
      payload: { contractId: id },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("review fixes", () => {
  it("refuses to claim a bounty that is not funded on-chain", async () => {
    const { app, upload } = setup();
    const id = (await upload(await signIn(app, DEVELOPER))).json().id as string;
    const res = await app.inject({
      method: "POST",
      url: "/api/auditor/claim",
      headers: { cookie: await signIn(app, AUDITOR) },
      payload: { contractId: id },
    });
    expect(res.statusCode).toBe(409);
  });

  it("cancel releases the auditor's claim lock before expiring the contract", async () => {
    // releaseClaimLock, not the expiry sweep: the sweep keeps a lock that backs
    // a pending finding, which can never settle once the bounty is closed.
    const chainActions = {
      chainConfigured: true,
      releaseClaimLock: vi.fn(async () => true),
      releaseExpiredLocks: vi.fn(async () => 0),
      lockClaim: vi.fn(async () => undefined),
    };
    const { app, upload, fundOnChain } = setup({ chainActions });
    const dev = await signIn(app, DEVELOPER);
    const id = (await upload(dev)).json().id as string;
    fundOnChain(id, 3);
    const res = await app.inject({
      method: "POST",
      url: `/api/contracts/${id}/cancel`,
      headers: { cookie: dev },
    });
    expect(res.statusCode).toBe(200);
    expect(chainActions.releaseClaimLock).toHaveBeenCalledWith(id);
    expect(chainActions.releaseExpiredLocks).not.toHaveBeenCalled();
  });

  it("keeps the contract when the claim lock cannot be released", async () => {
    const chainActions = {
      chainConfigured: true,
      releaseClaimLock: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    };
    const { app, upload, fundOnChain } = setup({ chainActions });
    const dev = await signIn(app, DEVELOPER);
    const id = (await upload(dev)).json().id as string;
    fundOnChain(id, 3);
    const res = await app.inject({
      method: "POST",
      url: `/api/contracts/${id}/reclaim`,
      headers: { cookie: dev },
    });
    expect(res.statusCode).toBe(502);
    const contract = await app.inject({ method: "GET", url: `/api/contracts/${id}` });
    expect(contract.json().status).toBe("Open");
  });

  it("PoC uploads need a session and cannot name another auditor", async () => {
    const { app } = setup();
    const form = multipartBody(
      { findingId: "finding_x", auditorId: DEVELOPER.address },
      { name: "PoC.t.sol", content: Buffer.from("contract T {}") },
    );
    const none = await app.inject({
      method: "POST",
      url: "/api/auditor/poc",
      headers: form.headers,
      payload: form.payload,
    });
    expect(none.statusCode).toBe(401);
    const other = await app.inject({
      method: "POST",
      url: "/api/auditor/poc",
      headers: { ...form.headers, cookie: await signIn(app, AUDITOR) },
      payload: form.payload,
    });
    expect(other.statusCode).toBe(403);
  });

  it("auditor finding reports need a session and cannot name another auditor", async () => {
    const { app } = setup();
    const form = multipartBody(
      {
        contractId: "contract_x",
        auditorId: DEVELOPER.address,
        title: "Unprotected sweep()",
        severity: "High",
        description: "Anyone can sweep the balance.",
      },
      { name: "PoC.t.sol", content: Buffer.from("contract T {}") },
    );
    const none = await app.inject({
      method: "POST",
      url: "/api/auditor/findings",
      headers: form.headers,
      payload: form.payload,
    });
    expect(none.statusCode).toBe(401);
    const other = await app.inject({
      method: "POST",
      url: "/api/auditor/findings",
      headers: { ...form.headers, cookie: await signIn(app, AUDITOR) },
      payload: form.payload,
    });
    expect(other.statusCode).toBe(403);
  });
});
