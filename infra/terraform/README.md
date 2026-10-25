# infra/terraform

Terraform for the BBM Azure deployment (region `eastus2`, project code `bbm`).
Three AKS environments (`test`, `staging`, `prod`) behind Azure DNS, per
[ADR 0002](../../docs/adr/0002-aks-everywhere-and-azure-dns.md) (which
supersedes the ACA parts of ADR 0001). `infra/up.sh` / `infra/down.sh` drive
the whole bring-up and teardown; first-time subscription setup, including
Entra and GitHub prerequisites, is in
[docs/devops/azure-bootstrap.md](../../docs/devops/azure-bootstrap.md).

## Layout

```
infra/terraform/
  .tflint.hcl            shared TFLint config (terraform recommended + azurerm ruleset)
  modules/
    naming/              every resource name + the standard tag set (pure, no resources)
    github-oidc/         Entra app + SP + GitHub federated credentials + RBAC per CI identity
    budget/              subscription or resource-group cost budget with email alerts
    acr/                 container registry (Basic, admin user disabled)
    observability/       Log Analytics workspace (daily cap, 30-day retention)
    network/ keyvault/ postgres-flexible/ storage/ identity/
    aks/ workload-identity-federation/
  stacks/
    bootstrap/           state storage, every RG, providers, OIDC identities, DNS zones, sub budget
    global/              ACR, shared LAW, shared Key Vault, RG budgets
    data/                per env: VNet, PG (not test), KV, storage, UAMIs, ingress PIP, DNS records
    compute/             per env: AKS (+ app routing Gateway API via azapi), node pools, federated credentials, helm_values
  envs/
    global/              bootstrap.tfvars, global.tfvars, backend.hcl
    test/ staging/ prod/ data.tfvars, compute.tfvars, backend-data.hcl, backend-compute.hcl
  scripts/
    tf.sh                wrapper: picks stack dir, var-file, backend config and state key
    ci-static.sh         fmt + validate + test + tflint + shellcheck (what CI runs)
    env-power.sh         status / pause / resume / down / up per env
    janitor.sh           deletes expired ephemeral namespaces on the test cluster
```

## Running Terraform: `scripts/tf.sh`

```sh
cd infra/terraform
./scripts/tf.sh <stack> <env> <init|plan|apply|destroy|output|validate|...> [extra args]

./scripts/tf.sh global global init
./scripts/tf.sh global global plan -out=tfplan      # -out is relative to stacks/global
./scripts/tf.sh global global apply tfplan
./scripts/tf.sh global global validate              # init -backend=false + validate (no creds)
TFSTATE_ACCOUNT=stbbmtfstate<sfx> ./scripts/tf.sh data test plan
./scripts/tf.sh compute prod apply tfplan
```

| stack       | envs                    | var-file                       | backend file                                | state key               |
| ----------- | ----------------------- | ------------------------------ | ------------------------------------------- | ----------------------- |
| `bootstrap` | `global`                | `envs/global/bootstrap.tfvars` | `envs/global/backend.hcl` (after migration) | `bootstrap.tfstate`     |
| `global`    | `global`                | `envs/global/global.tfvars`    | `envs/global/backend.hcl`                   | `global.tfstate`        |
| `data`      | `test`,`staging`,`prod` | `envs/<env>/data.tfvars`       | `envs/<env>/backend-data.hcl`               | `<env>/data.tfstate`    |
| `compute`   | `test`,`staging`,`prod` | `envs/<env>/compute.tfvars`    | `envs/<env>/backend-compute.hcl`            | `<env>/compute.tfstate` |

- `$TFSTATE_RG` and `$TFSTATE_ACCOUNT` (the GitHub repo variables) override
  the resource group and storage account in the backend file, so CI never
  depends on the placeholder values committed in `backend.hcl`.
- When set, `$TFSTATE_RG` / `$TFSTATE_ACCOUNT` are also exported as
  `TF_VAR_tfstate_resource_group` / `TF_VAR_tfstate_account` (unless those are
  already set), so stacks that use `terraform_remote_state` get the backend
  coordinates without extra plumbing.
