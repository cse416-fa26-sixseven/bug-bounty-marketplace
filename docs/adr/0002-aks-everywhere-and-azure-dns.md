# ADR 0002: AKS for every environment, Azure DNS and one-command bring-up

- **Status:** Accepted
- **Date:** 2026-10-25
- **Amended:** 2026-10-25, ingress moved from the app-routing add-on's managed NGINX to its Gateway
  API implementation (section 3), because Azure support for managed NGINX ends in November 2026.
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
- Upstream ingress-nginx was retired (maintenance ended in March 2026), and Azure supports the
  app-routing add-on's managed NGINX (`NginxIngressController`) only with critical security patches
  through **November 2026**. Microsoft's documented successor on AKS is the app routing add-on's
  Kubernetes Gateway API implementation (GatewayClass `approuting-istio`), GA since AKS release
  2026-04-28.

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
  name servers. If `CLOUDFLARE_API_TOKEN` is set (permissions **Zone:Read + DNS:Edit** on the parent
  zone: Zone:Read to look the zone up by name, DNS:Edit to write the records),
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

### 3. Ingress and TLS: AKS app routing Gateway API, cert-manager, one wildcard per env

- **Cluster (`modules/aks`):** the Managed Gateway API CRDs (`ingressProfile.gatewayAPI.installation
  = Standard`: standard channel, bundle version pinned to the Kubernetes minor, v1.3.0 on 1.34) and
  the app routing Gateway API implementation (`ingressProfile.webAppRouting.gatewayAPIImplementations
  .appRoutingIstio.mode = Enabled`), which runs a sidecar-less `istiod` in `aks-istio-system` and
  reconciles Gateways of GatewayClass `approuting-istio`. azurerm has no argument for either, so the
  module sets them with `azapi_update_resource` on `Microsoft.ContainerService/managedClusters@2026-03-01`
  (the Terraform path Microsoft documents; same as `az aks update --enable-gateway-api
  --enable-app-routing-istio`). There is no `web_app_routing` block: no managed NGINX and no add-on
  DNS integration (records are ours, section 2).
