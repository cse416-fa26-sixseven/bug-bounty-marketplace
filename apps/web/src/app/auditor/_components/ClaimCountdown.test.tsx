// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ClaimCountdown } from "./ClaimCountdown";

const NOW = new Date("2026-11-16T12:00:00.000Z");
const plus = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("ClaimCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats the remaining time as m:ss", () => {
    render(<ClaimCountdown expiresAt={plus(10 * 60_000 + 5_000)} />);
    expect(screen.getByText("10:05")).toBeInTheDocument();
  });

  it("counts down once a second", () => {
    render(<ClaimCountdown expiresAt={plus(65_000)} />);
    expect(screen.getByText("1:05")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("1:04")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText("0:59")).toBeInTheDocument();
  });

  it("shows 'expired' in red once the claim runs out", () => {
    render(<ClaimCountdown expiresAt={plus(2_000)} />);
    const live = screen.getByText("0:02");
    expect(live).toHaveClass("text-emerald-400");

    act(() => vi.advanceTimersByTime(2_000));
    const expired = screen.getByText("expired");
    expect(expired).toHaveClass("text-red-400");

    // Stays expired.
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText("expired")).toBeInTheDocument();
  });

  it("is expired immediately for a past expiry", () => {
    render(<ClaimCountdown expiresAt={plus(-1_000)} />);
    expect(screen.getByText("expired")).toBeInTheDocument();
  });

  it("stops ticking after unmount", () => {
    const { unmount } = render(<ClaimCountdown expiresAt={plus(60_000)} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
