# ADR 0004: PoC sandbox and analysis service on AKS

- **Status:** Accepted
- **Date:** 2026-11-05
- **Scope:** `workers/analysis/**`, `workers/sandbox/**`, `deploy/helm/bbm/**`,
  `infra/terraform/{envs,modules/aks,stacks/compute}/**`, `infra/up.sh`, `.github/workflows/**`,
  `tests/integration/pipeline.test.ts`
- **Amends:** [ADR 0001](0001-azure-environment-topology.md) §8 (sandbox: namespace, identity,
  "disabled by default", Dsv5), [ADR 0002](0002-aks-everywhere-and-azure-dns.md) §8 and
  [ADR 0003](0003-shared-subscription-isolation.md) §4 (node layout and quota: a second pool per
  cluster). Everything else in 0001–0003 still holds. Design:
  `docs/superpowers/specs/2026-11-05-sandbox-aks-design.md`.

## Context

- The product's verdict on a finding is the sandbox: an auditor's Foundry PoC is re-run and only a
  passing run moves the finding to `Verified`. Until now that path existed only in Docker Compose
  (`docker-compose.sandbox.yml`): the analysis worker mounted the Docker socket and ran the PoC
  in a throwaway `bbm-sandbox` container. No AKS environment ran the analysis worker at all
  (`analysis.enabled: false` everywhere), so a deployed environment could neither analyse a
  contract nor verify a PoC, and the T18 pipeline tests could only run against Compose.
- A PoC is untrusted code chosen by the auditor. The M3 review asked for the runner to be separated
  from the rest of the system with least privilege, for the no-network rule to be enforced on
  **every** deployment environment, and for the real end-to-end path to run in CI.
- ADR 0001 §8 reserved a Kata (`KataVmIsolation`) node pool and a `bbm-sandbox` namespace with a
  runner ServiceAccount and identity, but left the pool off because the old subscription had no
  quota for a nested-virtualisation size (Dsv5). The current subscription (ADR 0003) offers the
  Dasv7 family, which is Gen2 with nested virtualisation.
- Uploaded sources live on the API pod's local disk (`SOURCE_STORAGE_DIR`, an `emptyDir`); the
  analysis worker on AKS has no way to read them. The Blob storage adapter that fixes this
  properly is a separate milestone.

## Decision

### 1. One Kata `sandbox` pool per cluster, on every env

- `envs/{test,staging,prod}/compute.tfvars`: `sandbox_pool_enabled = true`,
  `sandbox_vm_size = "Standard_D2as_v7"`, `sandbox_max_count = 1` (min 0). The module default
  (`modules/aks`, `stacks/compute`) is `Standard_D2as_v7` too; nothing says Dsv5 any more.
- The pool is an Azure Linux user pool with `workload_runtime = "KataVmIsolation"`, label
  `bbm.io/pool=sandbox` and taint `bbm.io/sandbox=true:NoSchedule`, autoscaled **0 → 1**. It has
  no node while no PoC runs; the first PoC after an idle period waits 3–5 minutes for a node.
  `az aks stop` (env-power `pause`) stops it like any other pool.
- `infra/up.sh` step 4 adds `sandbox_vm_size × sandbox_max_count` (its own VM family) to each
  env's vCPU needs when the pool is enabled: **+2 Dasv7 vCPUs per env** (34 in the one region at
  max scale, ADR 0003 §4 had 28).

### 2. A PoC is a Kubernetes Job in `<release namespace>-sandbox`

- The analysis worker runs as a Deployment in the release namespace (`bbm`, `run-<id>-<attempt>`)
  with `SANDBOX_BACKEND=kubernetes`. The Docker backend stays for Compose; the backend is the only
  thing that differs, the verdict contract (`run_poc`) is shared.
- For each `sandbox` job the worker builds the same project tarball as the Docker backend
  (`build_tarball`: the contract source, the PoC, `foundry.toml`), stores it in a Secret
  `poc-<id>` (key `project.tar`), creates Job `poc-<id>` from the Helm-rendered template
  (ConfigMap `bbm-sandbox-job-template`, mounted at `/etc/bbm/sandbox/job.yaml`), patches the
  Secret's ownerReference to the Job, polls the Job every 2 s until it succeeds or fails (or
  `activeDeadlineSeconds + 60 s` pass), reads the pod log and exit code, and deletes the Job and
  Secret in `finally`. A leftover Job of the same name from a retried job is deleted first.
