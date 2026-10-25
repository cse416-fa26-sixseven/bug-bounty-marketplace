# ADR 0002: AKS for every environment, Azure DNS and one-command bring-up

- **Status:** Accepted
- **Date:** 2026-10-25
- **Supersedes:** parts of [ADR 0001](0001-azure-environment-topology.md): §1 (ephemeral envs on
  ACA), §6 ingress host and AKS tier, the `aca-ephemeral` stack and the ACA rows of the pinned
  interfaces. Everything else in 0001 still holds.

## Context

- The infra will move to another Azure account (and possibly another domain) later, so bring-up and
  teardown must be scripted end to end, and nothing may hardcode a domain or subscription.
- We want every environment on the same platform (AKS), so the deploy path tested in CI is the one
  prod runs. ACA-based test and preview envs are dropped.
- Prod needs the AKS uptime SLA; test and staging don't.
- We want real hostnames with HTTPS, including per-PR previews, instead of
  `bbm-<env>.eastus2.cloudapp.azure.com`.

## Decision

### 1. Three AKS environments

| Env       | Cluster                  | AKS tier     | Hosts                                       | Database                    |
| --------- | ------------------------ | ------------ | ------------------------------------------- | --------------------------- |
| `test`    | `aks-bbm-test-eus2`      | Free         | CI runs and PR previews, a namespace each   | in-cluster Postgres per ns  |
| `staging` | `aks-bbm-staging-eus2`   | Free         | one release in namespace `bbm`              | PG Flexible Server          |
| `prod`    | `aks-bbm-prod-eus2`      | **Standard** | one release in namespace `bbm`              | PG Flexible Server          |

- `test` is a normal `data` + `compute` env (short code `tst`, VNet `10.10.0.0/16`) with
  `postgres_enabled = false`. It can be paused like the others, and is part of the nightly auto-pause.
- **Ephemeral namespaces** on the test cluster replace ACA:
  - CI run: namespace `run-<run_id>-<attempt>`, host `run-<run_id>-<attempt>.test.<zone>`, TTL 6 h.
  - PR preview: namespace `pr-<n>`, host `pr-<n>.preview.<zone>`, TTL 168 h.
  - Labels `bbm.io/ephemeral=true`, `bbm.io/kind=test|preview`; annotation
    `bbm.io/expires-on=<RFC3339>`. `infra-janitor.yml` deletes expired namespaces.
  - The app chart is installed as release `bbm` in that namespace with `values-test.yaml`, in-cluster
    Postgres (`postgres.inCluster.enabled=true`, image `<acr>/mirror/postgres:16-alpine`, `emptyDir`)
    and `secrets.provider=plain` with a per-namespace random DB password.
- **Auto-resume:** before deploying, the ephemeral workflows check the test data RG's `power-state`
  tag. `paused` → `env-power.sh test resume` (as `gh-bbm-ephemeral`), `running` → continue,
  `down` → fail with "run env-power test up".
- AKS tier is a `compute` input `aks_sku_tier` (`Free` | `Standard`, default `Free`); only
  `envs/prod/compute.tfvars` sets `Standard`.

### 2. DNS

One input, **`dns_zone_name`** (full zone, e.g. `bug-bounty.example.com`), lives in
`envs/global/bootstrap.tfvars`. `up.sh` prompts for it when empty and writes it there. Nothing else in
the repo names a domain.

`stacks/bootstrap` creates the zones (it already owns every resource group, and it runs locally as an
Owner, so no CI identity needs rights outside its own resource groups):

| Zone                 | Resource group           | Purpose                                  |
| -------------------- | ------------------------ | ---------------------------------------- |
| `<zone>`             | `rg-bbm-shared-eus2`     | parent; delegated from the domain's DNS  |
| `prod.<zone>`        | `rg-bbm-prod-data-eus2`  | prod hosts                               |
| `staging.<zone>`     | `rg-bbm-staging-data-eus2` | staging hosts                          |
| `test.<zone>`        | `rg-bbm-test-data-eus2`  | CI run hosts                             |
| `preview.<zone>`     | `rg-bbm-test-data-eus2`  | PR preview hosts                         |

Bootstrap also writes the NS delegation records for the four child zones into the parent zone.

