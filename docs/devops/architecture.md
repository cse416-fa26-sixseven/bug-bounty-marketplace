# DevOps architecture

How the marketplace is packaged, tested, deployed and scaled. The decisions and the pinned
interfaces behind this page are in [ADR 0001](../adr/0001-azure-environment-topology.md) and
[ADR 0002](../adr/0002-aks-everywhere-and-azure-dns.md) (AKS for every env, Azure DNS, TLS). The
runbooks are [Azure bootstrap](azure-bootstrap.md) (bring-up with `infra/up.sh`) and
[Environment lifecycle](env-lifecycle.md) (turning environments on and off). Costs are in
[cost.md](cost.md).

## Overview

The system is a small set of containers built from this monorepo. The same images run in three
places:

1. **Docker Compose**, on a laptop and in the `ci.yml` `containers` job.
2. **AKS**, one cluster per environment:
   - **test** hosts a namespace per pipeline-test run and per open pull request;
   - **staging** and **prod** each run one release.

   All three are long-lived but can be paused or torn down on demand.
3. **Foundry/anvil** for the local chain. The contracts image also deploys to Sepolia through a
   dispatch-only workflow.

All infrastructure is Terraform (`infra/terraform`), driven end to end by `infra/up.sh` and
`infra/down.sh`. The cluster workloads are two Helm charts: `deploy/helm/bbm-platform` (once per
cluster: cert-manager issuers, the wildcard certificate, Gateway `bbm`) and
`deploy/helm/bbm` (the app). GitHub Actions talks to Azure over OIDC only. The required check
`CI OK` never needs cloud credentials.

## Components and containers

| Component        | Source             | Image                | Port | Health       | Notes                                                                                                                                  |
| ---------------- | ------------------ | -------------------- | ---- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| web              | `apps/web`         | `bbm/web`            | 3000 | `/healthz`   | Next.js. Proxies `/api/*` to `API_INTERNAL_URL`. A `-mocked` variant is built with MSW enabled.                                        |
| api              | `apps/api`         | `bbm/api`            | 3001 | `/health`    | Fastify. Postgres via `DATABASE_URL`. Uploads go to `SOURCE_STORAGE_DIR` (local disk for now).                                         |
| analysis         | `workers/analysis` | `bbm/analysis`       | 8000 | `/health`    | Python (FastAPI). `POST /analyze` is a 501 stub. Slither + LLM explanation are planned.                                                |
| anvil            | `contracts`        | `bbm/contracts`      | 8545 | JSON-RPC     | Local chain for compose and CI only.                                                                                                   |
| contracts-deploy | `contracts`        | `bbm/contracts`      | n/a  | n/a          | One-shot `forge script script/Deploy.s.sol`. Writes `deployments/31337.json`.                                                          |
| postgres         | upstream           | `postgres:16-alpine` | 5432 | `pg_isready` | Compose service, in-cluster pod in test-cluster namespaces (`<acr>/mirror/postgres:16-alpine`), or PG Flexible Server on staging/prod. |

- Images are tagged `${BBM_REGISTRY:-bbm}/<svc>:${BBM_TAG:-local}` in compose. In ACR they are
  `acrbbm<sfx>.azurecr.io/bbm/<svc>:sha-<7>` (main), `pr-<n>-sha-<7>` (previews), plus `-mocked`
  for the mocked web build.
- Every image runs as non-root: uid 1000 for web and api, 10001 for analysis. CI checks this.
  The Helm chart adds `runAsNonRoot`, a read-only root filesystem and the `RuntimeDefault` seccomp
  profile.
- Third-party runtime images (Postgres, curl for `helm test`) are mirrored into ACR to avoid
  Docker Hub rate limits.

## Environments

