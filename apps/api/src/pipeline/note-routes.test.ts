import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { DEVELOPER_NOTE_MAX_LENGTH, FindingSchema } from "@bbm/shared";
import { buildApp } from "../app.js";
import type { BountyEscrowPort } from "../chain/bounty-escrow.js";
import { MemoryContractRepository } from "../contracts/memory-repository.js";
import { MemorySourceStorage } from "../contracts/storage.js";
import { makeContract, makeFinding } from "../testing/repository-suite.js";
import { AUDITOR, DEVELOPER, signIn } from "../testing/session.js";
import { MemoryPipelineRepository, MemoryStore } from "./memory-repository.js";

const T0 = new Date("2026-10-20T12:00:00.000Z");
const developerAddress = "0x1234567890123456789012345678901234567890";

function setup(options: { signedIn?: boolean } = {}) {
  const store = new MemoryStore();
  const clock = { now: T0 };
  const bountyEscrow = { readBounty: vi.fn() } as unknown as Pick<BountyEscrowPort, "readBounty">;
  const app = buildApp({
    repository: new MemoryContractRepository(store),
    pipeline: new MemoryPipelineRepository(store),
    storage: new MemorySourceStorage(),
    config: { claimWindowSeconds: 600, now: () => clock.now },
    // Session identity (chain mode) needs both a session secret and BountyEscrow.
    ...(options.signedIn ? { sessionSecret: "s", bountyEscrow, now: () => clock.now } : {}),
  });
  async function seed(owner: string = developerAddress) {
    const record = makeContract({ developerAddress: owner });
    await new MemoryContractRepository(store).insertContract(record);
    const finding = makeFinding(record.contract.id);
    store.findings.set(finding.id, finding);
    return finding;
  }
  function putNote(findingId: string, payload: unknown, cookie?: string) {
    return app.inject({
      method: "PUT",
      url: `/api/findings/${findingId}/note`,
      payload: payload as Record<string, unknown>,
      headers: cookie ? { cookie } : {},
    });
  }
  const advance = (seconds: number) => {
    clock.now = new Date(clock.now.getTime() + seconds * 1000);
  };
  return { app, store, seed, putNote, advance };
}

describe("PUT /api/findings/:id/note", () => {
  it("sets the developer's note, visible on the contract's findings", async () => {
    const ctx = setup();
    const finding = await ctx.seed();

    const response = await ctx.putNote(finding.id, {
      developerId: developerAddress,
      note: "  Known issue; fixed in v2.  ",
    });

    expect(response.statusCode).toBe(200);
    expect(FindingSchema.parse(response.json())).toMatchObject({
      id: finding.id,
      developerNote: "Known issue; fixed in v2.",
      developerNoteUpdatedAt: T0.toISOString(),
      status: "Flagged",
    });
    const listed = await ctx.app.inject({ url: `/api/contracts/${finding.contractId}/findings` });
    expect(FindingSchema.array().parse(listed.json())[0]?.developerNote).toBe(
      "Known issue; fixed in v2.",
    );
  });

  it("edits the note and moves its timestamp", async () => {
    const ctx = setup();
    const finding = await ctx.seed();
    await ctx.putNote(finding.id, { developerId: developerAddress, note: "first" });
    ctx.advance(60);
    const response = await ctx.putNote(finding.id, { developerId: developerAddress, note: "second" });
    expect(response.json()).toMatchObject({
      developerNote: "second",
      developerNoteUpdatedAt: new Date(T0.getTime() + 60_000).toISOString(),
    });
  });

  for (const [label, note] of [
    ["an empty string", ""],
    ["whitespace", "   "],
    ["null", null],
  ] as const) {
    it(`clears the note when given ${label}`, async () => {
      const ctx = setup();
      const finding = await ctx.seed();
      await ctx.putNote(finding.id, { developerId: developerAddress, note: "to be cleared" });
      const response = await ctx.putNote(finding.id, { developerId: developerAddress, note });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ developerNote: null, developerNoteUpdatedAt: null });
    });
  }

  it("matches the developer's address case-insensitively", async () => {
    const ctx = setup();
    const finding = await ctx.seed("0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD");
    const response = await ctx.putNote(finding.id, {
      developerId: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      note: "ok",
    });
    expect(response.statusCode).toBe(200);
  });

  it("returns 403 for anyone but the contract's developer and writes nothing", async () => {
    const ctx = setup();
    const finding = await ctx.seed();
    const response = await ctx.putNote(finding.id, {
      developerId: "0x9999999999999999999999999999999999999999",
      note: "not mine",
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: "Only the contract's developer can edit this note" });
    expect(ctx.store.findings.get(finding.id)?.developerNote).toBeNull();
  });

  it("returns 404 for an unknown finding", async () => {
    const ctx = setup();
    const response = await ctx.putNote("finding_missing", {
      developerId: developerAddress,
      note: "x",
    });
    expect(response.statusCode).toBe(404);
  });

  it("requires developerId when no session identity is configured", async () => {
    const ctx = setup();
    const finding = await ctx.seed();
    const response = await ctx.putNote(finding.id, { note: "x" });
    expect(response.statusCode).toBe(400);
  });

  for (const [label, payload, issue] of [
    ["a missing note", {}, undefined],
    ["a non-string note", { note: 5 }, undefined],
    [
      "an over-long note",
      { note: "a".repeat(DEVELOPER_NOTE_MAX_LENGTH + 1) },
      `Note must be at most ${DEVELOPER_NOTE_MAX_LENGTH} characters`,
    ],
    ["a NUL character", { note: "a\u0000b" }, "Note must not contain NUL characters"],
  ] as const) {
    it(`rejects ${label} with 400 and writes nothing`, async () => {
      const ctx = setup();
      const finding = await ctx.seed();
      const response = await ctx.putNote(finding.id, { developerId: developerAddress, ...payload });
      expect(response.statusCode).toBe(400);
      const body = response.json() as { error: string; issues: string[] };
      expect(body.error).toBe("Invalid note");
      if (issue) expect(body.issues).toContain(issue);
      expect(ctx.store.findings.get(finding.id)?.developerNote).toBeNull();
    });
  }

  it("accepts a note up to the length limit", async () => {
    const ctx = setup();
    const finding = await ctx.seed();
    const response = await ctx.putNote(finding.id, {
      developerId: developerAddress,
      note: "a".repeat(DEVELOPER_NOTE_MAX_LENGTH),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe("PUT /api/findings/:id/note with session identity", () => {
  it("needs a session (401)", async () => {
    const ctx = setup({ signedIn: true });
    const finding = await ctx.seed(DEVELOPER.address);
    expect((await ctx.putNote(finding.id, { note: "x" })).statusCode).toBe(401);
  });

  it("lets only the signed-in developer write (403 for the auditor)", async () => {
    const ctx = setup({ signedIn: true });
    const finding = await ctx.seed(DEVELOPER.address);
    const auditor = await signIn(ctx.app, AUDITOR);
    expect((await ctx.putNote(finding.id, { note: "x" }, auditor)).statusCode).toBe(403);

    const developer = await signIn(ctx.app, DEVELOPER);
    const response = await ctx.putNote(finding.id, { note: "mine" }, developer);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ developerNote: "mine" });
  });

  it("rejects a developerId other than the signed-in wallet", async () => {
    const ctx = setup({ signedIn: true });
    const finding = await ctx.seed(DEVELOPER.address);
    const developer = await signIn(ctx.app, DEVELOPER);
    const response = await ctx.putNote(
      finding.id,
      { developerId: AUDITOR.address as Address, note: "x" },
      developer,
    );
    expect(response.statusCode).toBe(403);
  });
});
