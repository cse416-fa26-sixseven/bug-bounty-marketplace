import { http, HttpResponse } from "msw";
import {
  CONTRACT_SOURCE_MAX_BYTES,
  ContractSourceFilenameSchema,
  ContractSourceSizeSchema,
  ContractSubmissionFieldsSchema,
} from "@bbm/shared";
import {
  cancelContract,
  createContract,
  disputeFinding,
  findContractById,
  listContracts,
  listFindingsByContract,
  reclaimContract,
  setFindingNote,
} from "../db/contracts";
import { openDispute } from "../db/disputes";
import { errorResponse } from "./util";

/** sha256 hex digest, matching the API's `createHash("sha256")` output. */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Flattens a Zod safeParse result into its failure messages. */
function failures(result: {
  success: boolean;
  error?: { issues: ReadonlyArray<{ message: string }> };
}): string[] {
  return result.error ? result.error.issues.map((issue) => issue.message) : [];
}

/**
 * Developer-flow routes: submit a contract, list contracts/findings,
 * dispute a finding, keep a note on a finding, reclaim an expired bounty. Owns no routes outside this
 * area - see CLAUDE.md for the per-flow handler split.
 */
export const developerHandlers = [
  http.post("*/api/contracts", async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return HttpResponse.json({ error: "file is required" }, { status: 400 });
    }
    // Mirror the API: an oversize upload is 413, anything else invalid is 400.
    if (file.size > CONTRACT_SOURCE_MAX_BYTES) {
      return HttpResponse.json(
        { error: "Source file exceeds the 100 KB limit" },
        { status: 413 },
      );
    }

    const fields = ContractSubmissionFieldsSchema.safeParse({
      developerAddress: form.get("developerAddress") ?? "",
      bountyAmount: form.get("bountyAmount") ?? "",
      currency: form.get("currency") ?? undefined,
      deadline: form.get("deadline") ?? "",
    });
    const issues = [
      ...failures(ContractSourceFilenameSchema.safeParse(file.name)),
      ...failures(ContractSourceSizeSchema.safeParse(file.size)),
      ...failures(fields),
    ];
    if (!fields.success || issues.length > 0) {
      return HttpResponse.json(
        { error: "Invalid contract submission", issues },
        { status: 400 },
      );
    }

    try {
      const contract = createContract({
        developerAddress: fields.data.developerAddress,
        filename: file.name,
        sourceHash: await sha256Hex(await file.arrayBuffer()),
        bountyAmount: fields.data.bountyAmount,
        currency: fields.data.currency,
        deadline: fields.data.deadline,
      });
      return HttpResponse.json(contract, { status: 201 });
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.get("*/api/contracts", ({ request }) => {
    const url = new URL(request.url);
    const developerAddress = url.searchParams.get("developerAddress") ?? undefined;
    return HttpResponse.json(listContracts(developerAddress ? { developerAddress } : undefined));
  }),

  http.get("*/api/contracts/:id", ({ params }) => {
    const contract = findContractById(String(params.id));
    if (!contract) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    return HttpResponse.json(contract);
  }),

  http.get("*/api/contracts/:id/findings", ({ params }) => {
    return HttpResponse.json(listFindingsByContract(String(params.id)));
  }),

  // The mock analysis is a timer, so it is Running until findings appear.
  http.get("*/api/contracts/:id/analysis", ({ params }) => {
    const contract = findContractById(String(params.id));
    if (!contract) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    const findings = listFindingsByContract(contract.id);
    return HttpResponse.json({
      contractId: contract.id,
      status: findings.length > 0 ? "Done" : "Running",
      error: null,
      findingCount: findings.length,
      updatedAt: contract.createdAt,
    });
  }),

  http.post("*/api/findings/:id/dispute", async ({ params, request }) => {
    const findingId = String(params.id);
    const body = (await request.json().catch(() => ({}))) as {
      developerId?: string;
      reason?: string;
    };
    if (!body.developerId || !body.reason) {
      return HttpResponse.json(
        { error: "developerId and reason are required" },
        { status: 400 },
      );
    }
    try {
      disputeFinding(findingId, body.developerId);
      const dispute = openDispute(findingId, body.developerId, body.reason);
      return HttpResponse.json(dispute, { status: 201 });
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.put("*/api/findings/:id/note", async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      developerId?: string;
      note?: unknown;
    };
    if (!body.developerId) {
      return HttpResponse.json({ error: "developerId is required" }, { status: 400 });
    }
    try {
      return HttpResponse.json(setFindingNote(String(params.id), body.developerId, body.note));
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.post("*/api/contracts/:id/reclaim", ({ params }) => {
    try {
      const contract = reclaimContract(String(params.id));
      return HttpResponse.json(contract);
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.post("*/api/contracts/:id/cancel", ({ params }) => {
    try {
      const contract = cancelContract(String(params.id));
      return HttpResponse.json(contract);
    } catch (err) {
      return errorResponse(err);
    }
  }),
];