- The Job pod: `runtimeClassName: kata-vm-isolation`, the pool's nodeSelector and toleration,
  `automountServiceAccountToken: false`, `enableServiceLinks: false`, `runAsNonRoot` uid 10001,
  `readOnlyRootFilesystem`, all capabilities dropped, `seccompProfile: RuntimeDefault`, 1 CPU /
  1 GiB / 1 GiB ephemeral, `/tmp` emptyDir (256 Mi), the project Secret mounted read-only at
  `/in`, `activeDeadlineSeconds: 600`, `backoffLimit: 0`, `restartPolicy: Never`,
  `ttlSecondsAfterFinished`. Inside: `tar -x -f /in/project.tar; timeout -s KILL 120 forge test`
  with the output capped (`tail -c 262144`), i.e. the Docker backend's two-level time limit.
- The namespace `<ns>-sandbox` is rendered by the chart with PSA `restricted` labels, a deny-all
  NetworkPolicy (no DNS rule either), a ResourceQuota and a LimitRange. There is no network path
  out of a PoC on any environment.
- **Verdict**, identical to the Docker backend: the log must start with `bbm-sandbox-started`
  (otherwise the sandbox itself failed: `infra_error`, the job is retried up to 3×, including a
  Job that stayed Pending until its deadline); exit 137 → `Failed` naming both limits; exit 0 and
  `forge_passed(output)` → `Passed`; anything else → `Failed`. Logs are truncated to the last
  64 KB. In no-chain mode the worker moves the finding to `Verified` / `Rejected` itself; in
  chain mode it records only the verdict and the API applies it after the on-chain record
  (unchanged).
- The worker's job lease is raised to `JOB_LEASE_SECONDS=900` on AKS so it outlives the longest
  wait (660 s); otherwise a second worker would re-claim and run the PoC twice.

### 3. Least privilege

- The **analysis ServiceAccount** (`bbm-analysis`) gets one namespaced Role in `<ns>-sandbox`:
  Jobs (create/get/list/watch/delete), Pods (get/list/watch), `pods/log` (get), Secrets
  (create/get/patch/delete; patch for the ownerReference). Nothing in the release namespace,
  nothing cluster-wide. Its pod mounts
  its token only when `sandbox.enabled`, talks to the API server on 443 (already allowed by the
  analysis egress policy) and never holds a Docker socket.
- The **Job pod** has no ServiceAccount token, no identity and no network. The
  `bbm-sandbox-runner` ServiceAccount of ADR 0001 §8 is no longer rendered and
  `azure.sandboxClientId` is unused: the identity `id-bbm-<env>-sandbox` and its federated
  credential stay in `stacks/data` / `stacks/compute` (harmless, no role assignments); removing
  them is a separate Terraform change.
- The analysis pod on staging/prod reads `DATABASE_URL` from Key Vault through a second
  SecretProviderClass (`bbm-kv-analysis`); the worker identity `id-bbm-<env>-worker` already holds
  Key Vault Secrets User on the whole env vault (`stacks/data/identity.tf`), so no new role.

### 4. Sources: Azure Files until the Blob adapter lands

- The API writes uploads to `SOURCE_STORAGE_DIR=/data/sources` on PersistentVolumeClaim
  `bbm-sources` (`storageClassName: azurefile-csi`, `ReadWriteMany`, 5 Gi, dynamically
  provisioned, so a test namespace gets its own share and loses it with the namespace). The
  analysis pod mounts the same claim read-only at the same path. Compose and kind keep the
  `emptyDir` (`api.sourceStorage.persistentVolumeClaim.enabled: false`).
- This is an **interim**: it keeps the API at one replica (ADR 0002 "one API replica"). The Blob
  adapter (M5, analysis-pipeline lead) replaces the share and lifts that limit; the Blob
  container, roles and `storageBlobEndpoint` already exist.

### 5. Images, workflows, tests

- `_build-push.yml` builds service `sandbox` (context `workers`, `workers/sandbox/Dockerfile`,
  `linux/amd64`, no mocked variant) in its default list, so every `main` push pushes
  `bbm/sandbox:sha-<7>` next to the other four. The chart passes
  `SANDBOX_IMAGE=<registry>/<analysis.sandbox.image.repository>:<tag>` (default `bbm/sandbox`,
  the tag defaulting to `global.image.tag`).
- `deploy.yml` checks `bbm/analysis:<tag>` and `bbm/sandbox:<tag>` exist in ACR explicitly (the
  sandbox image is an env value, not a pod image, so the rendered-manifest grep cannot see it).
