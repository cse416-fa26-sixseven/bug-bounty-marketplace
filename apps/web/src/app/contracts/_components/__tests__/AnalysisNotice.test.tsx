// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalysisNotice } from "../AnalysisNotice";

const base = {
  contractId: "contract_1",
  error: null,
  findingCount: 0,
  updatedAt: "2026-10-20T12:00:00.000Z",
};

describe("AnalysisNotice", () => {
  it("says analysis is running while queued or running", () => {
    render(<AnalysisNotice status={{ ...base, status: "Queued" }} />);
    expect(screen.getByText(/Analysis is still running/)).toBeTruthy();
  });

  it("shows the compiler error when analysis failed", () => {
    render(
      <AnalysisNotice
        status={{ ...base, status: "Failed", error: "Error: Expected type name\n --> A.sol:3:15:" }}
      />,
    );
    expect(screen.getByText(/Analysis failed/)).toBeTruthy();
    expect(screen.getByText(/Expected type name/)).toBeTruthy();
    expect(screen.getByText(/can't be funded or claimed/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /submit the fixed file/i }).getAttribute("href")).toBe("/submit");
  });

  it("says no issues were found when analysis finished with zero findings", () => {
    render(<AnalysisNotice status={{ ...base, status: "Done" }} />);
    expect(screen.getByText(/Slither found no issues/)).toBeTruthy();
  });

  it("falls back to the running message before the status has loaded", () => {
    render(<AnalysisNotice status={undefined} />);
    expect(screen.getByText(/Analysis is still running/)).toBeTruthy();
  });

  it("never says 'no issues' when the status reports findings that haven't loaded yet", () => {
    render(<AnalysisNotice status={{ ...base, status: "Done", findingCount: 3 }} />);
    expect(screen.queryByText(/Slither found no issues/)).toBeNull();
    expect(screen.getByText(/Loading findings/)).toBeTruthy();
  });

  it("says the status is unavailable instead of 'still running' when it can't be loaded", () => {
    render(<AnalysisNotice status={undefined} unavailable />);
    expect(screen.queryByText(/still running/)).toBeNull();
    expect(screen.getByText(/Analysis status unavailable/)).toBeTruthy();
  });

  it("announces status changes to screen readers, and failures as alerts", () => {
    const { unmount } = render(<AnalysisNotice status={{ ...base, status: "Running" }} />);
    expect(screen.getByRole("status").textContent).toMatch(/still running/);
    unmount();
    render(<AnalysisNotice status={{ ...base, status: "Failed", error: "Error: x" }} />);
    expect(screen.getByRole("alert").textContent).toMatch(/Analysis failed/);
  });
});
