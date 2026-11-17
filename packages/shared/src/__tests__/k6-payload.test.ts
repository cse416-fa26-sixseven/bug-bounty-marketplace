import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ContractSubmissionFieldsSchema } from "../index";

/**
 * Regression for #61: the k6 load test's setup() uploaded a contract with the
 * bounty in ETH, which the API (wei only) rejected with 400. k6 scripts can't
 * be imported in Node, so this reads the POST /api/contracts body literal out
 * of tests/load/api-baseline.js and evaluates it with a stub `http`.
 * (tests/regression needs a running stack, so the check lives here.)
 */
const SCRIPT = new URL("../../../../tests/load/api-baseline.js", import.meta.url);

function contractUploadFields(): Record<string, unknown> {
  const source = readFileSync(SCRIPT, "utf8");
  const match = /http\.post\(`\$\{BASE_URL\}\/api\/contracts`,\s*(\{[\s\S]*?\})\);/.exec(source);
  if (!match) throw new Error("POST /api/contracts payload not found in api-baseline.js");
  const http = { file: (_data: unknown, name: string) => ({ file: name }) };
  // The literal only uses http.file, SAMPLE_SOL, string literals and Date.
  const evaluate = new Function("http", "SAMPLE_SOL", `return (${match[1]});`) as (
    h: typeof http,
    sol: string,
  ) => Record<string, unknown>;
  return evaluate(http, "contract C {}");
}

describe("k6 api-baseline contract upload", () => {
  it("sends the bounty as an integer wei string", () => {
    const { bountyAmount } = contractUploadFields();
    expect(typeof bountyAmount).toBe("string");
    expect(bountyAmount).toMatch(/^[1-9][0-9]*$/);
    // At least 1 gwei: an ETH figure such as "0.01" or "1" would fail this.
    expect(BigInt(bountyAmount as string)).toBeGreaterThanOrEqual(10n ** 9n);
  });

  it("satisfies ContractSubmissionFieldsSchema", () => {
    const { file, ...fields } = contractUploadFields();
    expect(file).toEqual({ file: "Sample.sol" });
    const parsed = ContractSubmissionFieldsSchema.safeParse(fields);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("would have caught an ETH-denominated bounty", () => {
    const fields = contractUploadFields();
    expect(
      ContractSubmissionFieldsSchema.safeParse({ ...fields, bountyAmount: "0.01" }).success,
    ).toBe(false);
  });
});