- **Delegation from the parent domain** is out of Terraform. `up.sh` prints the parent zone's four
  name servers. If `CLOUDFLARE_API_TOKEN` is set (scope: Zone → DNS → Edit on the parent domain),
  `up.sh` creates or updates the NS records in Cloudflare through its API; for any other DNS host the
  user adds them by hand. Either way `up.sh` polls until the delegation resolves. The token is only
  an environment variable on the operator's machine; it never enters state or GitHub.
- **Records** (`stacks/data`, which has Contributor on its own data RG): in each env zone, an alias
  `A` record at the apex and a wildcard `*` alias `A` record, both targeting the env's static ingress
  PIP (`target_resource_id`, so they follow the IP). The cloudapp DNS label stays as a fallback.
- **Internal names** (`stacks/data`): a private DNS zone `<env>.internal.<zone>` in the env data RG,
  linked to the env VNet, with `postgres` CNAME → the PG server FQDN (when PG is enabled). In-cluster
  service discovery still uses Kubernetes DNS.
- The parent zone apex is not served yet (follow-up: redirect `<zone>` → `prod.<zone>`).

Hosts:

| Env         | App (web, `/api`, `/health` on one host) | Other hosts                       |
| ----------- | ---------------------------------------- | --------------------------------- |
| prod        | `prod.<zone>`                            | `<name>.prod.<zone>` (wildcard)   |
| staging     | `staging.<zone>`                         | `<name>.staging.<zone>`           |
| CI run      | `run-<id>-<attempt>.test.<zone>`         |                                   |
| PR preview  | `pr-<n>.preview.<zone>`                  |                                   |

### 3. TLS: cert-manager, Let's Encrypt DNS-01, one wildcard per env

- New per-cluster **platform** layer, installed once per cluster by `deploy/platform/install.sh <env>`
  (called by `env-power up`, `deploy.yml`, the ephemeral workflows when the platform is missing, and
  `up.sh`). It is idempotent:
  1. `cert-manager` (jetstack chart, pinned version, namespace `cert-manager`, CRDs enabled, workload
     identity labels on the controller SA/pod).
  2. `deploy/helm/bbm-platform`, release `bbm-platform`, namespace `bbm-platform`:
     - ClusterIssuers `letsencrypt-staging` and `letsencrypt-prod` (ACME DNS-01, `azureDNS` solver
       with workload identity, one solver per env zone, selected by `dnsZones`).
     - Certificate `bbm-wildcard` → Secret `bbm-wildcard-tls` in `bbm-platform`, with DNS names
       `<z>` and `*.<z>` for each env zone (test: both `test.<zone>` and `preview.<zone>`).
     - The app-routing `NginxIngressController` `bbm` (moved here from the app chart), bound to the
       static PIP, with `defaultSSLCertificate` = `bbm-platform/bbm-wildcard-tls`.
- The app chart's ingress gets `tls.mode: defaultCert`: a TLS block listing the host and no
  `secretName`, so NGINX serves the controller's default (wildcard) certificate. No per-namespace or
  per-PR certificates, so no Let's Encrypt rate-limit risk. `tls.mode: certManager` is kept.
- **Identity:** `stacks/data` creates UAMI `id-bbm-<env>-certmgr` and grants it **DNS Zone
  Contributor** on each of the env's public zones (zone scope only). `stacks/compute` adds the
  federated credential `system:serviceaccount:cert-manager:cert-manager`. "DNS Zone Contributor" is
  added to `env_delegable_roles` in `stacks/bootstrap/identities.tf`.

### 4. Identities

- `gh-bbm-ephemeral` (GitHub Environments `test`, `preview`) no longer runs Terraform. On the test
  cluster it gets: **AKS RBAC Cluster Admin** and **Cluster User** on the test compute RG, **Reader**
  on the test data RG, **BBM Power Operator** on the test data and compute RGs, `BBM tfstate reader`
  on `test/` (to read `helm_values`), plus its existing AcrPush. Its ACA-only roles go.
- New `gh-bbm-test` for GitHub Environment **`test-infra`** (`main` only, no reviewer): the same role
  set and state prefix (`test/`) as `gh-bbm-staging`, for `terraform.yml` / `env-power.yml` /
  platform installs on the test env.
