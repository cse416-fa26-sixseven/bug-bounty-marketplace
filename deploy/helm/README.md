# bbm Helm chart

`deploy/helm/bbm` deploys the marketplace to the staging and prod AKS clusters
(release `bbm`, namespace `bbm`) and to ephemeral namespaces on the test
cluster (`values-test.yaml`). It contains:

- `web` (Next.js, port 3000, `/healthz`) and `api` (Fastify, port 3001,
  `/health`): Deployments, Services, optional HPA and PDB.
- Migrations as a Helm hook Job (`node dist/migrate-cli.js`).
- ServiceAccounts with workload identity, plus Key Vault secrets through the
  Secrets Store CSI driver.
- An `HTTPRoute` on the platform Gateway `bbm-platform/bbm` and
  NetworkPolicies.
- The `analysis` worker (Slither + LLM, and the PoC runner) with its
  per-release `sandbox` namespace where auditors' PoCs run as Kata-isolated
  Jobs, and shared upload storage for api and analysis: the env Blob
  container (`api.sourceStorage.blob`, staging) or a ReadWriteMany
  `sources` claim (`api.sourceStorage.persistentVolumeClaim`, prod/test).
  Off in `values.yaml`, on in every env file (see "Analysis and the PoC
  sandbox").
- Off by default: KEDA scaling of the worker and a throwaway in-cluster
  Postgres (`postgres.inCluster`, test namespaces only).

The cluster-wide pieces (cert-manager, the Let's Encrypt ClusterIssuers, the
env wildcard certificate and the Gateway API `Gateway` `bbm` that binds the
static IP and terminates TLS) live in the separate
[`bbm-platform`](bbm-platform/README.md) chart, installed once per cluster by
`deploy/platform/install.sh` (ADR 0002 section 3).

The default `values.yaml` is safe for any cluster, including kind. The
Azure-specific behaviour is switched on by the env files.

## Value layering

```
values.yaml                       # safe defaults (kind-friendly, Azure features off)
  -> values-<env>.yaml            # test | staging | prod: feature switches, sizes, replicas
  -> values-infra.yaml            # generated, never committed (terraform compute output)
  -> --set global.image.tag=sha-xxxxxxx
```

`values-infra.yaml` holds everything terraform knows:

- the ACR registry
- the tenant, client IDs, Key Vault and storage
- the ingress host and public IP
- the Postgres subnet CIDR

Generate it with:

```sh
infra/terraform/scripts/tf.sh compute <env> output -raw helm_values > values-infra.yaml
```

Expected keys (see `docs/adr/0001-azure-environment-topology.md`):

```yaml
global:   { image: { registry: <acr>.azurecr.io } }
azure:    { tenantId, keyVaultName, apiClientId, workerClientId, migrationsClientId,
            sandboxClientId, storageAccountName, storageBlobEndpoint, queueName }
ingress:  { host, publicIpName, publicIpResourceGroup, trustedProxyCidr }
networkPolicy: { postgresCidr }
dns:      { zone, envZones, internalZone }                          # ADR 0002, bbm-platform only
platform: { subscriptionId, dnsResourceGroup, certManagerClientId } # ADR 0002, bbm-platform only
```

The app chart accepts but ignores `ingress.publicIpName`,
`ingress.publicIpResourceGroup`, `dns.*` and `platform.*`; they are read by
`bbm-platform`, which gets the same file.

The env files never hardcode these. Set `global.requireInfraValues=true` in
deploys, so a missing key fails rendering instead of producing a broken
SecretProviderClass or HTTPRoute.

| file | used by | highlights |
|---|---|---|
| `values.yaml` | everything | plain Secret, no WI/ingress/netpol/HPA, 1 replica, migrations on api boot, analysis/sandbox/sources claim off (emptyDir uploads) |
| `values-staging.yaml` | `deploy.yml` (staging) | csi + WI, HTTPRoute on the platform Gateway, netpol + egress lockdown, migrations hook, web HPA 1–3, api 1 replica, analysis + sandbox, uploads in the Blob `sources` container |
| `values-prod.yaml` | `deploy.yml` (prod) | as staging + `bbm.io/pool=apps` nodeSelector, web HPA 2–5 + PDB, api pinned to 1, analysis + sandbox + sources claim |
| `values-test.yaml` | CI run / PR preview namespaces on the test cluster | plain secrets, in-cluster Postgres, migrations on api boot, 1 replica each, no HPA/PDB, HTTPRoute on the platform Gateway, netpol + egress lockdown, analysis + sandbox (`<ns>-sandbox`) + sources claim |
| `values-ci.yaml` | `ct install`, kind smoke tests | plain Secret with dummy `DATABASE_URL`, everything optional off |

> **Uploaded sources and API replicas.** With `api.sourceStorage.blob.enabled`
> (staging) uploads are block blobs in the env storage account's container
> (`azure.storageBlobEndpoint` from values-infra + `azure.storageContainerName`,
> default `sources`): the api writes and the analysis worker reads through
> `SOURCE_STORAGE_BLOB_CONTAINER_URL` with their workload identities, no
> volume is mounted, and the api may run several replicas. Otherwise they
> are written to `SOURCE_STORAGE_DIR=/data/sources`: a per-pod `emptyDir` by
> default, or the shared `bbm-sources` claim when
> `api.sourceStorage.persistentVolumeClaim` is enabled (prod, test). The
> claim is an interim way to hand uploads to the analysis worker, not a
> multi-replica design, so there the api stays at exactly one replica
> (`min 1 / max 1`). While at most one replica can run, the Deployment uses
> `RollingUpdate` with `maxSurge 0` / `maxUnavailable 1` (replace in place,
> brief downtime on rollout). `api.strategy` overrides it. Turning Blob on
> for an env that had the claim deletes the claim and its share.

> **Staging node placement.** `values-staging.yaml` leaves
> `global.nodeSelector` empty on purpose. The staging apps pool is disabled
> by default to save vCPU quota, so app pods run on the system pool. Prod
> pins them to `bbm.io/pool=apps`.

## Secrets (`secrets.provider`)

| provider | what happens | use for |
|---|---|---|
| `plain` | the chart renders Secret `bbm-secrets` from `secrets.plain.*` | **dev/CI only**: values are stored in clear text in the Helm release |
| `csi` | SecretProviderClass `bbm-kv` syncs Key Vault `database-url` / `llm-api-key` into `bbm-secrets` | staging/prod |
| `existing` | a pre-created Secret named `secrets.name` is used | anything else |

The CSI driver only creates the synced Kubernetes Secret while a pod mounts
the CSI volume. For that reason, every pod that reads it mounts the volume at
`/mnt/secrets`.

Each SecretProviderClass uses the identity federated with the
ServiceAccount of the pods that mount it:

| SecretProviderClass | identity | synced Secret | mounted by |
|---|---|---|---|
| `bbm-kv` | `apiClientId` | `bbm-secrets` | api |
| `bbm-kv-migrations` (hook) | `migrationsClientId` | `bbm-secrets-migrations` | migrations Job |
| `bbm-kv-analysis` | `workerClientId` | `bbm-secrets-analysis` | analysis (only when enabled) |

## Analysis and the PoC sandbox

`analysis.enabled` deploys the Python worker (`bbm/analysis`, port 8000,
ServiceAccount `bbm-analysis`). It serves `/analyze` and polls the Postgres
`jobs` table the api writes, so it gets `DATABASE_URL` from the same Secret
as the api (with `csi`, `bbm-kv-analysis` syncs `database-url` and
`llm-api-key` into `bbm-secrets-analysis`), `JOB_LEASE_SECONDS`
(`analysis.jobLeaseSeconds`, 900) and the sources: with
`api.sourceStorage.blob` the container URL (`SOURCE_STORAGE_BLOB_CONTAINER_URL`,
read as the worker identity, Storage Blob Data Reader), else, when the
sources claim is enabled, `SOURCE_STORAGE_DIR` with the claim mounted
read-only. Its egress policy allows Postgres and HTTPS (Blob, the LLM
endpoint and the Kubernetes API server).
`LLM_ENDPOINT` / `LLM_MODEL` go in `analysis.extraEnv`; without them the
worker keeps Slither's own explanations.

### Shared sources claim (`api.sourceStorage.persistentVolumeClaim`)

| key | default | meaning |
|---|---|---|
| `enabled` | `false` (`true` in every env file) | mount one ReadWriteMany claim in the api (rw) and analysis (ro) pods at `api.sourceStorage.path` instead of the api's per-pod emptyDir |
| `existingClaim` | `""` | use a pre-created claim; empty renders `PersistentVolumeClaim bbm-sources` |
| `storageClassName` | `azurefile-csi` | Azure Files (SMB), dynamically provisioned: a test namespace gets its own share and loses it with the namespace |
| `accessModes` / `size` | `[ReadWriteMany]` / `5Gi` | |

Azure Files mounts with `0777` modes, so the api (uid 1000) writes and the
worker (uid 10001) reads. With the claim disabled (Compose, kind, CI) the
analysis pod has no sources volume and `SOURCE_STORAGE_DIR` unset, so it
only serves `/analyze`.

### Sandbox (`sandbox.enabled`)

Auditors' PoCs run as Kubernetes **Jobs** that the analysis worker creates
(`SANDBOX_BACKEND=kubernetes`) in a separate namespace on the Kata
(`KataVmIsolation`) node pool: one VM per PoC, no ServiceAccount token, no
network, read-only root filesystem, capabilities dropped, uid 10001,
`activeDeadlineSeconds 600` on the Job plus `timeout -s KILL 120` inside the
container. The design is in
`docs/superpowers/specs/2026-11-05-sandbox-aks-design.md`.

The chart renders:

- **Namespace** `sandbox.namespace`, empty = `<release namespace>-sandbox`
  (`bbm-sandbox` for the `bbm` release, `run-<id>-<attempt>-sandbox` /
  `pr-<n>-sandbox` on the test cluster), labelled
  `pod-security.kubernetes.io/enforce=restricted`. It is owned by the
  release: `helm uninstall` deletes it and every Job in it. Rendering fails
  if it equals the release namespace.
- **Role + RoleBinding** `bbm-analysis` in that namespace for
  `system:serviceaccount:<release namespace>:bbm-analysis`: `jobs`
  create/get/list/watch/delete, `pods` get/list/watch, `pods/log` get,
  `secrets` create/get/patch/delete (patch sets the ownerReference that ties
  the project Secret to its Job). Nothing in the release namespace, nothing
  cluster-wide; the Job pods carry no identity (`azure.sandboxClientId` is
  accepted from values-infra but unused).
- **ResourceQuota** and **LimitRange** (`sandbox.quota`,
  `sandbox.jobTemplate.resources`) and a **NetworkPolicy** denying all
  ingress and egress, DNS included.
- **ConfigMap** `bbm-sandbox-job-template` in the **release** namespace,
  mounted into the analysis pod at `/etc/bbm/sandbox/job.yaml`
  (`SANDBOX_JOB_TEMPLATE`). The worker fills in `metadata.name`
  (`poc-<id>`), `metadata.namespace`, the container `image` and `command`,
  and the `project` volume's `secretName`; the chart owns everything else:
  `runtimeClassName`, nodeSelector/tolerations for the sandbox pool,
  securityContext, resources, `activeDeadlineSeconds`,
  `ttlSecondsAfterFinished`, `backoffLimit 0`, `restartPolicy Never`,
  `automountServiceAccountToken false`, `enableServiceLinks false`, the
  `tmp` emptyDir (`jobTemplate.tmpSizeLimit`, mounted at `/tmp`) and the
  `project` Secret volume (read-only at `/in`).

With `sandbox.enabled` the analysis pod runs with
`automountServiceAccountToken: true` (pod level; the ServiceAccount keeps
`false`) for in-cluster config, and gets `SANDBOX_ENABLED=true`,
`SANDBOX_NAMESPACE`, `SANDBOX_JOB_TEMPLATE`. `SANDBOX_BACKEND`,
`SANDBOX_IMAGE` and `SANDBOX_TIMEOUT_SECONDS` come from `analysis.sandbox.*`
in every case. `SANDBOX_IMAGE` is
`<global.image.registry>/<analysis.sandbox.image.repository>:<tag>` (tag
defaulting to `global.image.tag`); it is an env value, not a pod image, so
PR previews must `--set analysis.sandbox.image.repository=bbm-preview/sandbox`
(and `analysis.image.repository=bbm-preview/analysis`) the way they do for
api/web, and `deploy.yml`'s "image exists in ACR" check has to list it
explicitly. **Lease rule:** `analysis.jobLeaseSeconds` (900) must be greater
than `sandbox.jobTemplate.activeDeadlineSeconds + 120` (600 + 120); the chart
fails to render otherwise. The worker waits `activeDeadlineSeconds + 60 s`
for a Job (including the sandbox pool scaling up from zero) plus up to 60 s
to delete a leftover Job of the same name first, and a lease shorter than
that lets another worker re-claim the job and run the PoC twice.

The sandbox pool (terraform `sandbox_pool_enabled`) carries node label
`bbm.io/pool=sandbox`, taint `bbm.io/sandbox=true:NoSchedule` and
RuntimeClass `kata-vm-isolation`; without it Jobs stay Pending until the
deadline and the worker records a retryable infra error.

## Migrations and hook ordering

When `migrations.enabled` is true:

- The api runs with `MIGRATE_ON_BOOT=false`.
- A `pre-install,pre-upgrade` hook Job runs `node dist/migrate-cli.js` with
  the api image.

Hooks run **before** any regular release resource exists. On first install
that includes the ConfigMap, `bbm-secrets` and `bbm-kv`. So everything the
Job needs is itself a hook:

| weight | resource | delete policy |
|---|---|---|
| -10 | ServiceAccount `bbm-migrations` | `before-hook-creation,hook-succeeded` |
| -10 | Secret `bbm-secrets-migrations` (plain) **or** SecretProviderClass `bbm-kv-migrations` (csi) | same |
| -5 | Job `bbm-migrations` (`backoffLimit 1`, `activeDeadlineSeconds 300`) | same |

Helm applies `hook-succeeded` only once **every** hook of the event has
finished (see `pkg/action/hooks.go`), not right after each one. The weight
-10 resources therefore survive until the -5 Job completes. After that, all
three are deleted, which also removes the plain-text `bbm-secrets-migrations`
copy. With csi, the synced Secret goes away together with the Job pod.

Helm never deletes hook resources on `helm uninstall`, so this policy is
what keeps them from piling up. If a migration **fails**, Helm still
deletes the -10 hooks (they succeeded). The failed Job is kept for
`kubectl logs` and is replaced by the next deploy (`before-hook-creation`).
After an uninstall that followed a failed migration, remove it by hand:

```sh
kubectl -n bbm delete job bbm-migrations --ignore-not-found
```

The hook copies have their own names, and `bbm-migrations` is never rendered
as a regular resource. This prevents a clash between a hook-owned object and
a release-owned object with the same name. With `existing`, the Job reads the
pre-created Secret directly.

A failed migration fails the `helm upgrade`. With `--atomic`, the release is
then rolled back. The failed Job is kept for `kubectl logs` until the next
deploy recreates it.

## Routing and TLS (Gateway API)

- With `ingress.enabled`, the chart renders `HTTPRoute` `bbm` with
  `parentRefs` → Gateway `ingress.gateway.namespace`/`ingress.gateway.name`
  (default `bbm-platform/bbm`, from the `bbm-platform` chart, GatewayClass
  `approuting-istio` of the AKS app routing add-on) and
  `hostnames: [ingress.host]`. Rules:
  - `/api` (PathPrefix) and `/health` (Exact) to `bbm-api:3001`
  - `/` to `bbm-web:3000`
- TLS terminates at the Gateway's HTTPS listeners with the `bbm-platform`
  wildcard `bbm-platform/bbm-wildcard-tls` (`<z>` and `*.<z>` per env zone),
  and its HTTP listener redirects to HTTPS. The chart has no TLS settings and
  issues no per-namespace certificates.
- **Namespace label:** the HTTPS listeners admit routes only from namespaces
  labelled `bbm.io/gateway-access=true`. `deploy.yml` labels `bbm`,
  `_ephemeral-env.yml` labels `run-*` / `pr-*`; for a manual install run
  `kubectl label namespace <ns> --overwrite bbm.io/gateway-access=true`.
  Without it the route reports `Accepted=False` (`NotAllowedByListeners`):
  `kubectl -n <ns> describe httproute bbm`.
- `ingress.host` must sit under one of the env zones (the listener
  hostnames), or the route is not accepted.
- NetworkPolicies admit web/api traffic from the Gateway's Envoy pods:
  namespace `ingress.gateway.namespace`, label
  `gateway.networking.k8s.io/gateway-name=<ingress.gateway.name>`.
- Install the platform before the first app release.

## In-cluster Postgres (`postgres.inCluster`)

For ephemeral test/preview namespaces only (staging and prod use PG Flexible
Server). `postgres.inCluster.enabled=true` renders Secret, Service and
single-replica Deployment `bbm-postgres` (port 5432, `emptyDir` data, uid 70,
`pg_isready` probes), image `<registry>/mirror/postgres:16-alpine`
(`postgres.inCluster.image`). The database and user are `bbm`.

- `postgres.inCluster.password` is required and limited to
  `[A-Za-z0-9._~-]` (it is embedded in `DATABASE_URL` unescaped).
- With `secrets.provider=plain` and an empty `secrets.plain.databaseUrl`
  (the default now), `database-url` becomes
  `postgres://bbm:<password>@bbm-postgres:5432/bbm`. A non-empty
  `secrets.plain.databaseUrl` always wins.
- It cannot be combined with `migrations.enabled` (the pre-install hook would
  run before Postgres exists), so the api migrates on boot.
- NetworkPolicies allow api and migrations pods to reach it on 5432, and
  `networkPolicy.postgresCidr` is not required when it is enabled.
- Mirror the image into ACR once:
  `az acr import --name <acr> --source docker.io/library/postgres:16-alpine --image mirror/postgres:16-alpine`.

Ephemeral namespace install (as the test/preview workflows run it):

```sh
pw=$(kubectl -n "$NS" get secret bbm-postgres -o jsonpath='{.data.password}' 2>/dev/null | base64 -d)
[ -n "$pw" ] || pw=$(openssl rand -hex 24)   # keep the password across upgrades
helm upgrade --install bbm deploy/helm/bbm --namespace "$NS" --create-namespace \
  -f deploy/helm/bbm/values-test.yaml -f values-infra.yaml \
  --set global.image.tag="sha-${GITHUB_SHA::7}" \
  --set ingress.host="$NS.test.<zone>" \
  --set-string postgres.inCluster.password="$pw" \
  --set global.requireInfraValues=true \
  --atomic --wait --timeout 10m
```

(`pr-<n>.preview.<zone>` for previews, with `--set
<component>.image.repository=bbm-preview/<component>` for `api`, `web`,
`analysis` and `analysis.sandbox.image.repository=bbm-preview/sandbox`; add
`--set web.image.tag=<tag>` for the mocked web image.)

## Local validation

```sh
cd deploy/helm

# lint every values layer (global.image.tag is required)
for f in "" values-staging.yaml values-prod.yaml values-ci.yaml; do
  helm lint --strict bbm ${f:+-f bbm/$f} --set global.image.tag=test
done
helm lint --strict bbm -f bbm/values-test.yaml --set global.image.tag=test \
  --set postgres.inCluster.password=test

# with the fake terraform output, required infra keys must resolve
for e in staging prod; do
  helm template bbm bbm -n bbm -f bbm/values-$e.yaml -f bbm/ci/fake-values-infra.yaml \
    --set global.image.tag=test --set global.requireInfraValues=true >/dev/null
done

# platform chart (fixtures in bbm-platform/ci/)
for e in test staging prod; do for fx in test prod; do
  helm lint --strict bbm-platform -f bbm-platform/values-$e.yaml -f bbm-platform/ci/$fx-values.yaml
done; done

# render + schema-validate (CRDs from the datreeio catalog)
for f in values-staging.yaml values-prod.yaml values-ci.yaml; do
  helm template bbm bbm -n bbm -f bbm/$f --set global.image.tag=test \
    --set analysis.enabled=true --set sandbox.enabled=true --set migrations.enabled=true |
  kubeconform -strict -summary -kubernetes-version 1.34.0 \
    -schema-location default \
    -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
done

# (same kubeconform flags for values-test.yaml and for
#  `helm template bbm-platform bbm-platform -n bbm-platform -f bbm-platform/values-<env>.yaml -f bbm-platform/ci/<fx>-values.yaml`)

# rendering without a tag must fail
helm template bbm bbm -n bbm   # Error: ... global.image.tag is required

# chart-testing (from the repo root)
ct lint --config deploy/helm/ct.yaml --charts deploy/helm/bbm
```

Every CRD the charts render (cert-manager, KEDA, Secrets Store CSI, Gateway
API `Gateway` / `HTTPRoute`) is in the datreeio CRD catalog, so nothing is
vendored and kubeconform skips nothing. The CI `helm` job runs the same
checks against a pinned catalog commit (`main` above is fine locally).

`ct` reads `bbm/ci/ci-values.yaml`, which is a symlink to `values-ci.yaml`,
and `bbm-platform/ci/{prod,test}-values.yaml` (fake `values-infra.yaml`
files). `bbm/ci/fake-values-infra.yaml` is deliberately not a
`*-values.yaml` file, so ct skips it. `.helmignore` excludes `ci/` from the
packaged charts. `ct install` needs the
image tag that was loaded into kind:

```sh
ct install --config deploy/helm/ct.yaml --charts deploy/helm/bbm \
  --helm-extra-set-args "--set=global.image.tag=<tag>"
```

## Deploy (as run by `.github/workflows/deploy.yml`)

```sh
infra/terraform/scripts/tf.sh compute "$ENV" output -raw helm_values > values-infra.yaml
source <(infra/terraform/scripts/env-region.sh "$ENV")   # COMPUTE_RG / CLUSTER in the env's region
az aks get-credentials -g "$COMPUTE_RG" -n "$CLUSTER"   # then kubelogin convert-kubeconfig -l azurecli
deploy/platform/install.sh "$ENV" --values values-infra.yaml --wait   # idempotent; cert-manager + bbm-platform
kubectl create namespace bbm --dry-run=client -o yaml | kubectl apply -f -
kubectl label namespace bbm --overwrite bbm.io/gateway-access=true    # HTTPRoute admission
helm upgrade --install bbm deploy/helm/bbm \
  --namespace bbm --create-namespace \
  -f "deploy/helm/bbm/values-$ENV.yaml" \
  -f values-infra.yaml \
  --set global.image.tag="sha-${GITHUB_SHA::7}" \
  --set global.requireInfraValues=true \
  --atomic --wait --timeout 10m
helm test bbm -n bbm --timeout 5m
```

`helm test` runs a curl pod against `bbm-api:3001/health` and
`bbm-web:3000/healthz`. When `global.image.registry` is set (staging/prod),
the pod pulls `<registry>/mirror/curl:8.10.1` (`tests.mirrorImage`) instead
of Docker Hub's `curlimages/curl:8.10.1` (`tests.image`). Mirror it into each
ACR once, and again whenever you bump the tag:

```sh
az acr import --name <acr> \
  --source docker.io/curlimages/curl:8.10.1 --image mirror/curl:8.10.1
```

## Cluster prerequisites (provided by the terraform compute stack)

- **AKS add-ons:**
  - OIDC issuer and workload identity
  - `azure-keyvault-secrets-provider` (with `secretObjects` sync)
  - Managed Gateway API CRDs and the app routing Gateway API
    implementation (GatewayClass `approuting-istio`; `modules/aks`, via
    azapi); the `Gateway` itself comes from `bbm-platform`. No managed NGINX.
  - KEDA, only when `analysis.keda.enabled`
- **Network policy:** Cilium enforces NetworkPolicies (CNI Overlay + Cilium).
- **Federated credentials:**
  - `system:serviceaccount:bbm:bbm-api` on the api identity
  - `system:serviceaccount:bbm:bbm-migrations` on the api identity (same as `migrationsClientId`)
  - `system:serviceaccount:bbm:bbm-analysis` on the worker identity
    (the sandbox identity and its `bbm-sandbox-runner` credential are
    unused: PoC Jobs carry no identity)
  - `system:serviceaccount:cert-manager:cert-manager` on `id-bbm-<env>-certmgr`
    (bbm-platform; DNS Zone Contributor on the env zones)
- **KEDA:** the `azure-workload` TriggerAuthentication makes the **KEDA
  operator** request a token as the worker identity. That identity therefore
  also needs a federated credential for
  `system:serviceaccount:kube-system:keda-operator`, plus
  `Storage Queue Data Reader` on the storage account.
- **Role assignments:**
  - `Key Vault Secrets User` on the env Key Vault for the api identity.
  - The same role for the worker identity when analysis is enabled.
  - `Network Contributor` on the data RG for the AKS cluster identity, so the
    Gateway's LoadBalancer Service can bind the static PIP.
- **Node pools:**
  - Node label `bbm.io/pool=apps` on the apps pool (prod `nodeSelector`).
  - `bbm.io/pool=sandbox` plus taint `bbm.io/sandbox=true:NoSchedule` and
    the Kata runtime (`workload_runtime = "KataVmIsolation"`, RuntimeClass
    `kata-vm-isolation`) on the sandbox pool, 0–1 nodes.
- **Storage class** `azurefile-csi` (AKS built-in) for the sources claim.
- **Image user:** the images must run as a non-root numeric `USER` that
  matches `*.runAsUser`:
  - 1000 for web and api
  - 10001 for analysis

  Next.js must be able to write `.next/cache` (an `emptyDir` is mounted at
  `web.nextCacheDir`).