- `data` and `compute` read `global.tfstate` (and compute reads
  `<env>/data.tfstate`), so plans need `TFSTATE_ACCOUNT` (or
  `TF_VAR_tfstate_account`) set; without it they fail asking for
  `tfstate_account`.
- `TF_VAR_*` environment variables pass straight through.
- `apply <planfile>` (first extra arg is an existing file, relative to
  `stacks/<stack>` or absolute) applies the saved plan without `-var-file`;
  plain `apply` adds the env var-file as usual.
- `init` runs with `-input=false`, except with `-migrate-state` or
  `-reconfigure`, where Terraform may need to ask before copying state. Add
  `-force-copy` to skip that prompt in automation.

## State model

- All remote state lives in storage account `stbbmtfstate<sfx>`, container
  `tfstate`, in RG `rg-bbm-tfstate-eus2`. The account allows Entra auth only
  (`shared_access_key_enabled = false`). Every backend sets
  `use_azuread_auth = true` and `use_oidc = true`. Blob versioning and 14-day
  soft delete let you recover a damaged state file. A `CanNotDelete` lock
  protects the account.
- One state file per stack and env (keys above). Stacks read each other's
  outputs through `terraform_remote_state`: compute reads data, and
  data/compute read global. The exception is `global`, which takes the
  bootstrap outputs it needs (`suffix`, principal IDs, `dns_zone_name`) as
  tfvars, from the bootstrap-hint block of `envs/global/global.tfvars`.
- **Bootstrap starts on a local backend** because it creates the state
  account. After the first apply:
  1. Uncomment `backend "azurerm" {}` in `stacks/bootstrap/versions.tf`.
  2. Set `storage_account_name` in `envs/global/backend.hcl` to the
     `tfstate_storage_account` output.
  3. Run `./scripts/tf.sh bootstrap global init -migrate-state` and answer `yes`
     (`tf.sh` drops `-input=false` here so the prompt works).
  4. Delete `stacks/bootstrap/terraform.tfstate*`.

  `tf.sh` detects whether the backend block is active and only passes
  `-backend-config` when it is.

