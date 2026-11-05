/** Where the system under test lives. Defaults match `pnpm stack:up`
 * (docker-compose.yml); CI and the Azure workflows override them. */
export const env = {
  apiUrl: (process.env.BBM_API_URL ?? "http://localhost:3001").replace(/\/+$/, ""),
  webUrl: (process.env.BBM_WEB_URL ?? "http://localhost:3000").replace(/\/+$/, ""),
  analysisUrl: (process.env.BBM_ANALYSIS_URL ?? "http://localhost:8000").replace(/\/+$/, ""),
  rpcUrl: (process.env.BBM_RPC_URL ?? "http://localhost:8545").replace(/\/+$/, ""),
  /** JSON written by the contracts-deploy compose service. */
  deploymentsFile: process.env.BBM_DEPLOYMENTS_FILE ?? ".ci/deployments/31337.json",
  /** BBM_PIPELINE=1 runs integration/pipeline: upload -> Slither findings ->
   * claim -> PoC in the sandbox -> Verified / Rejected, through the API only.
   * Needs the analysis worker with a sandbox backend (compose with
   * docker-compose.sandbox.yml, or an AKS namespace with the Kata pool). */
  pipeline: process.env.BBM_PIPELINE === "1",
};