| Environment   | Runtime                                                           | Lifetime                                                      | Data durability                                                            | Who triggers it                                                                      |
| ------------- | ----------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Local compose | Docker Compose (`pnpm stack:up`)                                  | until `pnpm stack:down`                                       | named volumes; `stack:down` removes them                                   | a developer                                                                          |
| CI compose    | Compose on a GitHub-hosted runner (`ci.yml` `containers`)         | one job                                                       | none (`down -v` always)                                                    | every push and PR, path-filtered                                                     |
| CI run        | namespace `run-<id>-<attempt>` on `aks-bbm-test-ncus`             | one `integration-azure.yml` run; TTL 6 h as a fallback        | in-cluster Postgres (`emptyDir`), discarded                                | push to `main`, nightly 07:00 UTC, manual dispatch                                   |
| PR preview    | namespace `pr-<n>` on `aks-bbm-test-ncus`                         | PR opened → PR closed; TTL 168 h, re-stamped on every push    | in-cluster Postgres (`emptyDir`), discarded                                | `preview.yml` on PR events (same-repo, not docs-only)                                |
| AKS test      | `aks-bbm-test-ncus` (Free tier, `northcentralus`) + data stack (no Postgres server) | long-lived, `running` / `paused` / `down`; CI auto-resumes it | none of its own                                                            | `env-power.yml` from `main` (`test-infra`), auto-resume by the ephemeral workflows   |
| AKS staging   | `aks-bbm-staging-frc` (Free tier, `francecentral`) + data stack   | long-lived, `running` / `paused` / `down`                     | PG Flexible Server, Blob, Queue, Key Vault: persistent across power states | `deploy.yml` / `env-power.yml` dispatch from `main`, no reviewer                     |
| AKS prod      | `aks-bbm-prod-cac` (Standard tier, `canadacentral`) + data stack  | long-lived, `running` / `paused` / `down`                     | same as staging                                                            | `deploy.yml` / `env-power.yml` from `main`, 1 required reviewer to turn on or change |

Each AKS environment has its own region and one `Standard_B4as_v2` node (Azure for Students allows
6 vCPUs per region; ADR 0002 §8). The shared resources and tfstate live in the home region
`northcentralus`.

All three AKS environments are paused nightly at 06:00 UTC unless their data resource group is
tagged `auto-pause=false`. See [env-lifecycle.md](env-lifecycle.md) for the state machine.

Public hosts (one Azure DNS zone per env, delegated from the parent zone `dns_zone_name`):

| Env        | Host                             |
| ---------- | -------------------------------- |
| prod       | `prod.<zone>`                    |
| staging    | `staging.<zone>`                 |
| CI run     | `run-<id>-<attempt>.test.<zone>` |
| PR preview | `pr-<n>.preview.<zone>`          |

## Azure layers

Each layer has its own Terraform stack and state key, except the platform layer, which is Helm.
Nothing durable lives in `compute`, the platform or the ephemeral namespaces, so they can be
destroyed without losing data, the ingress IP or the DNS records.

