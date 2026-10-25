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

| Service                            | Language                  | Status   | Purpose                                                        |
| ---------------------------------- | ------------------------- | -------- | -------------------------------------------------------------- |
| [`analysis`](../workers/analysis/) | Python 3.12 (uv, FastAPI) | skeleton | Slither static analysis + advisory LLM explanation of findings |

### `workers/analysis`

Currently exposes `GET /health` (`{"status":"ok"}`) and a stub
`POST /analyze` (`{contractId, source}` → `501`). See
[`workers/analysis/README.md`](../workers/analysis/README.md).

It runs as the `analysis` service in the compose stack (`pnpm stack:up`, port
`8000`). CI's `analysis` job runs ruff, pytest and the generated-models drift
check. On Azure (AKS) it is internal-only and off by default in the Helm chart
(`analysis.enabled`, scaled by KEDA when on),
so the system tests run there with `BBM_SKIP_ANALYSIS=1`.

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

- Real `/analyze` pipeline: run Slither in a sandbox (no network, resource
  and time limits) → map detector results to the shared `Finding` schema
  (initial status `Flagged`) → LLM plain-English `llmExplanation`, advisory
  only (never changes status or payout).
- The image will need Slither plus `solc-select` (and pinned `solc`
  versions installed at build time, since runtime has no network).
- Consume jobs from an Azure Storage Queue (`analysis-jobs`), scaled by KEDA,
  instead of (or alongside) the synchronous HTTP endpoint.
