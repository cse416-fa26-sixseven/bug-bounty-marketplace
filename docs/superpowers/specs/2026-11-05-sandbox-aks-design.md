# PoC sandbox and analysis service on AKS (Milestone 5)

- **Owner:** Pranav Jothivel (DevOps)
- **Date:** 2026-11-05
- **Due:** Milestone 5, 2026-11-21 (test env first; staging and prod through CD)
- **Requirements covered:** R6, R12, R19 (sandbox), R2/R3 (analysis service deployed), M3 grader
  feedback: "Separate the untrusted PoC runner with least-privilege isolation", "no-network
  enforcement on every deployment environment", "automate real E2E in CI" (T18).
- **Amends:** ADR 0001 §8 (sandbox), ADR 0002 §8 (node pools). Recorded as ADR 0004.

## 1. Goal

Run the analysis service (Slither + LLM worker) and the auditor PoC sandbox on every AKS
environment, so a deployed environment can analyse a contract and verify a PoC exactly like the
Compose stack does, with the PoC isolated at the hypervisor level instead of the Docker socket.

After this change:

1. `analysis` runs as a Deployment in the release namespace of test, staging and prod.
2. A `sandbox` job is executed as a Kubernetes **Job** on a dedicated Kata (`KataVmIsolation`)
   node pool, in a per-release namespace with a deny-all NetworkPolicy, PSA `restricted`, a
   ResourceQuota and a hard deadline. The worker never holds a Docker socket.
3. `integration-azure.yml` runs the upload → Flagged and claim → PoC → verdict path against the
   test-cluster namespace on every push to `main` (T18).
4. Local Compose is unchanged: the Docker backend stays for `docker-compose.sandbox.yml`.

## 2. Scope

**In scope**

- `workers/analysis`: a second sandbox backend (`SANDBOX_BACKEND=kubernetes`) behind the
  existing `run_poc` contract; the Docker backend is untouched.
- `deploy/helm/bbm`: the sandbox stub becomes real (per-release namespace, RBAC for the analysis
  ServiceAccount, Job template delivered to the worker, sources shared through an Azure Files
  ReadWriteMany PVC); analysis and sandbox turned on in `values-test/staging/prod.yaml`.
- `infra/terraform`: the Kata `sandbox` pool enabled on all three envs on `Standard_D2as_v7`
  (0–1 nodes); `up.sh` quota check covers it.
- Workflows: `_build-push.yml` builds and pushes `bbm/sandbox`; `deploy.yml` checks it exists;
  `integration-azure.yml` runs the pipeline tests (T18); a Kata spike script.
- Docs: ADR 0004, `docs/devops/architecture.md`, `cost.md`, `azure-bootstrap.md` (quota),
  `docs/workers.md`, `workers/sandbox/README.md`, `deploy/helm/README.md`, `tests/README.md`.

**Out of scope**

- Slither in an isolated Job (analysis jobs keep running in the analysis pod).
- The Blob storage adapter for uploads (M5, analysis-pipeline lead). The RWX PVC is the interim
  way to share sources between the api and analysis pods; the API stays at one replica.
- Chain mode in staging/prod (M5, separate PR). The PoC verdict path in T18 runs in no-chain
  mode exactly like the Compose `system` job.
- KEDA / Storage Queue scaling. The worker polls the Postgres `jobs` table as today.
- Trivial-PoC rejection (M3 feedback; analysis-pipeline lead).

## 3. Architecture

```
release namespace <ns> (bbm, run-<id>-<attempt>, pr-<n>)        namespace <ns>-sandbox (PSA restricted, deny-all)
┌───────────────────────────────────────────────────────┐        ┌───────────────────────────────────────────┐
│ api ──writes──▶ PVC bbm-sources (Azure Files, RWX)     │        │ Job poc-<id>  (runtimeClass kata-vm-isolation│
│                     ▲ read-only                        │        │   node pool `sandbox`, 1 CPU / 1 GiB,       │
│ analysis (SA bbm-analysis, token mounted)              │        │   no SA token, read-only root, /tmp emptyDir)│
│   claims jobs(kind=sandbox) from Postgres ────────────────────▶ │   /in/project.tar  ◀── Secret poc-<id>      │
│   ConfigMap bbm-sandbox-job-template @ /etc/bbm/sandbox│  K8s   │   sh -c "tar -x; timeout forge test; tail"  │
│   creates Secret + Job, polls, reads pod log, deletes  │  API   │   (no network: deny-all + no DNS)           │
└───────────────────────────────────────────────────────┘        └───────────────────────────────────────────┘
```