- `gh-bbm-plan` keeps read access to `test/` (now the test env's data/compute state; it holds no
  database secrets).

### 5. `helm_values` additions (compute output)

`ingress.host` becomes `<env>.<zone>` (for `test`: `test.<zone>`; ephemeral workflows override it per
namespace). New keys:

```yaml
dns:
  zone: <zone>              # parent zone name
  envZones: [prod.<zone>]   # test: [test.<zone>, preview.<zone>]
  internalZone: prod.internal.<zone>
platform:
  subscriptionId: ...
  dnsResourceGroup: rg-bbm-<env>-data-eus2
  certManagerClientId: ... # id-bbm-<env>-certmgr client id
```

`bbm-platform` consumes `dns.*`, `platform.*` and `ingress.publicIpName` /
`ingress.publicIpResourceGroup`. The app chart ignores keys it does not use.

### 6. One-command bring-up and teardown

- **`infra/up.sh --subscription <id> [--envs test,staging,prod] [--zone <zone>]`**, run locally after
  `az login --use-device-code`. It fills `bootstrap.tfvars` (subscription, admin object id,
  registered providers, zone), applies bootstrap on local state and migrates it to the new state
  account, writes the bootstrap `suffix` into every tfvars that needs it (no hand editing), runs the
  generated `gh-setup.sh`, handles DNS delegation (section 2), applies `global`, mirrors the
  third-party images into ACR, then for each env applies `data`, sets a placeholder `llm-api-key` if
  missing, applies `compute` and installs the platform. It ends by printing the URLs and the
  tfvars files to commit. Every step is idempotent, so a failed run is resumed by running it again.
- **`infra/down.sh --subscription <id> [--envs ...] [--all]`** destroys in reverse (`compute`,
  `data` per env; with `--all` also `global` and `bootstrap`, pulling bootstrap state back to local
  first), purges soft-deleted Key Vaults so names are reusable, removes the Cloudflare NS records if
  the token is set, and with `--all` deletes the GitHub repo variables and environments it created.
  It asks you to type the subscription name to confirm.

## Alternatives considered

- **Keep ACA for test and previews.** Faster to provision and free when idle, but CI would not
  exercise Helm, ingress, cert-manager and network policy, which are what break in prod. Rejected
  per the team's choice.
- **Run CI and previews in namespaces on the staging cluster.** Cheapest, but test load and
  half-broken PR builds would disturb staging, and staging couldn't be paused while PRs are open.
  Rejected.
- **A cluster per CI run.** Fully isolated but adds 5–10 minutes per run and needs quota per
  concurrent run. Rejected.
- **external-dns.** Not needed: every env has one static ingress IP, so an apex and a wildcard alias
  record per env zone cover every host, with no controller holding DNS write access.
- **One flat zone, records written by each env's data stack.** Each env's CI identity would need DNS
  write access to the shared zone, so staging could overwrite prod's records. Per-env child zones
  keep each identity inside its own resource group.
- **HTTP-01 certificates per host.** No new role, but one certificate per PR preview, issuance on
  every preview, and exposure to Let's Encrypt's per-domain weekly limit. Rejected for DNS-01
  wildcards.
- **Bicep / ARM deployment stacks.** Azure-native equivalent of CloudFormation, but the Terraform
  stacks, tests and workflows already exist and Terraform also manages Entra ID and GitHub-facing
  pieces. Kept Terraform.

## Consequences

- **Cost:** five public DNS zones (~$0.50 each per month) plus private zones; prod's Standard tier
  adds about $0.10 per cluster-hour while the cluster runs; the test cluster adds one more paused/LB
  footprint (static PIP and load balancer while paused). Updated in `docs/devops/cost.md`.
- **Quota:** three clusters' system pools (B2als_v2) can run at once; check BASv2 vCPU quota.
- **CI latency:** the first Azure CI run after a nightly pause waits for the test cluster to start
  (~5–10 min).
- **Account or domain switch:** `down.sh --all` on the old subscription, `up.sh` on the new one,
  then update the four NS records (automatic with a Cloudflare token). Commit the tfvars `up.sh`
  rewrote.
- New delegable role (DNS Zone Contributor) and the test-cluster roles for `gh-bbm-ephemeral` are
  applied by bootstrap, locally, by an Owner.