- **CI runs** (`run-<id>-<attempt>`, `integration-azure.yml`) deploy analysis + sandbox with
  `values-test.yaml` and run the T18 tier `tests/integration/pipeline.test.ts`
  (`BBM_PIPELINE=1`): upload `Vault.sol` → a Flagged `reentrancy-eth` finding (≤ 5 min) →
  claim → `PoC_pass.t.sol` → `Verified` (≤ 12 min, covers the node scale-up) → `PoC_fail.t.sol`
  → `Rejected`, through the API only, in no-chain mode. **PR previews** (`pr-<n>`) deploy
  neither analysis nor the sandbox (`_ephemeral-env.yml` sets `analysis.enabled=false`,
  `sandbox.enabled=false` and no sources claim for `kind=preview`): previews build only
  `bbm-preview/{api,web}`, show the mocked UI and run the smoke suite.
- `infra-janitor.yml` (`janitor.sh`) deletes `<ns>-sandbox` together with an expired `<ns>`, and
  any orphaned `<ns>-sandbox` whose `<ns>` is gone; its ACR purge covers `bbm/sandbox` and
  `bbm-preview/sandbox` through the existing repository regexes and delete-locks the deployed
  `bbm/sandbox:<tag>` like the other images.

### 6. Spike before trusting the pool

`infra/terraform/scripts/kata-spike.sh <env> [<tag>]` runs the sandbox image as a Pod with the
Job's RuntimeClass, nodeSelector, toleration and security context, waits for the pool to scale up,
and exits 0 only if the pod completed **and** the guest kernel (`uname -r`) differs from the
node's. If the RuntimeClass is missing it first reconciles the cluster (`az aks update --yes`, see
Consequences) and checks again. It is run after the first `tf.sh compute test apply` (rollout
step 2) and before staging and prod are applied. A runc result is a failure, never a silent
downgrade.

## Alternatives considered

- **Azure Container Instances (ACI) per PoC**, called from the worker with the Azure SDK
  (hypervisor-isolated by design, billed per second, no node pool). Rejected for now: every run
  pays 20–60 s of container-group provisioning plus an image pull from ACR, the worker would need
  an Azure role to create container groups (a cloud-API surface instead of a namespaced Role), and
  network isolation would be VNet/NSG work instead of a NetworkPolicy. It stays the documented
  **fallback** if Kata does not work on `Standard_D2as_v7`: the backend seam (`run_poc`) is the
  same, and ADR 0001's identity `id-bbm-<env>-sandbox` could carry the role.
- **Azure Container Apps Jobs.** Same isolation story as ACI, with its own environment, scaling and
  billing, and a second platform to operate next to AKS for one workload. Rejected.
- **runc with gVisor (`runsc`).** Not an AKS-supported RuntimeClass; it would mean a self-managed
  node image or a DaemonSet installing the runtime, which AKS node auto-upgrades would undo.
  Rejected for the managed Kata runtime.
- **The Docker socket on AKS** (`/var/run/docker.sock` or Docker-in-Docker). What Compose does; on
  a cluster it is root on the node for the worker and shares the kernel with the PoC. Rejected: it
  is exactly the separation the M3 review asked for.
- **Plain runc Jobs on the system pool** (PSA restricted, no network). Cheapest and simplest, but
  the PoC still shares the node kernel with api, web and the Gateway's Envoy pods. Rejected; the
  Job spec, namespace and RBAC of this ADR would be the same if it ever had to be used.
- **A `bbm-sandbox` namespace per cluster** (ADR 0001 §8) instead of one per release. The test
  cluster hosts several releases at once (CI runs, previews); a shared namespace would need the
  Role to be bound for every release and would mix their Jobs. One namespace per release keeps the
  Role bound to one ServiceAccount and dies with the release. Rejected.
- **Keep sources on the API's emptyDir and copy them into the worker.** No shared volume, but the
  worker would need an HTTP path on the API to fetch sources, or the API would need to push them
  into the job row. The RWX share is less code for an interim, and the Blob adapter removes both.

## Consequences

- **Cost:** a `Standard_D2as_v7` node bills only while a PoC is running or the node has not yet
  scaled down (about $0.09/h plus the OS disk; `docs/devops/cost.md`), and the Azure Files share
  pennies per month. Nothing is billed while the pool is at 0 nodes.
- **Latency:** the first PoC after an idle period waits for a node (3–5 min). The worker's
  deadline and lease cover it; the T18 budget is 12 minutes per verdict.
- **Quota:** +2 Dasv7 vCPUs per env (`docs/devops/azure-bootstrap.md` §4). `up.sh` warns when a
  region lacks them.
- **Test cluster:** every CI-run namespace also creates `<ns>-sandbox` and an Azure Files share;
  both go with the namespace (teardown, janitor). Previews create neither.