- State access is **prefix-scoped with ABAC conditions** on each CI identity's
  custom tfstate role on the `tfstate` container (blob path attribute, which
  excludes the container name). Leases (the backend's state lock) are
  `blobs/write` on the key's own blob, so locking works wherever writes are
  allowed.

  | identity            | role (on `tfstate`)  | read + write     | read only                               |
  | ------------------- | -------------------- | ---------------- | --------------------------------------- |
  | `gh-bbm-ephemeral`  | `BBM tfstate reader` | —                | `global.tfstate`, `test/*`              |
  | `gh-bbm-global`     | `BBM tfstate writer` | `global.tfstate` | —                                       |
  | `gh-bbm-test`       | `BBM tfstate writer` | `test/*`         | `global.tfstate`                        |
  | `gh-bbm-staging`    | `BBM tfstate writer` | `staging/*`      | `global.tfstate`                        |
  | `gh-bbm-prod`       | `BBM tfstate writer` | `prod/*`         | `global.tfstate`                        |
  | `gh-bbm-plan`       | `BBM tfstate reader` | —                | `global.tfstate`, `staging/*`, `test/*` |
  | `gh-bbm-prod-power` | none                 | —                | —                                       |

  The two custom roles (defined on `rg-bbm-tfstate-eus2`) carry only
  `containers/read` as a control-plane action plus blob data actions
  (writer: `blobs/read`, `write`, `add/action`, `delete`, `move/action`;
  reader: `blobs/read`). The built-in Storage Blob Data roles are avoided for
  CI because they also include `containers/write` and `containers/delete`,
  which the blob-path conditions cannot constrain, so a leaked CI token could
  delete the whole container.

  `bootstrap.tfstate` is human-only (the applying user and `admin_object_ids`
  have unconditioned built-in Storage Blob Data Contributor). List Blobs
  carries no blob path, so every state identity can still list key _names_ in
  the container, never contents. `gh-bbm-plan` cannot take the lock, so plan
  jobs must pass `-lock=false`; prod plans run in the `prod` environment as
  `gh-bbm-prod`.

  Accepted trade-off: `gh-bbm-plan` (PRs and `main`) can read `staging/*`,
  which contains the Terraform-generated staging secrets (PostgreSQL admin
  password, `database-url`). Staging holds no real data; `prod/*` is excluded
  for this reason. `test/*` holds no database secrets (no PG server).

## Bootstrap order (summary)

Normally `infra/up.sh` does all of this; the manual steps are:

1. `az login` as a subscription Owner who can create Entra app registrations.
2. Edit `envs/global/bootstrap.tfvars` (subscription, `admin_object_ids`,
   alert emails, `preregistered_resource_providers`, `dns_zone_name`).
3. Run `./scripts/tf.sh bootstrap global init`, then `plan -out=tfplan`, then
   `apply tfplan`.
4. Migrate the bootstrap state as described above.
5. Run `./scripts/tf.sh bootstrap global output -raw gh_setup_commands > /tmp/gh-setup.sh`,
   review the file, then run `bash /tmp/gh-setup.sh`.
6. Delegate the zone: add the `dns_name_servers` output as NS records for
   `dns_zone_name` at the domain's DNS host.
7. Replace the lines between `# >>> bootstrap hint` and `# <<< bootstrap hint`
   in `envs/global/global.tfvars` with
   `./scripts/tf.sh bootstrap global output -raw global_tfvars_hint`, and set
   `suffix` in every `envs/<env>/data.tfvars`. Then apply `global`, either
   locally or through the `infra-global` workflow.
8. Per env: `data`, set `llm-api-key` in the env Key Vault, `compute`, then
   `deploy/platform/install.sh <env>`.

`preregistered_resource_providers` may list any registered namespace; names
the stack does not manage are ignored.

If an apply fails because a resource provider is already registered, list its
namespace in `preregistered_resource_providers`; the stack then imports it
instead of registering it. You can also import it by hand:
`terraform import 'azurerm_resource_provider_registration.this["Microsoft.Network"]' /subscriptions/<sub>/providers/Microsoft.Network`.

## Environments and DNS

| env       | AKS tier | system pool         | PG server | public zones (in the env data RG) | VNet           |
| --------- | -------- | ------------------- | --------- | --------------------------------- | -------------- |
| `test`    | Free     | B2als_v2, 1–3 nodes | no        | `test.<zone>`, `preview.<zone>`   | `10.10.0.0/16` |
| `staging` | Free     | B2als_v2, 1–2 nodes | yes       | `staging.<zone>`                  | `10.20.0.0/16` |
| `prod`    | Standard | B2als_v2 + `apps`   | yes       | `prod.<zone>`                     | `10.30.0.0/16` |

- **Bootstrap** (`dns.tf`) creates the parent zone `dns_zone_name` in
  `rg-bbm-shared-eus2`, the child zones above, and NS delegation records for
  them in the parent. Outputs: `dns_zone_name`, `dns_name_servers` (to set at
  the domain's DNS host), `dns_child_zones` (env => zones).
- **Data** (`dns.tf`) reads `dns_zone_name` from global state, looks up its
  env zones and writes apex `@` and `*` alias A records to the ingress PIP. It
  also creates the private zone `<env>.internal.<zone>` linked to the VNet,
  with `postgres` CNAME → the PG FQDN when `postgres_enabled`. UAMI
  `id-bbm-<env>-certmgr` gets DNS Zone Contributor on each env zone.
- **`postgres_enabled = false`** (test): no PG server, no `snet-psql`
  delegation or PG private zone, no `database-url` / `pg-admin-password`
  secrets; `pg_fqdn` / `pg_server_name` are null. `psql_subnet_cidr` is still
  set so `networkPolicy.postgresCidr` stays valid.
- **Compute** federates `system:serviceaccount:cert-manager:cert-manager` to the
  certmgr UAMI and takes `aks_sku_tier` (`Free` | `Standard`, prod sets
  `Standard`).
- **Ingress** (`modules/aks`, ADR 0002 section 3): no `web_app_routing` block
  (no managed NGINX, no add-on DNS). `azapi_update_resource
  .app_routing_gateway_api` (`Microsoft.ContainerService/managedClusters@2026-03-01`)
  sets `ingressProfile.gatewayAPI.installation = Standard` (Managed Gateway
  API CRDs) and `ingressProfile.webAppRouting.gatewayAPIImplementations
  .appRoutingIstio.mode = Enabled` (GatewayClass `approuting-istio`), which
  azurerm cannot express; it is the same as `az aks update
  --enable-gateway-api --enable-app-routing-istio`. The compute stack therefore
  also needs the `Azure/azapi` provider (same OIDC / CLI auth as azurerm). The
  Gateway itself (static PIP binding, TLS) is in `deploy/helm/bbm-platform`.
  Check after an apply:
  `az aks show -g rg-bbm-<env>-compute-eus2 -n aks-bbm-<env>-eus2 --query ingressProfile`
  and `kubectl get gatewayclass approuting-istio`.

`helm_values` (compute output, `values-infra.yaml`):

```yaml
global:
  image: { registry: <acr>.azurecr.io }
azure: {} # tenantId, keyVaultName, *ClientId, storage*, queueName (unchanged)
ingress:
  host: <env>.<zone> # test: test.<zone>
  publicIpName: pip-bbm-<env>-ingress
  publicIpResourceGroup: rg-bbm-<env>-data-eus2
networkPolicy:
  postgresCidr: <snet-psql CIDR>
dns:
  zone: <zone>
  envZones: [<env>.<zone>] # test: [test.<zone>, preview.<zone>]
  internalZone: <env>.internal.<zone>
platform:
  subscriptionId: <subscription>
  dnsResourceGroup: rg-bbm-<env>-data-eus2
  certManagerClientId: <client id> # id-bbm-<env>-certmgr
```

**Ephemeral namespaces** (CI runs `run-<id>-<attempt>`, PR previews `pr-<n>`)
live on the test cluster and are not Terraform-managed. `gh-bbm-ephemeral`
(GitHub Environments `test`, `preview`) has AKS RBAC Cluster Admin + Cluster
User on the test compute RG, Reader on the test data RG, BBM Power Operator on
both test RGs, read access to `test/*` state (for `helm_values`) and AcrPush.
Terraform for the test env runs as `gh-bbm-test` (GitHub Environment
`test-infra`, `main` only).

## Static checks (no Azure credentials needed)

CI (`terraform-static` job) runs `scripts/ci-static.sh`, which does all of
the below for every stack and module dir that contains `*.tf` (new stacks
and modules are picked up automatically). Run the same thing locally:

```sh
infra/terraform/scripts/ci-static.sh     # needs terraform, tflint, shellcheck
```

Or step by step:

```sh
cd infra/terraform
terraform fmt -check -recursive .
./scripts/tf.sh bootstrap global validate && ./scripts/tf.sh global global validate
(cd modules/naming && terraform init -backend=false && terraform test)
(cd stacks/bootstrap && terraform test)   # mock providers
(cd stacks/global && terraform test)      # mock providers
(cd stacks/data && terraform test)        # mock providers + overridden remote state
(cd stacks/compute && terraform test)     # mock providers + overridden remote state
tflint --init && tflint --recursive --config "$(pwd)/.tflint.hcl"
shellcheck scripts/*.sh
```

Pass `--config "$(pwd)/.tflint.hcl"` to TFLint. In `--recursive` mode,
TFLint otherwise looks for a config file inside each module directory and
falls back to defaults, which skip the azurerm ruleset and the extra rules.

After changing provider constraints, refresh the stack lock files for every
platform the team uses:

```sh
terraform -chdir=stacks/<stack> providers lock \
  -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64
```

Lock files are committed for stacks only. Modules inherit the lock file of
the stack that calls them.
