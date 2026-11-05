// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { cancelAllScheduled, resetMockDb } from "@/mocks/db";
import { developerApi } from "@/lib/api";
import { MOCK_ADDRESSES } from "@/lib/addresses";
import { FindingCard } from "../FindingCard";

// contract_2 is seeded with two Flagged findings for the mock developer.
const CONTRACT_ID = "contract_2";
/** Renders the first finding the way the contract page does: from the
 * ["findings", id] query, so a saved note flows back through the cache. */
function Harness({ developerAddress }: { developerAddress: string }) {
  const { data } = useQuery({
    queryKey: ["findings", CONTRACT_ID],
    queryFn: () => developerApi.listFindings(CONTRACT_ID),
  });
  const finding = data?.[0];
  return finding ? <FindingCard finding={finding} developerAddress={developerAddress} /> : null;
}

function renderHarness(developerAddress: string = MOCK_ADDRESSES.developer) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Harness developerAddress={developerAddress} />
    </QueryClientProvider>,
  );
}

async function firstNote() {
  return (await developerApi.listFindings(CONTRACT_ID))[0]?.developerNote ?? null;
}

beforeEach(() => {
  resetMockDb();
});

afterEach(() => {
  cancelAllScheduled();
});

describe("FindingNoteEditor", () => {
  it("adds a note, shows it, and saves it for the other participants", async () => {
    renderHarness();
    fireEvent.click(await screen.findByRole("button", { name: "Add a note" }));
    fireEvent.change(screen.getByLabelText("Your note"), {
      target: { value: "Known issue; fixed in v2." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));

    // Back in view mode (a controlled textarea's text matches findByText, so
    // wait for the view first).
    await screen.findByRole("button", { name: "Edit note" });
    expect(screen.getByText("Known issue; fixed in v2.")).toBeInTheDocument();
    expect(await firstNote()).toBe("Known issue; fixed in v2.");
  });

  it("edits the note, and Cancel keeps the saved one", async () => {
    await developerApi.setFindingNote((await developerApi.listFindings(CONTRACT_ID))[0]!.id, {
      developerId: MOCK_ADDRESSES.developer,
      note: "first",
    });
    renderHarness();
    fireEvent.click(await screen.findByRole("button", { name: "Edit note" }));
    expect(screen.getByLabelText("Your note")).toHaveValue("first");
    fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "discarded" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(await firstNote()).toBe("first");

    fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
    fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "second" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    await screen.findByRole("button", { name: "Edit note" });
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(await firstNote()).toBe("second");
  });

  it("clears the note", async () => {
    await developerApi.setFindingNote((await developerApi.listFindings(CONTRACT_ID))[0]!.id, {
      developerId: MOCK_ADDRESSES.developer,
      note: "to clear",
    });
    renderHarness();
    fireEvent.click(await screen.findByRole("button", { name: "Clear note" }));
    expect(await screen.findByRole("button", { name: "Add a note" })).toBeInTheDocument();
    await waitFor(async () => expect(await firstNote()).toBeNull());
  });

  it("shows the API's error when someone other than the developer saves", async () => {
    renderHarness(MOCK_ADDRESSES.auditor);
    fireEvent.click(await screen.findByRole("button", { name: "Add a note" }));
    fireEvent.change(screen.getByLabelText("Your note"), { target: { value: "not mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Only the contract's developer can edit this note",
    );
    expect(await firstNote()).toBeNull();
  });
});
