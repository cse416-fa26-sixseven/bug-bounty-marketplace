# PoC sandbox on AKS — implementation plan

**Spec:** `docs/superpowers/specs/2026-11-05-sandbox-aks-design.md` (read it first; §4 pins the
interfaces between the three work areas).

**Branch:** `feat/sandbox-aks` from `main`, worktree `../bbm-sandbox-aks`. One PR into `main`.

**Goal:** analysis service and Kata-isolated PoC sandbox deployed on test, staging and prod; T18
pipeline tests run in `integration-azure.yml`.

## Global constraints

- Three agents work in parallel on disjoint files (below). Nobody edits another area's files; a
  needed cross-area change is reported back to the coordinator.
- No `git commit`/`stash`/`checkout` by agents; the coordinator commits per area.
- Node: `export PATH=~/.local/node/current/bin:$PATH` (20.20.2; CI runs Node 22 from `.nvmrc`).
  Python: `uv` 0.13. No Docker on this machine: Docker-marked tests and image builds run in CI.
- Unit tests never open a network socket (`pytest-socket`; vitest mocks).
- Conventional Commits, small and scoped.

## Area W — worker (`workers/analysis/**`, `workers/sandbox/README.md`, `docs/workers.md`)

- [ ] `config.py`: `sandbox_backend`, `sandbox_namespace`, `sandbox_job_template` (§4.1); tests.
- [ ] `sandbox.py`: keep the Docker backend; export the shared pieces (`SandboxResult`,
      `build_tarball`, `forge_passed`, `truncate_log`, `STARTED_MARKER`, script builder with a
      `tar_source` argument).
- [ ] `sandbox_k8s.py` (new): `KubeApi` protocol + `KubernetesApi` adapter over the official
      `kubernetes` client; `run_poc_k8s(tar, poc_id, settings, api=...)` per §4.2–4.3: delete
      leftover Job of the same name, create Secret, create Job, patch Secret ownerReference, poll
      Job status (2 s) until succeeded/failed or `activeDeadlineSeconds + 60`, read the pod log and
      container exit code, map to `SandboxResult` exactly like the Docker backend, delete Job
      (Background) and Secret in `finally`.
- [ ] `sandbox_job.py`: pick the runner from `settings.sandbox_backend`.
- [ ] `pyproject.toml`: add `kubernetes` and `pyyaml`; `uv lock`; Dockerfile unchanged except
      nothing (docker CLI stays for Compose).
- [ ] Tests: `tests/test_sandbox_k8s.py` with a fake `KubeApi` (pass, fail, 137, never started →
      infra error + retry, deadline exceeded while Pending, leftover job deleted first, Secret and
      Job cleaned up on every path, name sanitisation, template filling). Extend `test_config.py`
      and `test_sandbox_job.py` for backend selection.
- [ ] `uv run ruff check . && uv run ruff format --check . && uv run pytest -q` green.
- [ ] Docs: `README.md` (worker), `.env.example`, `workers/sandbox/README.md` ("Running it on
      AKS"), `docs/workers.md`.

## Area H — Helm (`deploy/helm/bbm/**`, `deploy/helm/README.md`)

- [ ] `_helpers.tpl`: `bbm.sandboxNamespace`, `bbm.sandboxImage`.
- [ ] `sandbox.yaml`: namespace `<ns>-sandbox` (PSA restricted labels), Role/RoleBinding for
      `bbm-analysis` (verbs of §3), ResourceQuota, LimitRange, deny-all NetworkPolicy; drop the
      runner ServiceAccount and the `sandboxClientId` requirement; ConfigMap
      `bbm-sandbox-job-template` moves to the release namespace with the §4.2 template.
- [ ] `api.yaml` + new `pvc.yaml`: `api.sourceStorage.persistentVolumeClaim` (§4.4).
- [ ] `analysis.yaml`: env of §4.1, template ConfigMap mount at `/etc/bbm/sandbox`, sources PVC
      mount read-only, `automountServiceAccountToken: true` at pod level when `sandbox.enabled`,
      `JOB_LEASE_SECONDS`.
- [ ] `values.yaml`, `values.schema.json`, `values-test.yaml`, `values-staging.yaml`,
      `values-prod.yaml` (analysis + sandbox on, PVC on; `values-ci.yaml` unchanged unless needed).
- [ ] `helm lint --strict` on every layer, `helm template ... --set analysis.enabled=true --set
      sandbox.enabled=true` renders for staging/prod/ci and the values-test layering used in
      `ci.yml`; `ct lint` config untouched.
- [ ] `deploy/helm/README.md`: sandbox section.

## Area T — Terraform, workflows, tests, docs

Files: `infra/**`, `.github/workflows/**`, `tests/**`, `docs/adr/0004-*.md`,
`docs/devops/{architecture,cost,azure-bootstrap}.md`, `README.md` (only if a command changes).

- [ ] tfvars + module default per §4.6; `terraform fmt`/`validate` on `modules/aks` and
      `stacks/compute`; `infra/up.sh` quota needs include the sandbox pool; `infra/lib` self-tests.
- [ ] `_build-push.yml`: `sandbox` service; callers' default service lists; `deploy.yml` image
      check includes `bbm/sandbox:<tag>`; `infra-janitor.yml` purges `bbm/sandbox` like the others
      and deletes `<ns>-sandbox` with an expired `<ns>`; `ci.yml` `changes.sandbox` filter adds
      `sandbox_k8s.py` and `tests/test_sandbox_k8s.py`.
- [ ] `integration-azure.yml`: `BBM_PIPELINE=1` on the test job; `_ephemeral-env.yml` sets
      `--set analysis.sandbox.image.repository=<prefix>/sandbox` for previews like api/web.
- [ ] `tests/integration/pipeline.test.ts` per §4.7; `tests/lib/env.ts` flag; `tests/README.md`.
- [ ] `infra/terraform/scripts/kata-spike.sh` per §5 (shellcheck-clean).
- [ ] ADR 0004; architecture.md (components table: `sandbox` image; sandbox section; environments
      table: analysis on AKS); cost.md (`Standard_D2as_v7` pool, Azure Files); azure-bootstrap.md
      quota table (Dasv7 family +2 vCPU per env).
- [ ] actionlint is run in CI (no Docker here); `bash -n` and shellcheck if installed.

## Coordinator

- [ ] Commit per area; `pnpm -r lint/typecheck` for `tests/`; push; `gh pr create` into `main`.
- [ ] Wait for CI; fresh reviewer agent on the diff (correctness/tests, schema consistency,
      accidental real network calls, scope creep); fix; merge with a merge commit.
- [ ] Rollout §6: apply test, spike, re-run integration-azure, apply staging/prod, CD, prod
      approval by the required reviewer.