- **Isolation.** Each PoC runs in its own Kata VM (AKS pod sandboxing, Azure Linux node pool with
  `workload_runtime = "KataVmIsolation"`, RuntimeClass `kata-vm-isolation`). The pod has no
  ServiceAccount token, no network (deny-all NetworkPolicy, no DNS rule), capabilities dropped,
  `readOnlyRootFilesystem`, `runAsNonRoot` uid 10001, `seccompProfile: RuntimeDefault`,
  resources 1 CPU / 1 GiB / 1 GiB ephemeral, `activeDeadlineSeconds: 600` on the Job plus
  `timeout -s KILL 120` inside the container (same two-level limit as the Docker backend).
- **Least privilege for the runner.** The analysis ServiceAccount gets a namespaced Role in
  `<ns>-sandbox` only: Jobs (create/get/list/watch/delete), Pods (get/list/watch), pods/log (get),
  Secrets (create/get/patch/delete; patch for the ownerReference). Nothing in the release
  namespace and nothing cluster-wide.
- **How the project reaches the VM.** The worker builds the same tar as today
  (`build_tarball`) and stores it in a Secret `poc-<id>` (key `project.tar`, ≤ ~210 KB: two
  100 KB sources plus `foundry.toml`), mounted read-only at `/in`. No image build, no network
  pull, no shared volume into the sandbox. The Secret gets an ownerReference to the Job so it is
  garbage-collected with it; the worker also deletes both in `finally`.
- **Verdict.** Identical to the Docker backend: the pod log must start with
  `bbm-sandbox-started` (otherwise the sandbox itself failed → `infra_error`, job retried);
  exit 137 → `Failed` naming both limits; exit 0 and `forge_passed(output)` → `Passed`; else
  `Failed`. Logs are capped in-container (`tail -c 262144`) and truncated to the last 64 KB.
- **Sources.** `api` writes uploads to `SOURCE_STORAGE_DIR=/data/sources` on PVC `bbm-sources`
  (`storageClassName: azurefile-csi`, `ReadWriteMany`, 5 Gi; dynamically provisioned, so a test
  namespace gets its own share and loses it with the namespace). `analysis` mounts the same claim
  read-only at the same path. Compose and kind keep the emptyDir (`persistentVolumeClaim.enabled:
  false`).
- **Scale-from-zero.** The pool autoscales 0→1. The first PoC after an idle period waits for a
  node (3–5 min). `activeDeadlineSeconds: 600` covers it; the worker waits
  `activeDeadlineSeconds + 60 s` and the Helm chart sets `JOB_LEASE_SECONDS=900` so the lease
  outlives the wait (otherwise another worker would re-claim and run the PoC twice).

## 4. Interfaces (pinned; each agent implements its side exactly)

### 4.1 Worker environment (read in `workers/analysis/src/analysis/config.py`)

| Variable                  | Default                     | Meaning                                                             |
| ------------------------- | --------------------------- | ------------------------------------------------------------------- |
| `SANDBOX_ENABLED`         | unset (false)               | Claim `sandbox` jobs (either backend).                              |
| `SANDBOX_BACKEND`         | `docker`                    | `docker` (socket, Compose) or `kubernetes` (Jobs, AKS).             |
| `SANDBOX_IMAGE`           | `bbm-sandbox:latest`        | Image of the PoC container / Job pod.                               |
| `SANDBOX_TIMEOUT_SECONDS` | `120`                       | In-container `timeout -s KILL`, both backends.                      |
| `SANDBOX_NAMESPACE`       | unset                       | kubernetes: namespace the Jobs and Secrets are created in.          |
| `SANDBOX_JOB_TEMPLATE`    | `/etc/bbm/sandbox/job.yaml` | kubernetes: path of the Job template (mounted ConfigMap).           |
| `SOURCE_STORAGE_DIR`      | unset                       | Where uploads are read from (shared PVC on AKS).                    |
| `JOB_LEASE_SECONDS`       | `600`                       | Existing; Helm sets 900 on AKS (see §3).                            |

`Settings.job_kinds` keeps its meaning. `SANDBOX_BACKEND=kubernetes` without `SANDBOX_NAMESPACE`
is a startup configuration error (log and treat sandbox jobs as infra errors).

### 4.2 Job template contract (ConfigMap `bbm-sandbox-job-template`, key `job.yaml`)

Rendered by Helm in the **release** namespace and mounted into the analysis pod at
`/etc/bbm/sandbox/job.yaml`. The worker loads it with PyYAML and fills in exactly:

- `metadata.name` = `poc-<sanitised poc id>` (lowercase, `[a-z0-9-]`, ≤ 63 chars; deterministic
  so a retry can delete a leftover Job of the same name first, like the Docker backend does with
  container names). `metadata.generateName` is removed if present.
- `metadata.namespace` = `SANDBOX_NAMESPACE`.
- `spec.template.spec.containers[0].image` = `SANDBOX_IMAGE`.
- `spec.template.spec.containers[0].command` = `["sh", "-c", <script>]` where the script is the
  Docker backend's script with `tar -x -f /in/project.tar` instead of stdin.
- the volume named `project`: `secret.secretName` = the Secret's name (`poc-<id>`).

Everything else (runtimeClassName, nodeSelector, tolerations, securityContext, resources,
`activeDeadlineSeconds`, `ttlSecondsAfterFinished`, `backoffLimit: 0`, `restartPolicy: Never`,
`automountServiceAccountToken: false`, `enableServiceLinks: false`) comes from the template and is
owned by Helm. The template declares two volumes: `tmp` (emptyDir, `sizeLimit: 256Mi`, mounted at
`/tmp`) and `project` (secret, `secretName: REPLACED_BY_RUNNER`, mounted read-only at `/in`).
The container has `image: REPLACED_BY_RUNNER`. `HOME=/tmp` is already set in the image.

### 4.3 Kubernetes access from the worker

- In-cluster config (`kubernetes.config.load_incluster_config()`), so the analysis pod has
  `automountServiceAccountToken: true` (pod-level, set by the chart when `sandbox.enabled`).
- The worker talks to the API server on 443, which the existing analysis egress policy already
  allows. No new NetworkPolicy for the analysis pod.
- A `KubeApi` protocol wraps the handful of calls (create/patch/get/delete Secret, create/get/
  delete Job, list Pods by `job-name`, read pod log) so unit tests use a fake and never open a
  socket.

### 4.4 Helm values (new or changed keys)

```yaml
api:
  sourceStorage:
    path: /data/sources
    sizeLimit: 1Gi               # emptyDir when the claim is disabled
    persistentVolumeClaim:
      enabled: false             # true on test/staging/prod
      existingClaim: ""          # use a pre-created claim instead of rendering one
      storageClassName: azurefile-csi
      accessModes: [ReadWriteMany]
      size: 5Gi
analysis:
  enabled: false                 # true on test/staging/prod
  sandbox:
    backend: kubernetes          # SANDBOX_BACKEND; "docker" is Compose-only
    timeoutSeconds: 120
    image:
      repository: bbm/sandbox
      tag: ""                    # defaults to global.image.tag
  jobLeaseSeconds: 900
sandbox:
  enabled: false                 # true on test/staging/prod
  namespace: ""                  # "" = <release namespace>-sandbox
  jobTemplate: { ...as today, plus the tmp/project volumes of §4.2... }
  quota: { ...as today... }
```

- The `bbm-sandbox-runner` ServiceAccount and `azure.sandboxClientId` requirement go away: the
  Job pod needs no identity and the RoleBinding subject is `system:serviceaccount:<ns>:bbm-analysis`.
  `azure.sandboxClientId` stays in `values.yaml` (terraform still emits it) but is unused.
- `values.schema.json`, `helm lint --strict` on every layer and `ct lint` stay green;
  `helm template ... --set analysis.enabled=true --set sandbox.enabled=true | kubeconform` (ci.yml)
  must pass.

### 4.5 Images and tags

- `_build-push.yml` gains service `sandbox`: context `workers`, file
  `workers/sandbox/Dockerfile`, `linux/amd64` only, pushed as `<acr>/<prefix>/sandbox:<tag>`.
  It is in the default services list, so every main push and PR preview builds it.
- The chart passes `SANDBOX_IMAGE=<global.image.registry>/<analysis.sandbox.image.repository>:<tag>`
  (PR previews use `bbm-preview/sandbox` through the same `--set` pattern as api/web).
- `deploy.yml`'s "image exists in ACR" check must include the sandbox image (it is an env value,
  not a pod image, so it has to be added explicitly).

### 4.6 Terraform

- `envs/{test,staging,prod}/compute.tfvars`: `sandbox_pool_enabled = true`,
  `sandbox_vm_size = "Standard_D2as_v7"`, `sandbox_max_count = 1`.
