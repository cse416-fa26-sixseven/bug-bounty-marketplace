/* global __ENV */
// k6 baseline load test for the API ("stability under sustained load").
//
//   docker run --rm -i -e BASE_URL=http://host.docker.internal:3001 \
//     grafana/k6:2.3.0 run - < tests/load/api-baseline.js
//
// Env:
//   BASE_URL   API origin (required in CI; defaults to local compose)
//   SOAK=1     also run the 10-minute constant-load soak scenario
//   THINK      seconds of think time per iteration (default 1)
//   RAMP_UP / HOLD / RAMP_DOWN / VUS   override the baseline shape
//              (e.g. RAMP_UP=5s HOLD=5s RAMP_DOWN=5s for a quick sanity run)
//
// The script is self-contained (no open()) so it can be piped over stdin.
import http from "k6/http";
import { check, fail, sleep } from "k6";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:3001").replace(/\/+$/, "");
const VUS = Number(__ENV.VUS || 20);
// Think time per iteration (seconds); 0 turns the test into a max-throughput run.
const THINK = Number(__ENV.THINK ?? 1);

const scenarios = {
  baseline: {
    executor: "ramping-vus",
    startVUs: 0,
    stages: [
      { duration: __ENV.RAMP_UP || "30s", target: VUS },
      { duration: __ENV.HOLD || "1m", target: VUS },
      { duration: __ENV.RAMP_DOWN || "30s", target: 0 },
    ],
    gracefulRampDown: "10s",
  },
};

if (__ENV.SOAK === "1") {
  scenarios.soak = {
    executor: "constant-vus",
    vus: 10,
    duration: "10m",
    // Start after the baseline finishes so the two don't overlap.
    startTime: "2m10s",
  };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
  },
};

// Same contract as tests/fixtures/Sample.sol (minus its doc comments, so the
// hash differs), inlined so stdin runs work.
const SAMPLE_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract Sample {
    uint256 public value;

    function set(uint256 v) external {
        value = v;
    }
}
`;

export function setup() {
  const health = http.get(`${BASE_URL}/health`);
  if (health.status !== 200) fail(`API not healthy at ${BASE_URL}/health: ${health.status}`);

  const res = http.post(`${BASE_URL}/api/contracts`, {
    file: http.file(SAMPLE_SOL, "Sample.sol", "text/plain"),
    developerAddress: "0x000000000000000000000000000000000000dEaD",
    bountyAmount: "10000000000000000", // 0.01 ETH in wei
    currency: "ETH",
    deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  if (res.status !== 201) fail(`setup POST /api/contracts failed: ${res.status} ${res.body}`);
  return { contractId: res.json("id") };
}

export default function (data) {
  const health = http.get(`${BASE_URL}/health`, { tags: { name: "GET /health" } });
  check(health, { "health 200": (r) => r.status === 200 });

  const contract = http.get(`${BASE_URL}/api/contracts/${data.contractId}`, {
    tags: { name: "GET /api/contracts/:id" },
  });
  check(contract, {
    "contract 200": (r) => r.status === 200,
    "contract id matches": (r) => r.json("id") === data.contractId,
  });

  sleep(THINK);
}
