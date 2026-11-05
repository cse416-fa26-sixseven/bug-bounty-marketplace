import { http, HttpResponse } from "msw";
import {
  claimContract,
  findAuditorById,
  listQueue,
  markFalsePositive,
  postStake,
  profileView,
  reportFinding,
  submitPoc,
  withdrawStake,
} from "../db/auditors";
import { errorResponse } from "./util";

/**
 * Auditor-flow routes: queue, claim, stake and stake withdrawal, PoC submission,
 * auditor-reported findings, false-positive flagging, own profile. Owns no
 * routes outside this area.
 */
export const auditorHandlers = [
  http.get("*/api/auditor/queue", ({ request }) => {
    const url = new URL(request.url);
    const sortParam = url.searchParams.get("sort");
    const sort =
      sortParam === "deadline" || sortParam === "bounty" || sortParam === "newest"
        ? sortParam
        : undefined;
    return HttpResponse.json(listQueue(sort));
  }),

  http.post("*/api/auditor/claim", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      contractId?: string;
      auditorId?: string;
    };
    if (!body.contractId || !body.auditorId) {
      return HttpResponse.json(
        { error: "contractId and auditorId are required" },
        { status: 400 },
      );
    }
    try {
      return HttpResponse.json(claimContract(body.contractId, body.auditorId));
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.get("*/api/auditor/profile", ({ request }) => {
    const url = new URL(request.url);
    const auditorId = url.searchParams.get("auditorId");
    if (!auditorId) {
      return HttpResponse.json({ error: "auditorId is required" }, { status: 400 });
    }
    const profile = findAuditorById(auditorId);
    if (!profile) return HttpResponse.json({ error: "Not found" }, { status: 404 });
    return HttpResponse.json(profileView(profile));
  }),

  http.post("*/api/auditor/stake", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      auditorId?: string;
      amount?: string;
    };
    if (!body.auditorId || typeof body.amount !== "string") {
      return HttpResponse.json(
        { error: "auditorId and a wei amount string are required" },
        { status: 400 },
      );
    }
    try {
      return HttpResponse.json(postStake(body.auditorId, body.amount));
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.post("*/api/auditor/stake/withdraw", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as {
      auditorId?: string;
      amount?: string;
    };
    if (!body.auditorId || typeof body.amount !== "string") {
      return HttpResponse.json(
        { error: "auditorId and a wei amount string are required" },
        { status: 400 },
      );
    }
    try {
      return HttpResponse.json(withdrawStake(body.auditorId, body.amount));
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.post("*/api/auditor/poc", async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    const findingId = String(form.get("findingId") ?? "");
    const auditorId = String(form.get("auditorId") ?? "");

    if (!(file instanceof File) || !findingId || !auditorId) {
      return HttpResponse.json(
        { error: "findingId, auditorId and file are required" },
        { status: 400 },
      );
    }
    try {
      const poc = submitPoc(findingId, auditorId, file.name);
      return HttpResponse.json(poc, { status: 201 });
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.post("*/api/auditor/findings", async ({ request }) => {
    const form = await request.formData();
    const file = form.get("file");
    const field = (name: string) => String(form.get(name) ?? "");
    const auditorId = field("auditorId");
    const input = {
      contractId: field("contractId"),
      title: field("title"),
      severity: field("severity"),
      description: field("description"),
    };
    if (!(file instanceof File) || !auditorId || Object.values(input).some((v) => !v)) {
      return HttpResponse.json(
        { error: "contractId, auditorId, title, severity, description and file are required" },
        { status: 400 },
      );
    }
    try {
      return HttpResponse.json(reportFinding(input, auditorId, file.name), { status: 201 });
    } catch (err) {
      return errorResponse(err);
    }
  }),

  http.post("*/api/findings/:id/false-positive", async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as { auditorId?: string };
    if (!body.auditorId) {
      return HttpResponse.json({ error: "auditorId is required" }, { status: 400 });
    }
    try {
      return HttpResponse.json(markFalsePositive(String(params.id), body.auditorId));
    } catch (err) {
      return errorResponse(err);
    }
  }),
];