```mermaid
flowchart TB
    subgraph Global["Global, home region: rg-bbm-shared-ncus + rg-bbm-tfstate-ncus (stacks bootstrap, global)"]
        TFS[("tfstate storage<br/>stbbmtfstateSFX, Entra auth only")]
        ACR["ACR acrbbmSFX (Basic)<br/>bbm/web, bbm/api, bbm/analysis, bbm/contracts, mirror/*"]
        LAW["Log Analytics log-bbm-shared-ncus<br/>daily cap 0.25 GB"]
        SKV["Key Vault kv-bbm-shared-SFX<br/>Sepolia RPC, deployer key, Etherscan key"]
        ZONE["Azure DNS parent zone ZONE<br/>NS delegations to the env zones"]
        BUD["Budgets: $50 subscription, $20 per env RG"]
        APPS["Entra app registrations gh-bbm-*<br/>(GitHub OIDC)"]
    end

    subgraph Data["Per env data: rg-bbm-ENV-data-ABBR in the env's region (stack data, persistent)"]
        VNET["VNet vnet-bbm-ENV-ABBR<br/>snet-aks /20, snet-psql /24, snet-pe /24"]
        PG[("PG Flexible psql-bbm-ENV-ABBR<br/>B1ms, v16, private (not test)")]
        KV["Key Vault kv-bbm-tst/stg/prd-SFX<br/>database-url, llm-api-key"]
        ST["Storage stbbm + tst/stg/prd + SFX<br/>blob sources, queue analysis-jobs"]
        PIP["Static PIP pip-bbm-ENV-ingress"]
        EZ["DNS zone ENV.ZONE (test: test.ZONE, preview.ZONE)<br/>apex + wildcard alias A records → PIP"]
        IZ["Private DNS zone ENV.internal.ZONE<br/>postgres CNAME"]
        UAMI["UAMIs id-bbm-ENV-aks, -api, -worker, -sandbox, -certmgr"]
        ELAW["Log Analytics log-bbm-ENV-ABBR"]
        EZ --> PIP
    end

    subgraph Compute["Per env compute: rg-bbm-ENV-compute-ABBR (stack compute, disposable)"]
        AKS["AKS aks-bbm-ENV-ABBR (Free; prod Standard)<br/>CNI Overlay + Cilium, OIDC issuer, workload identity"]
        POOLS["Node pools: system 1 x Standard_B4as_v2; apps, sandbox (Kata) off"]
        ADDONS["Add-ons: app routing Gateway API (approuting-istio), KV Secrets Store CSI,<br/>KEDA (keda_enabled, off while analysis is off), Container Insights (prod only)"]
        FIC["Federated credentials for bbm-api, bbm-analysis,<br/>bbm-migrations, bbm-sandbox-runner, keda-operator, cert-manager"]
        AKS --- POOLS
        AKS --- ADDONS
    end

    subgraph Platform["Per cluster platform: namespaces cert-manager + bbm-platform (Helm, deploy/platform/install.sh)"]
        CM["cert-manager<br/>ClusterIssuers letsencrypt-staging / -prod (DNS-01)"]
        CERT["Certificate bbm-wildcard<br/>ENV.ZONE + *.ENV.ZONE"]
        ING["Gateway bbm (gatewayClass approuting-istio)<br/>Envoy bound to the static PIP, serves the wildcard"]
        CM --> CERT --> ING
    end

    subgraph Ephemeral["Ephemeral namespaces on the test cluster (not Terraform)"]
        NSRUN["run-ID-ATTEMPT (TTL 6 h)"]
        NSPR["pr-N (TTL 168 h)"]
    end

    ZONE -- NS --> EZ
    Compute -- remote state --> Data
    Data -- remote state --> Global
    Compute -- remote state --> Global
    AKS -- "kubelet: Repository Reader" --> ACR
    AKS -- binds --> PIP
    AKS -- nodes in --> VNET
    Platform -. runs on .-> AKS
    Ephemeral -. runs on test .-> AKS
    CM -- "TXT records (DNS Zone Contributor)" --> EZ
```

## Request path

On AKS the app chart's HTTPRoute routes `/api` and `/health` straight to the API service and
everything else to web, on one host per env (or per namespace on the test cluster). TLS terminates
at Gateway `bbm` (gatewayClass `approuting-istio`, namespace `bbm-platform`) with the env's wildcard
certificate. The Gateway only admits routes from namespaces labelled `bbm.io/gateway-access=true`
(`deploy.yml` and the ephemeral workflows set it; add it yourself for a manual
`helm install`: `kubectl label namespace <ns> bbm.io/gateway-access=true`). Web also proxies `/api/*` server-side to
`API_INTERNAL_URL`, which is how the browser reaches the API in compose.

