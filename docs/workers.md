# workers/

Non-TypeScript backend services live here (static analysis runners, PoC
sandboxes, AI explanation workers, etc.). This directory is **not** part of
the pnpm workspace — each service manages its own toolchain.

## Conventions for a new service

- Each service gets its own directory, e.g. `workers/analysis/`.
- Python services use `uv` + `pyproject.toml` for dependency management.
- Rust services use `Cargo.toml`.
- Each service has its own `Dockerfile`.
- Each service has its own path-filtered CI job, added when that service is
  created (triggered only on changes under that service's directory or
  `packages/shared/schema/**`).
- Types are generated from the JSON Schema files published at
  `packages/shared/schema/*.json` (see [@bbm/shared](shared.md)):
  - Python: `datamodel-code-generator`
  - Rust: `typify`

## Services

| Service                            | Language                  | Status  | Purpose                                                                             |
| ---------------------------------- | ------------------------- | ------- | ----------------------------------------------------------------------------------- |
| [`analysis`](../workers/analysis/) | Python 3.12 (uv, FastAPI) | running | Slither static analysis + advisory LLM explanation of findings; runs PoC sandboxes |
| [`sandbox`](../workers/sandbox/)   | Docker image (Foundry)    | running | Offline Foundry image auditors' PoCs run in, one container / Kata Job per PoC      |

### `workers/analysis`

Exposes `GET /health` (`{"status":"ok"}`) and `POST /analyze`
(`{contractId, source}` → findings), and runs the job poller that claims
`analysis` and (with `SANDBOX_ENABLED`) `sandbox` jobs from the Postgres
`jobs` table. See [`workers/analysis/README.md`](../workers/analysis/README.md).

It runs as the `analysis` service in the compose stack (`pnpm stack:up`, port
`8000`), where PoCs run in `bbm-sandbox` containers on the Docker socket
(`SANDBOX_BACKEND=docker`, `docker-compose.sandbox.yml`). CI's `analysis` job
runs ruff, pytest and the generated-models drift check.

On Azure it runs as a Deployment on AKS in every environment (test, staging,
prod; `analysis.enabled` in the Helm chart), internal-only (no route). There
it uses the **Kubernetes sandbox backend** (`SANDBOX_BACKEND=kubernetes`,
`src/analysis/sandbox_k8s.py`): each PoC becomes a Kubernetes Job in the
release's `<namespace>-sandbox` namespace on the Kata-isolated `sandbox` node
pool, built from a Job template the chart mounts at
`/etc/bbm/sandbox/job.yaml`, with the project tar delivered through a Secret.
The verdict rules are the Docker backend's; a Job that never runs the PoC
(deadline while Pending, missing started marker, API error) is a retryable
infra error. The pipeline system tests (`BBM_PIPELINE=1`) exercise this on
the test cluster; the direct `/analyze` tests still need the internal
Service, so `integration-azure.yml` keeps `BBM_SKIP_ANALYSIS=1`. Details:
[`workers/sandbox/README.md`](../workers/sandbox/README.md) ("Running it on
AKS") and the
[sandbox on AKS spec](superpowers/specs/2026-11-05-sandbox-aks-design.md).

Run locally (uv installs Python 3.12 if needed):

```sh
cd workers/analysis
uv sync
uv run ruff check . && uv run ruff format --check .
uv run pytest -q                       # pytest-socket blocks real network in unit tests
uv run uvicorn analysis.app:app --reload --port 8000
```

**Type generation.** `src/analysis/generated/models.py` (pydantic v2) is
generated from `packages/shared/schema/*.json` by `datamodel-code-generator`
and committed:

```sh
uv run scripts/gen-types.sh
git diff --exit-code src/analysis/generated   # CI drift check
```

The script bundles the standalone schema files under `$defs` so all models
land in one module, drops zod's `pattern` on `format: date-time` strings
(pydantic can't apply a regex to a datetime; the field is still an
`AwareDatetime`), and disables the timestamp header so output is
deterministic. Regenerate whenever a shared schema changes.

**Docker.** `workers/analysis/Dockerfile` is a two-stage build
(`python:3.12-slim-bookworm` + pinned `uv` binary → slim runtime with only
`/app/.venv`, non-root uid `10001`, port `8000`, `HEALTHCHECK` on `/health`).
The build context is `workers/analysis/` only, so the image uses the
committed generated models and never regenerates them.

```sh
docker build -t bbm-analysis workers/analysis
docker run --rm -p 8000:8000 bbm-analysis
```

**Planned (later branches).**

- Slither itself in an isolated Job (analysis jobs still run inside the
  analysis pod).
- Blob storage for uploads on the test cluster too (staging and prod read
  `SOURCE_STORAGE_BLOB_CONTAINER_URL`; CI-run namespaces still mount the
  shared `bbm-sources` PVC).
- Consume jobs from an Azure Storage Queue (`analysis-jobs`), scaled by KEDA,
  instead of polling the Postgres `jobs` table.
