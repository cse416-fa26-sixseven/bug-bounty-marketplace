// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { explorerAddressUrl, explorerTxUrl } from "@/lib/chain/networks";
import { useLastTx } from "@/lib/chain/tx-store";
import { TxLink, TxNotice } from "../TxLink";

const HASH = `0x${"ab".repeat(32)}`;

afterEach(() => useLastTx.getState().clear());

describe("explorer links", () => {
  it("maps Sepolia to Etherscan and the local chain to nothing", () => {
    expect(explorerTxUrl(11155111, HASH)).toBe(`https://sepolia.etherscan.io/tx/${HASH}`);
    expect(explorerAddressUrl(11155111, "0xabc")).toBe("https://sepolia.etherscan.io/address/0xabc");
    expect(explorerTxUrl(31337, HASH)).toBeNull();
    expect(explorerTxUrl(424242, HASH)).toBeNull();
  });

  it("renders a link only where the chain has an explorer", () => {
    const { container } = render(
      <>
        <TxLink chainId={11155111} hash={HASH} />
        <TxLink chainId={31337} hash={HASH} />
      </>,
    );
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent("View on Etherscan");
    expect(links[0]).toHaveAttribute("href", `https://sepolia.etherscan.io/tx/${HASH}`);
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(container.querySelectorAll("a")).toHaveLength(1);
  });
});

describe("TxNotice", () => {
  it("shows the last confirmed transaction's explorer link until dismissed", () => {
    render(<TxNotice />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => useLastTx.getState().record({ chainId: 11155111, hash: HASH }));
    expect(screen.getByRole("status")).toHaveTextContent("Transaction confirmed");
    expect(screen.getByRole("link", { name: "View on Etherscan" })).toHaveAttribute(
      "href",
      `https://sepolia.etherscan.io/tx/${HASH}`,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss transaction notice" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows nothing for a transaction on the local chain", () => {
    render(<TxNotice />);
    act(() => useLastTx.getState().record({ chainId: 31337, hash: HASH }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