```mermaid
flowchart LR
    U(["User browser"]) --> DNS["ENV.ZONE<br/>(alias A record in the env zone)"]
    DNS --> PIP["Static public IP<br/>(data RG)"]
    PIP --> LB["Azure Standard LB"]
    LB --> NGX["Gateway bbm, Envoy pods (bbm-platform)<br/>gatewayClass approuting-istio<br/>HTTPS, wildcard certificate"]
    NGX -- "/" --> WEB["web pods :3000<br/>HPA"]
    NGX -- "/api, /health" --> API["api pod :3001"]
    WEB -- "/api/* proxy<br/>API_INTERNAL_URL" --> API
    API -- "private VNet, PG_POOL_MAX" --> PG[("PG Flexible Server<br/>snet-psql")]
    API -. "planned: Blob adapter" .-> BLOB[("Blob container sources")]
    API -. "planned: enqueue" .-> Q[["Queue analysis-jobs"]]
    Q -. "KEDA azure-queue scaler" .-> AN["analysis pods :8000<br/>0-3 replicas"]
    AN -. "planned: read source" .-> BLOB
    AN -. "planned: PoC Job" .-> SBX["bbm-sandbox namespace<br/>Kata pods, deny-all egress"]
```

Dashed edges are designed and provisioned (identities, roles, queue, container, ScaledObject
template) but not yet wired in application code. `analysis.enabled` and `sandbox.enabled` are
`false` in the staging and prod values files. In test-cluster namespaces the api talks to the
in-cluster Postgres pod instead of PG Flexible Server.

## Identity

There are no client secrets in GitHub or in the cluster.

```mermaid
flowchart LR
    subgraph GH["GitHub Actions"]
        JOB["job with environment: test, preview, test-infra,<br/>staging, prod, prod-power, infra-global,<br/>contracts-sepolia"]
        PR["PR / main plan jobs"]
    end
    JOB -- "OIDC token<br/>sub=repo:...:environment:ENV" --> ENTRA["Entra ID"]
    PR -- "sub=pull_request or ref:refs/heads/main" --> ENTRA
    ENTRA --> EPH["gh-bbm-ephemeral (test, main only)<br/>AKS Cluster Admin + User on the test cluster,<br/>Power Operator on test RGs, ACR Repository Writer"]
    ENTRA --> PRV["gh-bbm-preview (preview, PR branches)<br/>same test-cluster roles,<br/>ACR Repository Writer on bbm-preview/* only (ABAC)"]
    ENTRA --> STG["gh-bbm-test / gh-bbm-staging / gh-bbm-prod<br/>Contributor on own data+compute RGs,<br/>AKS RBAC Cluster Admin, constrained RBAC admin"]
    ENTRA --> PWR["gh-bbm-prod-power<br/>BBM Power Operator only"]
    ENTRA --> GLB["gh-bbm-global<br/>Contributor on shared RG, budgets,<br/>KV Secrets Officer (shared vault)"]
    ENTRA --> PLAN["gh-bbm-plan<br/>Reader + BBM tfstate reader"]
    STG & GLB -- "BBM tfstate writer,<br/>ABAC per state prefix" --> TFS[("tfstate")]
    EPH & PRV & PLAN -- "BBM tfstate reader<br/>(ephemeral/preview: global + test/)" --> TFS

    subgraph K8s["AKS cluster"]
        SA["Pod with ServiceAccount<br/>bbm-api, bbm-analysis, bbm-migrations"]
        CMSA["cert-manager ServiceAccount"]
    end
    SA -- "projected SA token" --> ISS["AKS OIDC issuer"]
    CMSA -- "projected SA token" --> ISS
    ISS -- "federated credential" --> UCM["UAMI id-bbm-ENV-certmgr"]
    UCM --> DZ["Env DNS zones: DNS Zone Contributor"]
    ISS -- "federated credential" --> UAPI["UAMI id-bbm-ENV-api"]
    ISS -- "federated credential" --> UWRK["UAMI id-bbm-ENV-worker"]
    UAPI --> KV["Key Vault: Secrets User"]
    UAPI --> BLOB["Blob sources: Data Contributor"]
    UAPI --> QS["Queue: Message Sender"]
    UWRK --> KV
    UWRK --> QP["Queue: Message Processor + Reader (KEDA)"]
    UWRK --> BLOBR["Blob sources: Data Reader"]
```