- New per-cluster **platform** layer, installed once per cluster by
  `deploy/platform/install.sh <env> --values <values-infra.yaml> [--issuer letsencrypt-prod|letsencrypt-staging] [--wait]`
  (`values-infra.yaml` is the compute stack's `helm_values` output)
  (called by `env-power up`, `deploy.yml`, the ephemeral workflows when the platform is missing, and
  `up.sh`). It is idempotent, waits for the GatewayClass, and with `--wait` waits for the certificate
  to be Ready and the Gateway to be `Programmed`:
  1. `cert-manager` (jetstack chart, pinned version, namespace `cert-manager`, CRDs enabled, workload
     identity labels on the controller SA/pod).
  2. `deploy/helm/bbm-platform`, release `bbm-platform`, namespace `bbm-platform`:
     - ClusterIssuers `letsencrypt-staging` and `letsencrypt-prod` (ACME DNS-01, `azureDNS` solver
       with workload identity, one solver per env zone, selected by `dnsZones`).
     - Certificate `bbm-wildcard` → Secret `bbm-wildcard-tls` in `bbm-platform`, with DNS names
       `<z>` and `*.<z>` for each env zone (test: both `test.<zone>` and `preview.<zone>`).
     - **Gateway `bbm-platform/bbm`** (`gatewayClassName: approuting-istio`). The add-on provisions
       Envoy Deployment, LoadBalancer Service, HPA and PDB `bbm-approuting-istio` in `bbm-platform`.
       `spec.infrastructure.annotations` (`service.beta.kubernetes.io/azure-pip-name`,
       `azure-load-balancer-resource-group`) are copied onto that Service, which binds the static PIP
       `pip-bbm-<env>-ingress` in the data RG (the cluster identity has Network Contributor there).
       A per-Gateway ConfigMap (`infrastructure.parametersRef`) sets the HPA (min 2, the add-on's
       floor). Listeners:
       - `http` (:80): admits only routes from its own namespace (`allowedRoutes.namespaces.from:
         Same`), i.e. HTTPRoute `bbm-https-redirect`, which 301s every host to HTTPS.
       - `https-<zone>` and `https-wildcard-<zone>` (:443, hostnames `<z>` and `*.<z>` per env zone):
         TLS `Terminate` with `certificateRefs` → `bbm-wildcard-tls` (same namespace, so no
         ReferenceGrant), admitting HTTPRoutes from namespaces labelled
         **`bbm.io/gateway-access=true`** (`from: Selector`).
- **App chart:** an `HTTPRoute` (instead of an Ingress) in the release namespace, `parentRefs` →
  Gateway `bbm-platform/bbm`, `hostnames: [ingress.host]`, rules `/api` (prefix) and `/health`
  (exact) → api, `/` → web. TLS and the HTTP redirect live on the Gateway, so the chart has no TLS
  settings and no per-namespace or per-PR certificates (no Let's Encrypt rate-limit risk). The value
  keys stay `ingress.*` (`ingress.host` from `helm_values`, `ingress.gateway.{name,namespace}`).
  NetworkPolicies admit web/api traffic from pods labelled
  `gateway.networking.k8s.io/gateway-name=bbm` in namespace `bbm-platform` (the label Istio puts on
  the Gateway's Envoy pods).
- **Namespace label:** `deploy.yml` labels `bbm` and `_ephemeral-env.yml` labels each `run-*` /
  `pr-*` namespace `bbm.io/gateway-access=true`; both wait for the HTTPRoute to be `Accepted`
  before probing HTTPS. A namespace without the label cannot publish a host on the shared Gateway.
- **Identity:** `stacks/data` creates UAMI `id-bbm-<env>-certmgr` and grants it **DNS Zone
  Contributor** on each of the env's public zones (zone scope only). `stacks/compute` adds the
  federated credential `system:serviceaccount:cert-manager:cert-manager`. "DNS Zone Contributor" is
  added to `env_delegable_roles` in `stacks/bootstrap/identities.tf`.

### 4. Identities

- `gh-bbm-ephemeral` (GitHub Environments `test`, `preview`) no longer runs Terraform. On the test
  cluster it gets: **AKS RBAC Cluster Admin** and **Cluster User** on the test compute RG, **Reader**
  on the test data RG, **Reader** on the shared RG (`rg-bbm-shared-eus2`: ACR, shared Log
  Analytics), **BBM Power Operator** on the test data and compute RGs, `BBM tfstate reader` on
  `test/` (to read `helm_values`) and on `global.tfstate`, plus its existing AcrPush. Its ACA-only roles go.
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
`ingress.publicIpResourceGroup` (bound by the Gateway). The app chart uses `ingress.host` as its
HTTPRoute hostname and ignores the other keys. The Gateway API move (section 3) changed no keys.

### 6. One-command bring-up and teardown

- **`infra/up.sh --subscription <id> [--zone <zone>] [--envs test,staging] [--prod] [--skip-github]
  [--yes] [--dry-run]`**, run locally after `az login --use-device-code`. `--envs` defaults to
  `test,staging`; `--prod` adds prod; `--skip-github` leaves the GitHub setup script for later; `--yes`
  answers every confirmation (and keeps going when the delegation has not propagated yet);
  `--dry-run` prints mutating commands and file edits instead of running them. It fills
  `bootstrap.tfvars` (subscription, admin object id, registered providers, zone, and `github_repo`
  from `gh repo view`), applies bootstrap on local state and migrates it to the new state account,
  writes the bootstrap `suffix` into every tfvars that needs it (no hand editing), runs the generated
  `gh-setup.sh`, handles DNS delegation (section 2), applies `global`, mirrors the third-party images
  into ACR, then for each env applies `data`, sets a placeholder `llm-api-key` if missing, applies
  `compute` and installs the platform. It ends by printing the URLs and the tfvars files to commit.
  Every step is idempotent, so a failed run is resumed by running it again. If `bootstrap.tfvars`
  already holds a different (non-placeholder) `subscription_id`, it warns and offers to reset the
  per-tenant fields first (`--yes` resets).
- **`infra/down.sh --subscription <id> (--envs test,staging,prod | --all) [--keep-github] [--yes]
  [--dry-run]`** destroys in reverse (`compute`, `data` per env; with `--all` also `global` and
  `bootstrap`, pulling bootstrap state back to local first), purges soft-deleted Key Vaults so names
  are reusable, removes the Cloudflare NS records if the token is set, and with `--all` deletes the
  GitHub repo variables and environments it created (unless `--keep-github`). It asks you to type
  the subscription name to confirm (`--yes` skips that). After a successful `--all` it resets the
  per-tenant tfvars fields (`subscription_id`, `suffix`, the admin / power-operator / Key Vault
  officer object id lists, the global hint block's principal ids, the backend `.hcl` state account)
  to their placeholders, and keeps `dns_zone_name`, `alert_emails` and `github_reviewer_ids`.

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
- **Keep the app-routing managed NGINX (`NginxIngressController`).** What this ADR first shipped
  with. Upstream ingress-nginx is retired and Azure support ends in November 2026, i.e. within this
  project's lifetime. Rejected.
- **Self-managed ingress-nginx or another Ingress controller via Helm.** Ingress API only, and one
  more component for us to patch; ingress-nginx itself is unmaintained. Rejected.
- **Application Gateway for Containers (AGC).** Azure-managed, supports Gateway API and Ingress, but
  it is a separately billed Azure resource (hourly plus capacity units) with its own subnet,
  identity and ALB controller to run, and it does not bind our existing static PIP: hostnames would
  point at an AGC frontend FQDN (CNAME), not the apex/wildcard alias A records of section 2. Too
  much cost and moving parts for a student project. Rejected.
- **Istio service mesh add-on with Gateway API.** Same Gateway API surface plus `EnvoyFilter`, but
  revisioned: minor upgrades are manual canary upgrades even when used only for ingress, and it
  cannot be enabled together with the app routing implementation. We need no mesh features.
  Rejected.
- **Self-managed Envoy Gateway (or another Gateway API implementation) via Helm.** Portable and
  feature-rich, but AKS supports the Managed Gateway API CRDs only with an AKS add-on
  implementation, and we would own its upgrades and CVEs. Rejected for the managed add-on, which is
  upgraded in place with the cluster.
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
- **Region is hardcoded in workflows (known limitation):** `deploy.yml`, `_ephemeral-env.yml`,
  `env-power.yml`, `infra-janitor.yml` and `contracts-deploy.yml` spell resource group and cluster
  names with the `eus2` suffix (e.g. `rg-bbm-test-data-eus2`, `aks-bbm-test-eus2`). Moving to
  another region means changing `location` / `location_abbr` in the tfvars and those names in the
  workflows (or exporting them as repo variables first). Not refactored now.
- New delegable role (DNS Zone Contributor) and the test-cluster roles for `gh-bbm-ephemeral` are
  applied by bootstrap, locally, by an Owner.
- **Gateway API:** the compute stack adds the `Azure/azapi` provider (`~> 2.0`) for the one setting
  azurerm lacks; drop it once azurerm exposes the ingress profile's Gateway API fields. The Envoy
  data plane runs at least 2 replicas per cluster (add-on floor), slightly more than NGINX's 1 on
  test/staging. App routing Gateway API cannot set request body/header size limits or rate limits
  (no `EnvoyFilter`); the app relies on its own limits. TLSRoute/SNI passthrough and egress are not
  supported; we use neither. The add-on upgrades istiod in place with the cluster's Kubernetes
  version (respecting the maintenance window), and the CRD bundle follows the Kubernetes minor.
- **Admission:** a namespace must carry `bbm.io/gateway-access=true` to publish a host; routes are
  also limited to hostnames under the env zones by the listener hostnames.
