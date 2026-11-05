# workers/analysis

Python service that runs [Slither](https://github.com/crytic/slither) static
analysis on uploaded Solidity contracts, maps detector results onto the shared
`Finding` schema, and attaches a plain-English LLM explanation to each finding.
The LLM output is **advisory only**: it never changes a finding's status or
payout, and if it fails each finding falls back to Slither's own text.

- `GET /health`: liveness.
- `POST /analyze` `{contractId, source}`: stateless analysis, returns the
  findings (422 with the reason for an unsupported pragma or a compile error).
- **Job poller:** when `DATABASE_URL` and `SOURCE_STORAGE_DIR` are set, a
  background thread claims jobs from the Postgres `jobs` table the API writes
  (`FOR UPDATE SKIP LOCKED`, leases, up to 3 attempts), analyses the stored
  source, and writes `Flagged` findings. Also runnable alone as
  `uv run bbm-analysis-worker`. Design:
  [analysis pipeline spec](../../docs/superpowers/specs/2026-10-19-analysis-pipeline-design.md).

The supported solc versions are listed in `src/analysis/solc-versions.txt`; the
image pre-installs them. A pragma no version satisfies fails with
`Unsupported Solidity version: <pragma>`.

| Variable | Default | Effect |
| --- | --- | --- |
| `DATABASE_URL`, `SOURCE_STORAGE_DIR` | unset | Both set: run the job poller (same Postgres and storage as the API). |
| `LLM_ENDPOINT`, `LLM_MODEL`, `LLM_API_KEY` | unset | OpenAI-compatible chat endpoint (e.g. Azure AI Foundry `https://<resource>.services.ai.azure.com/openai/v1`). Any unset: Slither text only. |
| `LLM_TIMEOUT_SECONDS` | `90` | Per-attempt LLM timeout (one retry). Reasoning models take ~20-30 s per contract. |
| `POLL_INTERVAL_SECONDS` | `1` | Wait between polls when the queue is empty. |
| `JOB_LEASE_SECONDS` / `JOB_MAX_ATTEMPTS` | `600` / `3` | Lease before a crashed job is retried; attempts before it fails. |
| `WORKER_CONCURRENCY` | `2` | Jobs processed at once. |
| `SANDBOX_ENABLED` | unset | `true`: also claim sandbox jobs and re-run auditors' PoCs in the `bbm-sandbox` image (see [workers/sandbox](../sandbox/README.md)). |
| `SANDBOX_BACKEND` | `docker` | `docker`: throwaway containers on the Docker socket (`docker-compose.sandbox.yml`). `kubernetes`: one Kubernetes Job per PoC in `SANDBOX_NAMESPACE` (AKS; see below). |
| `SANDBOX_IMAGE` | `bbm-sandbox:latest` | Image of the PoC container / Job pod. |
| `SANDBOX_TIMEOUT_SECONDS` / `CHALLENGE_WINDOW_SECONDS` | `120` / `86400` | In-container PoC time limit (`timeout -s KILL`, both backends); how long a Verified finding can be disputed. |
| `SANDBOX_NAMESPACE` | unset | kubernetes: namespace the Jobs and Secrets are created in. Required with that backend (otherwise sandbox jobs fail as retryable infra errors and the worker logs why at start-up). |
| `SANDBOX_JOB_TEMPLATE` | `/etc/bbm/sandbox/job.yaml` | kubernetes: the Job template (the chart's `bbm-sandbox-job-template` ConfigMap, mounted into the pod). |

Locally, put these in `workers/analysis/.env` (git-ignored; see
`.env.example`); the service and the compose stack read it.

Run **one** poller per database. Every poller with `DATABASE_URL` set claims
jobs; a host-run poller (e.g. `uv run uvicorn ...` with `.env`) next to the
compose `analysis` service would claim jobs whose sources live in the compose
volume and fail them as "Source file not found". Leave `DATABASE_URL` unset in
`.env` when the compose stack is running.

### Sandbox on Kubernetes (`SANDBOX_BACKEND=kubernetes`)

On AKS the worker holds no Docker socket. `src/analysis/sandbox_k8s.py` runs
each PoC as a Kubernetes **Job** instead, with the same verdict rules as the
Docker backend (`src/analysis/sandbox.py`), and the same script inside the
container. Per PoC it:

1. loads the Job template from `SANDBOX_JOB_TEMPLATE` (PyYAML) and fills in
   only `metadata.name` (`poc-<sanitised id>`, a deterministic DNS label),
   `metadata.namespace`, the container `image` and `command`, and the
   `project` volume's `secret.secretName`; runtimeClass, node selector,
   security context, resources, `activeDeadlineSeconds` and the rest are the
   chart's;
2. deletes a leftover Job/Secret of the same name (a retry after a crash),
   waits for the Job to be gone, stores the project tar in Secret
   `poc-<id>` (key `project.tar`, mounted read-only at `/in`), creates the
   Job and gives the Secret an `ownerReference` to it;
3. polls the Job every 2 s until it is `Complete` or `Failed`, waiting at
   most the template's `activeDeadlineSeconds` + 60 s (the sandbox node pool
   scales from zero, so the first PoC after an idle period waits for a node;
   `JOB_LEASE_SECONDS` is 900 on AKS so the job lease outlives this wait);
4. reads the container's exit code and the pod log. No
   `bbm-sandbox-started` line, a deadline hit, or an API error is an infra
   error (job retried); otherwise exit 137 → `Failed` naming both limits,
   exit 0 with a passing suite → `Passed`, else `Failed`;
5. deletes the Job (propagation `Background`) and the Secret in a `finally`.

It uses in-cluster config (the pod's ServiceAccount token) through the
official `kubernetes` client, behind the small `KubeApi` protocol; the unit
tests (`tests/test_sandbox_k8s.py`) use an in-memory fake and open no
socket. The RBAC the ServiceAccount needs (Jobs, Pods, pods/log, Secrets in
the sandbox namespace only) is in the Helm chart. Design:
[sandbox on AKS spec](../../docs/superpowers/specs/2026-11-05-sandbox-aks-design.md).

## Develop

Requires [uv](https://docs.astral.sh/uv/) (it installs Python 3.12 for you).

```sh
cd workers/analysis
uv sync                                   # create .venv with runtime + dev deps
uv run ruff check . && uv run ruff format --check .
uv run pytest -q                          # sockets disabled via pytest-socket
# DB tests (job queue, analysis jobs) need Postgres; they use <db>_worker_test:
DATABASE_URL=postgres://bbm:bbm@127.0.0.1:5432/bbm uv run pytest -q
xargs -a src/analysis/solc-versions.txt -n1 uv run solc-select install
uv run pytest -m slither -q               # real Slither on the fixture contract
uv run uvicorn analysis.app:app --reload --port 8000
```

```sh
curl localhost:8000/health
curl -X POST localhost:8000/analyze -H 'content-type: application/json' \
  -d '{"contractId":"c1","source":"pragma solidity ^0.8.0;"}'
```

## Shared types

`src/analysis/generated/models.py` is generated from
`packages/shared/schema/*.json` with `datamodel-code-generator` (pydantic v2)
and committed. Do not edit it by hand; regenerate after schema changes:

```sh
uv run scripts/gen-types.sh
git diff --exit-code src/analysis/generated   # what CI checks for drift
```

## Docker

The image does **not** regenerate types (the schema directory is outside the
build context), it uses the committed `generated/models.py`.

```sh
docker build -t bbm-analysis workers/analysis
docker run --rm -p 8000:8000 bbm-analysis
```