- The constrained RBAC Administrator conditions let CI identities assign only an allow-listed set
  of roles, and only to service principals, so a CI token can never grant a human access.
- `id-bbm-<env>-sandbox` deliberately has no role assignments, because it runs untrusted code.
- Key Vault secrets reach pods through the Secrets Store CSI driver: SecretProviderClass `bbm-kv`
  syncs them into the Kubernetes Secret `bbm-secrets`.
- cert-manager answers Let's Encrypt DNS-01 challenges as `id-bbm-<env>-certmgr`, which has DNS
  Zone Contributor on the env's public zones only.
- In CI-run and preview namespaces, `secrets.provider=plain` is used: the in-cluster Postgres
  password is random per namespace and passed to Helm in a file.
- `gh-bbm-ephemeral` (CI runs, main only) and `gh-bbm-preview` (PR previews) don't run Terraform.
  They read `helm_values` from `test/` state, deploy into namespaces on the test cluster and can
  resume it. Only `gh-bbm-ephemeral` pushes `bbm/*` and installs the test cluster's platform;
  `gh-bbm-preview` can push only `bbm-preview/*`.
- The ACR runs in ABAC repository-permissions mode: image access comes only from the Container
  Registry Repository Reader/Writer/Contributor roles (AcrPull/AcrPush are not honored), which
  lets the preview identity's Writer role carry a repository-name condition.

## CI/CD pipeline

```mermaid
flowchart TB
    PR(["Pull request"]) --> CI
    MAIN(["Push to main"]) --> CI
    subgraph CI["ci.yml (no Azure credentials)"]
        CH["changes (paths-filter)"]
        CH --> J1["web / shared / api / analysis<br/>lint, typecheck, test, build"]
        CH --> J2["contracts<br/>forge build/test, gas snapshot, Slither"]
        CH --> J3["containers<br/>hadolint, bake images, non-root check,<br/>compose up, smoke, integration,<br/>regression, e2e"]
        CH --> J4["terraform-static<br/>fmt, validate, tflint, terraform test"]
        CH --> J5["helm<br/>lint, kubeconform, ct lint"]
        CH --> J6["workflows<br/>actionlint"]
        J1 & J2 & J3 & J4 & J5 & J6 --> OK{{"CI OK<br/>required check"}}
    end

    PR --> PV["preview.yml<br/>build pr-N-sha images, deploy namespace pr-N<br/>on the test cluster, smoke, sticky comment"]
    PR -- "PR closed" --> PVD["preview.yml teardown<br/>delete namespace pr-N"]
    PR -- "infra/terraform changes" --> TFP["terraform.yml plan-pr<br/>global + test/staging stacks, sticky comment"]

    MAIN --> IA
    subgraph IA["integration-azure.yml (also nightly, dispatch)"]
        B["build: push sha-7 images to ACR"] --> P["deploy: namespace run-ID-ATTEMPT<br/>(auto-resume the test cluster)"]
        P --> T["test: smoke, integration, e2e,<br/>k6 on schedule or load=true"]
        T --> D["teardown: delete namespace (always)"]
    end
    MAIN -- "infra/terraform changes" --> TFA["terraform.yml apply-global<br/>(infra-global reviewer)"]

    IA -. "planned: auto-deploy if staging running" .-> DS
    DS["deploy.yml staging<br/>power gate, image check, helm upgrade --atomic, smoke"]
    MAN(["Manual dispatch from main"]) --> DS
    MAN --> DP["deploy.yml prod<br/>1 required reviewer"]
    MAN --> EP["env-power.yml<br/>status, pause, resume, down, up"]
    MAN --> TFD["terraform.yml dispatch<br/>plan/apply one stack"]
    MAN --> CD["contracts-deploy.yml<br/>Sepolia, dry run by default"]

    CRON(["Schedules"]) --> EPS["env-power: pause 06:00, PG re-pause 06:30 UTC"]
    CRON --> JAN["infra-janitor.yml every 6 h<br/>expired namespaces, weekly ACR purge"]
```

