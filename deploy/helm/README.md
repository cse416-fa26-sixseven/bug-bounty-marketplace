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
- Off by default: the `analysis` worker (with KEDA), the `sandbox`
  namespace stub and a throwaway in-cluster Postgres (`postgres.inCluster`,
  test namespaces only).

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
| `values.yaml` | everything | plain Secret, no WI/ingress/netpol/HPA, 1 replica, migrations on api boot |
| `values-staging.yaml` | `deploy.yml` (staging) | csi + WI, HTTPRoute on the platform Gateway, netpol + egress lockdown, migrations hook, web HPA 1–3, api pinned to 1 |
| `values-prod.yaml` | `deploy.yml` (prod) | as staging + `bbm.io/pool=apps` nodeSelector, web HPA 2–5 + PDB, api pinned to 1 |
| `values-test.yaml` | CI run / PR preview namespaces on the test cluster | plain secrets, in-cluster Postgres, migrations on api boot, 1 replica each, no HPA/PDB, HTTPRoute on the platform Gateway, netpol + egress lockdown |
| `values-ci.yaml` | `ct install`, kind smoke tests | plain Secret with dummy `DATABASE_URL`, everything optional off |

> **API replicas.** Uploaded sources are stored on a per-pod `emptyDir`
> (`SOURCE_STORAGE_DIR=/data/sources`). Because of that, the api must stay at
> exactly one replica in every environment until a Blob storage adapter
> lands. Both env files pin the api HPA to `min 1 / max 1`. While at most one
> replica can run, the Deployment uses `RollingUpdate` with `maxSurge 0` /
> `maxUnavailable 1` (replace in place, brief downtime on rollout).
> `api.strategy` overrides it.

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

(`pr-<n>.preview.<zone>` for previews; add `--set web.image.tag=<tag>` for
the mocked web image.)

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
  - `system:serviceaccount:bbm-sandbox:bbm-sandbox-runner` on the sandbox identity
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
    the Kata runtime on the sandbox pool.
- **Image user:** the images must run as a non-root numeric `USER` that
  matches `*.runAsUser`:
  - 1000 for web and api
  - 10001 for analysis

  Next.js must be able to write `.next/cache` (an `emptyDir` is mounted at
  `web.nextCacheDir`).
