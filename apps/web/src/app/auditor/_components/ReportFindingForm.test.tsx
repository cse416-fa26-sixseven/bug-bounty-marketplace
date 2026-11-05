// @vitest-environment jsdom
import React, { type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuditorFindingReport } from "@bbm/shared";
import { ApiError, auditorApi } from "@/lib/api";
import { ReportFindingForm } from "./ReportFindingForm";

// Rendered components rely on the automatic JSX runtime; see app/arbiter/page.test.tsx.
(globalThis as unknown as { React: typeof React }).React = React;

// jsdom's File/FormData do not survive Node's fetch, so the form is tested
// against a stubbed client; the MSW round trip is covered in
// src/test/mock-flow.test.ts.
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, auditorApi: { ...actual.auditorApi, reportFinding: vi.fn() } };
});
const reportFinding = vi.mocked(auditorApi.reportFinding);

function renderForm(onReported = vi.fn(), auditorId = "auditor_1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  render(
    wrap(
      <ReportFindingForm contractId="contract_3" auditorId={auditorId} onReported={onReported} />,
    ),
  );
  return onReported;
}

function fill(fields: { title?: string; description?: string; file?: File }) {
  fireEvent.click(screen.getByRole("button", { name: "Report a new finding" }));
  if (fields.title !== undefined)
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: fields.title } });
  fireEvent.change(screen.getByLabelText("Severity"), { target: { value: "Critical" } });
  if (fields.description !== undefined)
    fireEvent.change(screen.getByLabelText(/^Description/), {
      target: { value: fields.description },
    });
  if (fields.file)
    fireEvent.change(screen.getByLabelText("PoC test file"), { target: { files: [fields.file] } });
  fireEvent.click(screen.getByRole("button", { name: /submit finding and poc/i }));
}

beforeEach(() => {
  reportFinding.mockReset();
});

describe("ReportFindingForm", () => {
  it("sends the trimmed report with its PoC, then closes and notifies", async () => {
    reportFinding.mockResolvedValue({} as AuditorFindingReport);
    const onReported = renderForm();
    const file = new File(["contract SweepTest {}"], "Sweep.t.sol");

    fill({ title: "  Unprotected sweep()  ", description: "Anyone can sweep.", file });

    await waitFor(() => expect(onReported).toHaveBeenCalled());
    expect(reportFinding).toHaveBeenCalledWith({
      contractId: "contract_3",
      auditorId: "auditor_1",
      title: "Unprotected sweep()",
      severity: "Critical",
      description: "Anyone can sweep.",
      file,
    });
    expect(screen.getByRole("button", { name: "Report a new finding" })).toBeInTheDocument();
  });

  it("asks for a title before sending anything", async () => {
    const onReported = renderForm();
    fill({ description: "x", file: new File(["c"], "Sweep.t.sol") });
    expect(await screen.findByRole("alert")).toHaveTextContent("Title is required");
    expect(reportFinding).not.toHaveBeenCalled();
    expect(onReported).not.toHaveBeenCalled();
  });

  it("requires a .t.sol PoC file", async () => {
    renderForm();
    fill({ title: "t", description: "d", file: new File(["c"], "Sweep.sol") });
    expect(await screen.findByRole("alert")).toHaveTextContent(/\.t\.sol/);
    expect(reportFinding).not.toHaveBeenCalled();
  });

  it("shows the API's error and stays open", async () => {
    reportFinding.mockRejectedValue(
      new ApiError(
        "You do not hold an active claim on this contract",
        403,
        "/api/auditor/findings",
      ),
    );
    const onReported = renderForm();
    fill({ title: "t", description: "d", file: new File(["c"], "Sweep.t.sol") });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You do not hold an active claim on this contract",
    );
    expect(onReported).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Title")).toHaveValue("t");
  });
});