- Every Azure workflow starts with a `gate` job that skips green until bootstrap has set the repo
  variables, and never runs Azure steps for fork PRs.
- Today staging is deployed by dispatching `deploy.yml` (or by `env-power.yml up`, which redeploys
  the last tag). An automatic staging deploy after a green `integration-azure.yml` run is not wired
  yet.
- `deploy.yml` and every manual mutating `env-power.yml` job share the concurrency group
  `env-<env>`, so a deploy never races a manual pause or resume. The scheduled auto-pause and PG
  re-pause use `env-power-scheduled-<env>` instead, so a parked prod approval can't block the nightly
  pause; `env-power.sh` only refuses to stop a cluster whose provisioningState isn't `Succeeded`, so a
  deploy running at 06:00 UTC could still be interrupted. `deploy.yml` skips cleanly when the cluster is not running.
- Ephemeral workflows never cancel mid-deploy or mid-teardown, because a cancelled `helm upgrade`
  leaves a pending release and a cancelled teardown leaks the namespace.

### Fast iteration

- `pnpm stack:up` runs the whole stack locally from the same Dockerfiles CI uses.
  `NEXT_PUBLIC_API_MOCKING=enabled pnpm dev` runs the web app with no backend at all.
- `ci.yml` is path-filtered per package, so a docs or single-package change runs only the jobs it
  affects. Docker layers are cached in the GitHub Actions cache per image.
- `infra/terraform/scripts/ci-static.sh` and the `helm lint` / `kubeconform` commands in
  [deploy/helm/README.md](../../deploy/helm/README.md) run the same checks locally as CI.
- Every PR gets a live preview URL (`https://pr-<n>.preview.<zone>`) in a sticky comment, in a
  namespace on the shared test cluster. The first run after a nightly pause waits ~5–10 minutes for
  the cluster to resume.
- Test tiers (unit, DB integration, system integration, regression goldens, smoke, e2e, load) use
  the same suites in compose and on Azure, switched by `BBM_*` URLs. See
  [tests/README.md](../../tests/README.md).

## Horizontal scalability and stability under load

**What scales today**

- **Stateless web.** Web holds no state and scales on CPU with an HPA: staging 1–3 replicas, prod
  2–5 with a PodDisruptionBudget (`minAvailable: 1`).
- **Nodes.** The cluster autoscaler is on for every pool. `system` is 1–2 nodes in staging and
  prod, 1–3 on test (for concurrent CI and preview namespaces). Prod adds an `apps` pool (1–3
  nodes, label `bbm.io/pool=apps`) and keeps system nodes for critical add-ons only. Test and
  staging run everything on the system pool to save cost.