- `modules/aks` `sandbox_pool.vm_size` default `Standard_D2as_v7`; descriptions no longer say
  "Dsv5" (Dasv7 is Gen2 with nested virtualisation; the family this subscription has quota for).
- `infra/up.sh` step 4 adds the sandbox pool (`sandbox_vm_size × sandbox_max_count`) to each env's
  vCPU needs when `sandbox_pool_enabled` is true. `infra/lib` self-tests updated.
- Nothing changes in `data`; the sandbox UAMI and its federated credential stay (unused, harmless;
  removal is a separate change).

### 4.7 T18: pipeline tests on the test cluster

- New `tests/integration/pipeline.test.ts`, enabled by `BBM_PIPELINE=1`, driven only through the
  API (`BBM_API_URL`): upload `Vault.sol` → poll `/api/contracts/:id/findings` until a
  `reentrancy-eth` finding is `Flagged` (≤ 5 min; first run includes Slither warm-up); then the
  no-chain auditor path (stake, claim, `POST /api/auditor/poc` with `tests/fixtures/pocs/PoC_pass.t.sol`)
  → poll until `Verified` (≤ 12 min: Kata node scale-up from zero + the run); then `PoC_fail.t.sol`
  on a second finding or a second contract → `Rejected`. Whatever `tests/integration/api.test.ts`
  and `tests/lib` already provide for sign-in, stake and claim is reused, not duplicated.
- `integration-azure.yml` keeps `BBM_SKIP_ANALYSIS=1` (the direct `/analyze` tests need the
  internal Service) and adds `BBM_PIPELINE=1`.
- The same test runs locally against `pnpm stack:up` with the sandbox overlay (documented in
  `tests/README.md`); it is not added to `ci.yml`'s compose job in this change.

## 5. Kata spike (first thing after `terraform apply` on test)

`infra/terraform/scripts/kata-spike.sh <env>`: `az aks get-credentials`, creates namespace
`kata-spike`, applies a Pod with `runtimeClassName: kata-vm-isolation`, the sandbox pool
nodeSelector/toleration and the sandbox image (`forge --version && uname -r && cat
/proc/cpuinfo | head`), waits up to 10 min (scale-up), prints the log and whether the guest kernel
differs from the node's, then deletes the namespace. Exit 0 only if the pod ran under Kata.
If it fails on `Standard_D2as_v7`, the fallback is documented in ADR 0004 (ACI backend), not
silently downgrading to runc.

## 6. Rollout

1. PR `feat/sandbox-aks` → `main` (CI OK, fresh reviewer agent, merge commit).
2. `tf.sh compute test apply` (adds the pool; no cluster recreate), then
   `az aks update -g rg-bbm-test-compute-<abbr> -n aks-bbm-test-<abbr>` to reconcile the cluster:
   a KataVmIsolation pool added to an existing cluster does not install the RuntimeClass
   `kata-vm-isolation` until then (`kata-spike.sh` runs the same update when it finds the
   RuntimeClass missing). Then `kata-spike.sh test`.
3. Push to `main` already triggered `integration-azure.yml`; re-run it so T18 runs with the pool
   present. Fix forward if red.
4. `tf.sh compute staging apply`, `tf.sh compute prod apply`, each followed by the same
   `az aks update` reconcile; CD deploys the next green `main` to staging automatically and to
   prod after the reviewer approves.
5. Record cost: the pool is 0 nodes when idle; a running `Standard_D2as_v7` node is billed per
   hour plus the Azure Files share (pennies). `cost.md` carries the figures.

## 7. Risks

| Risk                                                        | Mitigation                                                                                   |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Kata not supported on Dasv7 (docs give no SKU list)         | Spike before enabling in staging/prod; ACI backend documented as fallback.                   |
| Dasv7 needs NVMe-capable node image                         | Azure Linux 3 on AKS 1.34 supports NVMe; the spike proves it.                                |
| Job stuck Pending (quota, taint mismatch)                   | `activeDeadlineSeconds` fails it; no started marker → retryable infra error; job retried 3×. |
| Secret size limit (1 MiB)                                   | Sources are capped at 100 KB each by the API.                                                |
| Azure Files uid/gid semantics                               | `azurefile-csi` mounts with 0777 modes; api (uid 1000) writes, analysis (10001) reads.       |
| Test-cluster namespaces each get a sandbox namespace        | Named `<ns>-sandbox`; deleted when the janitor deletes `<ns>` (add it to the janitor sweep).  |
| Worker waits longer than its job lease                      | Lease 900 s > wait 660 s.                                                                    |