- **Analysis on AKS** needs `llm-api-key` and `database-url` in the env Key Vault (staging/prod)
  and the ACR mirror images; test namespaces use the in-cluster Postgres.
- **Rollout** (design §6): PR → `main`; `tf.sh compute test apply`; `az aks update --yes -g
rg-bbm-test-compute-<abbr> -n aks-bbm-test-<abbr>` to reconcile the cluster so the RuntimeClass
  `kata-vm-isolation` appears (a KataVmIsolation pool added to an existing cluster does not
  install it until then; `kata-spike.sh` runs the same update when the RuntimeClass is missing);
  `kata-spike.sh test`; re-run `integration-azure.yml`; `tf.sh compute staging apply` and
  `tf.sh compute prod apply`, each followed by the same `az aks update`; CD deploys the next green
  `main` to staging and, after approval, prod.
- Removing `id-bbm-<env>-sandbox`, its federated credential and `azure.sandboxClientId`, and
  replacing the Azure Files share with the Blob adapter, are follow-up changes.

## Pinned interfaces

### Worker environment (`workers/analysis/src/analysis/config.py`)

| Variable                  | Default                     | Meaning                                                   |
| ------------------------- | --------------------------- | --------------------------------------------------------- |
| `SANDBOX_ENABLED`         | unset (false)               | Claim `sandbox` jobs (either backend).                    |
| `SANDBOX_BACKEND`         | `docker`                    | `docker` (socket, Compose) or `kubernetes` (Jobs, AKS).   |
| `SANDBOX_IMAGE`           | `bbm-sandbox:latest`        | Image of the PoC container / Job pod.                     |
| `SANDBOX_TIMEOUT_SECONDS` | `120`                       | In-container `timeout -s KILL`, both backends.            |
| `SANDBOX_NAMESPACE`       | unset                       | kubernetes: namespace of the Jobs and Secrets (required). |
| `SANDBOX_JOB_TEMPLATE`    | `/etc/bbm/sandbox/job.yaml` | kubernetes: path of the Job template (mounted ConfigMap). |
| `SOURCE_STORAGE_DIR`      | unset                       | Where uploads are read from (the shared claim on AKS).    |
| `JOB_LEASE_SECONDS`       | `600`                       | Helm sets 900 on AKS.                                     |

### Job template contract (ConfigMap `bbm-sandbox-job-template`, key `job.yaml`)

The worker fills in exactly `metadata.name` (`poc-<sanitised id>`, `[a-z0-9-]`, ≤ 63 chars;
`generateName` removed), `metadata.namespace`, `containers[0].image`, `containers[0].command`
(`["sh", "-c", <script>]`) and the `project` volume's `secret.secretName`. Everything else
(runtime class, scheduling, security context, resources, deadlines, the `tmp` and `project`
volumes) is owned by Helm.

### Helm values

`analysis.enabled`, `analysis.sandbox.{backend,timeoutSeconds,image.repository,image.tag}`,
`analysis.jobLeaseSeconds`, `sandbox.enabled`, `sandbox.namespace` (`""` =
`<release namespace>-sandbox`), `sandbox.jobTemplate`, `sandbox.quota`,
`api.sourceStorage.{path,sizeLimit,persistentVolumeClaim.{enabled,existingClaim,storageClassName,accessModes,size}}`.
Staging, prod and `values-test.yaml` turn analysis, the sandbox and the claim on; `values-ci.yaml`
and Compose do not.

### Terraform

`sandbox_pool_enabled`, `sandbox_vm_size` (`Standard_D2as_v7`), `sandbox_max_count` (1) in
`envs/<env>/compute.tfvars`; the pool's label `bbm.io/pool=sandbox`, taint
`bbm.io/sandbox=true:NoSchedule` and RuntimeClass `kata-vm-isolation` (ADR 0001 "What the Helm
chart needs from data and compute") are unchanged.

### Names

| What                   | Name                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------- |
| node pool              | `sandbox` (`aks-bbm-<env>-<abbr>`)                                                     |
| sandbox namespace      | `<release namespace>-sandbox`                                                          |
| Job / Secret           | `poc-<id>`                                                                             |
| job template ConfigMap | `bbm-sandbox-job-template` (release namespace)                                         |
| sources claim          | `bbm-sources` (`<fullname>-sources` when chart-rendered)                               |
| image                  | `<acr>.azurecr.io/bbm/sandbox:sha-<7>` (`bbm-preview/sandbox` is built for no preview) |
| spike                  | `infra/terraform/scripts/kata-spike.sh`, namespace `kata-spike`                        |