- **Ingress.** The Envoy pods of Gateway `bbm` in `bbm-platform` scale 2–3 replicas on test and
  staging and 2–5 in prod (HPA; 2 is the add-on's floor).
- **Spreading.** Pods have topology spread constraints on `kubernetes.io/hostname`
  (`ScheduleAnyway`), so replicas land on different nodes when there are several. Spreading across
  availability zones is not configured yet.
- **Disruption.** PDBs are rendered only when the minimum replica count is above 1, so a
  single-replica environment can still drain nodes during upgrades.
- **Queue-driven workers.** The analysis worker has a KEDA `azure-queue` ScaledObject on
  `analysis-jobs` (0–3 replicas, 5 messages per replica, 300 s cooldown), so it scales to zero when
  idle. It is disabled until the worker does real work.

**Database**

- PG Flexible `B_Standard_B1ms` allows roughly 50 connections. The API's pool defaults to
  `PG_POOL_MAX=5` per pod, which leaves room for the migrations Job, the worker and admin sessions
  as API replicas grow. The chart's `api.pgPoolMax` defaults to the same 5.
- Migrations run once per release as a Helm pre-install/pre-upgrade Job
  (`node dist/migrate-cli.js`, SA `bbm-migrations`) with `MIGRATE_ON_BOOT=false` in the Deployment.
  The migrator also takes a Postgres advisory lock, so even concurrent runners serialise instead of
  racing.
- B1ms is burstable. Under sustained load it runs on CPU credits; once those are gone it drops to
  baseline. Moving to a General Purpose SKU is a tfvars change in `envs/<env>/data.tfvars`.

**Known limit: one API replica**

The API writes uploaded sources to a per-pod `emptyDir` (`SOURCE_STORAGE_DIR`). Two replicas
would split uploads between pods, so `api.hpa.maxReplicas` is 1 in both envs. The rollout strategy
is `maxSurge: 0`, which means a short gap during each API deploy. The Blob `sources` container, the
api identity's Blob Data Contributor role and the `storageBlobEndpoint` value already exist. Once a
Blob storage adapter replaces local disk, the API becomes stateless and its HPA max can be raised.
Uploaded files on the `emptyDir` are also lost when a paused cluster resumes, because nodes are
recreated.

**Load testing**

- `tests/load/api-baseline.js` (k6 `grafana/k6:2.3.0`) ramps to 20 VUs for a minute against
  `GET /health` and `GET /api/contracts/:id`. Thresholds: p95 under 500 ms and errors under 1%. k6
  fails the run if either is breached.
- `SOAK=1` adds a 10-minute constant 10-VU soak scenario for the "sustained load" goal.
- `integration-azure.yml` runs k6 nightly and when dispatched with `load: true`, against the CI-run
  namespace on the test cluster. It never targets prod, because `setup()` writes a row.
- That namespace shares small B-series nodes with other runs and uses in-cluster Postgres on an
  `emptyDir`, so its numbers are a regression baseline, not a capacity figure. Capacity runs belong
  on staging with `auto-pause=false`.

**Isolation for untrusted code**

- Auditor PoCs will run as Jobs in the `bbm-sandbox` namespace on a dedicated `sandbox` pool with
  Kata VM isolation (`runtimeClassName: kata-vm-isolation`), a taint, a deny-all NetworkPolicy, a
  ResourceQuota, a 600 s deadline and an identity with no Azure roles.
- The pool and the Job template are off by default. Kata needs a nested-virtualisation size (Dsv5)
  and quota a new subscription may not have.
- The `bbm` namespace is default-deny for ingress (only the Gateway's Envoy pods, web → api and
  `helm test` are allowed). With `networkPolicy.restrictEgress`, which is on in staging and prod,
  egress is default-deny too: DNS for everyone, web → api only, api and migrations → Postgres on
  `snet-psql`, and api/analysis → HTTPS 443 (Entra, Storage).

## Known gaps and next steps

- **Blob storage adapter** for uploads. This removes the API single-replica limit (see above).
- **Wire the queue.** The API should enqueue analysis jobs and the worker should consume them.
  Then set `keda_enabled = true` in the env's `compute.tfvars` (the add-on is off to save ~0.4 CPU
  on the one node) and enable `analysis` and the KEDA ScaledObject in the env values.
- **Parent zone apex.** `<zone>` itself serves nothing yet; a redirect to `prod.<zone>` is planned.
- **Zone spreading** for prod pods and a zone-redundant node pool layout.
- **Automatic staging deploy** from `main` after `integration-azure.yml` passes.
- **Sandbox pool** once Dsv5 quota is granted.
- **Observability.** Container Insights is on in prod only. There are no alert rules on error
  rate, latency or PG connections yet.
- **Database HA.** PG is a single zonal server without HA or geo-redundant backup (7-day backup
  retention). That's fine for demos, not for real funds.
