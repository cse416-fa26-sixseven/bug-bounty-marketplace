# Azure bootstrap

How to bring the whole Azure footprint up on a new subscription. The main path is one script,
`infra/up.sh`. It is idempotent: if it stops, fix the cause and run it again; finished steps are
skipped.

You need **Owner** on the subscription, the right to create Entra app registrations, and **admin**
on the GitHub repo. After bootstrap, CI takes over: every Azure workflow skips green until the repo
variables written here exist.

Design background: [ADR 0001](../adr/0001-azure-environment-topology.md) (topology, identities,
state) and [ADR 0002](../adr/0002-aks-everywhere-and-azure-dns.md) (AKS for every env, Azure DNS,
TLS, `up.sh` / `down.sh`). The Terraform layout and `tf.sh` are in
[infra/terraform/README.md](../../infra/terraform/README.md). To move to another subscription or
domain later, see [Switching accounts or domains](switching-accounts.md).

What ends up in Azure:

| Stack       | Creates                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap` | state account `stbbmtfstate<sfx>` (locked, Entra auth only); every resource group; provider registrations; GitHub OIDC apps `gh-bbm-*` and their roles; DNS parent zone and child zones; the $50/month subscription budget |
| `global`    | ACR `acrbbm<sfx>`, shared Log Analytics, shared Key Vault (no secrets), per-RG budgets                                                                                                                                     |
| `data`      | per env: VNet, Postgres (not `test`), Key Vault, storage, identities, static ingress IP, DNS records, private zone                                                                                                         |
| `compute`   | per env: AKS cluster, node pools, workload-identity federated credentials                                                                                                                                                  |
| platform    | per cluster (Helm, not Terraform): cert-manager and `bbm-platform` (Let's Encrypt issuers, wildcard certificate, Gateway `bbm` of gatewayClass `approuting-istio`)                                                         |

Environments: `test` (CI-run and PR-preview namespaces), `staging` and `prod`. `up.sh` brings up
`test` and `staging` by default; add `--prod` for prod.

## 1. Prerequisites

| Tool       | Version                        | Check                      |
| ---------- | ------------------------------ | -------------------------- |
| Azure CLI  | 2.60+                          | `az version`               |
| Terraform  | **1.9.x** (CI pins 1.9.8)      | `terraform version`        |
| GitHub CLI | 2.40+, logged in as repo admin | `gh auth status`           |
| kubectl    | recent                         | `kubectl version --client` |
| kubelogin  | recent                         | `kubelogin --version`      |
| Helm       | 3.x (CI pins v3.16.2)          | `helm version`             |

Also `jq`, `curl`, `awk` and `bash`. `dig` or `nslookup` is optional (without them the DNS checks
use DNS-over-HTTPS through `curl`).

`up.sh` refuses any Terraform other than 1.9.x, because newer versions write state that 1.9 can't
read. `BBM_ALLOW_ANY_TERRAFORM=1` skips the check.

## 2. Log in

```sh
az login --use-device-code                 # add --tenant <tenant-id> if the subscription is in another tenant
az account list -o table                   # find the subscription GUID
gh auth login                              # skip if `gh auth status` is already fine
```

Log in as a **user**, not a service principal: `up.sh` reads your object ID with
`az ad signed-in-user show`.

## 3. Choose the DNS zone

All hostnames come from one input, `dns_zone_name` in `infra/terraform/envs/global/bootstrap.tfvars`.
Nothing else in the repo names a domain.

- Use a subdomain of a domain you control, for example `bbm.example.com`. Azure DNS hosts this zone
  and its child zones; the parent domain only needs four NS records pointing at Azure.
- Pass it with `--zone`, or leave it out and `up.sh` reads it from `bootstrap.tfvars`, or asks.
- Hosts that result:

  | Env        | App host (web, `/api`, `/health`) |
  | ---------- | --------------------------------- |
  | prod       | `prod.<zone>`                     |
  | staging    | `staging.<zone>`                  |
  | CI run     | `run-<id>-<attempt>.test.<zone>`  |
  | PR preview | `pr-<n>.preview.<zone>`           |

  The parent zone apex (`<zone>` itself) serves nothing yet.

## 4. Check quota, SKUs and versions

`up.sh` checks these and prints warnings, but it can't raise quota. Check early, because quota
requests can take time.

### vCPU quota

```sh
az vm list-usage -l eastus2 -o table
```

| Row                         | Needed for                              | Rough need                                                             |
| --------------------------- | --------------------------------------- | ---------------------------------------------------------------------- |
| Total Regional vCPUs        | everything                              | 2 per running node; three clusters at once is 6+, more when they scale |
| Standard BASv2 Family vCPUs | `Standard_B2als_v2` (default node size) | test 1–3 nodes, staging 1–2, prod system 1–2 + apps 1–3                |
| Standard DSv5 Family vCPUs  | Kata sandbox pool (disabled by default) | 0 until the sandbox is enabled                                         |

New subscriptions often show a low regional limit (sometimes 4–10) and 0 for some families. To ask
for more: **Portal → Quotas → Compute**, filter by region `East US 2`, pick the family, **New quota
request**. Small B-series increases are usually approved within minutes.

### PostgreSQL Flexible Server SKU

```sh
az postgres flexible-server list-skus -l eastus2 -o json \
  | jq -r '.[].supportedServerEditions[] | select(.name=="Burstable") | .supportedServerSkus[].name' \
  | grep -i b1ms
```

If `Standard_B1ms` isn't listed, PG Flexible is restricted for this subscription in `eastus2`. Only
staging and prod use it (test runs Postgres in each namespace).

### AKS versions

`up.sh` lists the GA AKS minors and rewrites `kubernetes_version` in `envs/<env>/compute.tfvars` to
the region default when the committed one isn't offered. To check by hand:
`az aks get-versions -l eastus2 -o table`.

### Fallback region

If AKS, PG Flexible or the B-series families are restricted in `eastus2` and a quota request doesn't
fix it, use `centralus`: set `location = "centralus"` and `location_abbr = "cus"` in
`bootstrap.tfvars`, `global.tfvars` and every `envs/<env>/data.tfvars`. Do this **before** the first
run; moving regions later means recreating everything. The workflows and scripts default to
`eus2` names, so a region change also needs those updated.

## 5. Optional: Cloudflare token for the NS records

If the parent domain's DNS is on Cloudflare, `up.sh` can create the four NS records for you (and
`down.sh --all` removes them). Create an API token in the Cloudflare dashboard (**My Profile → API
Tokens → Create Token → Custom token**):

| Setting        | Value                                                            |
| -------------- | ---------------------------------------------------------------- |
| Permissions    | **Zone → Zone → Read** and **Zone → DNS → Edit**                 |
| Zone resources | Include → Specific zone → the parent domain (e.g. `example.com`) |

Export it only in the shell that runs the script. It never goes into Terraform state, tfvars or
GitHub.

```sh
export CLOUDFLARE_API_TOKEN=...
```

`up.sh` looks for the closest parent of `<zone>` on Cloudflare, so the zone must be a subdomain of
a Cloudflare-hosted domain. For any other DNS host, add the records by hand (section 8).

## 6. Run `up.sh`

From the repo root:

```sh
infra/up.sh --subscription <subscription-guid> --zone bbm.example.com            # test + staging
infra/up.sh --subscription <subscription-guid> --zone bbm.example.com --prod     # also prod
infra/up.sh --subscription <subscription-guid> --dry-run                         # print, change nothing
infra/up.sh --help
```

| Flag             | Effect                                                                                |
| ---------------- | ------------------------------------------------------------------------------------- |
| `--subscription` | target subscription GUID (required)                                                   |
| `--zone`         | DNS zone; default `dns_zone_name` in `bootstrap.tfvars`, else a prompt                |
| `--envs`         | comma-separated envs (default `test,staging`)                                         |
| `--prod`         | also bring up prod (same as adding it to `--envs`)                                    |
| `--skip-github`  | don't run the generated GitHub setup script                                           |
| `--yes`          | no confirmations; accept defaults; keep going if the DNS delegation isn't visible yet (then install the platform without waiting for the certificate) |
| `--dry-run`      | print mutating commands and file edits; read-only queries still run                   |

Optional environment variables: `CLOUDFLARE_API_TOKEN` (section 5), `BBM_DNS_TIMEOUT` (seconds to
wait for the delegation, default 900), `BBM_DNS_POLL` (seconds between polls, default 20),
`BBM_ALLOW_ANY_TERRAFORM=1`.

Most of a first run's time goes to creating the AKS clusters and the Postgres servers.

## 7. What `up.sh` does

| Step | Name               | What happens                                                                                                                                                                                                   |
| ---- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Preflight          | checks tools and Terraform 1.9.x, `az login`, selects the subscription, reads your object ID, warns if you lack Owner, checks you are a `gh` admin on the repo                                                 |
| 2    | DNS zone           | takes `--zone`, the tfvars value or a prompt; writes `dns_zone_name`                                                                                                                                           |
| 3    | `bootstrap.tfvars` | writes `subscription_id`, adds you to `admin_object_ids`, fills `preregistered_resource_providers` with the providers already registered, asks for the budget alert email and the GitHub reviewer IDs if unset |
| 4    | Quota and versions | prints vCPU usage, checks PG `Standard_B1ms`, fixes `kubernetes_version` if not offered (warnings only)                                                                                                        |
| 5    | Bootstrap          | first run: applies on local state, then migrates the state into `stbbmtfstate<sfx>`. Later runs: applies on the remote state                                                                                   |
| 6    | tfvars             | writes `suffix` and `subscription_id` into every `envs/**/*.tfvars`, the state account into every `backend*.hcl`, the bootstrap hint block into `global.tfvars`, and you into `secret_officer_user_object_ids` |
| 7    | GitHub             | runs the bootstrap output `gh_setup_commands` after you confirm: repo variables, Environments, branch policies, `AZURE_CLIENT_ID` per Environment                                                              |
| 8    | DNS delegation     | prints the parent zone's four NS records; upserts them in Cloudflare when `CLOUDFLARE_API_TOKEN` is set                                                                                                        |
| 9    | Global             | applies `global`; imports `postgres:16-alpine` and `curlimages/curl:8.10.1` into ACR under `mirror/`                                                                                                           |
| 10   | Per env            | applies `data`; sets `llm-api-key` to `placeholder-set-me` if missing; applies `compute`; waits for the delegation (once); installs the platform with `deploy/platform/install.sh <env> --values ... --wait`   |
| 11   | Summary            | prints the URLs, next steps and the files it rewrote                                                                                                                                                           |

Notes:

- Bootstrap state access is human-only. The applying user and `admin_object_ids` get Storage Blob
  Data Contributor on the state container; CI identities get the custom `BBM tfstate writer` /
  `BBM tfstate reader` roles, limited per state prefix.
- Key Vault data-plane rights take a few minutes to propagate. `up.sh` retries `data` once and
  retries the `llm-api-key` write.
- The child zones (`prod.<zone>`, `staging.<zone>`, `test.<zone>`, `preview.<zone>`) are delegated
  inside Azure by bootstrap. Only the parent zone needs records at the domain's DNS host.
- If the delegation isn't visible at `1.1.1.1` before the first platform install, `up.sh` asks
  whether to continue (`--yes` continues). It then installs the platform **without** `--wait` and
  prints how to check the certificate (`kubectl -n bbm-platform get certificate bbm-wildcard`)
  later. cert-manager keeps retrying, so the certificate becomes Ready once the NS records resolve;
  re-running `up.sh` then waits for it.

## 8. Delegate the zone by hand (DNS hosts other than Cloudflare)

Add the four records `up.sh` printed at the DNS host of the parent domain:

| Name     | Type | Value                    |
| -------- | ---- | ------------------------ |
| `<zone>` | NS   | `ns1-xx.azure-dns.com.`  |
| `<zone>` | NS   | `ns2-xx.azure-dns.net.`  |
| `<zone>` | NS   | `ns3-xx.azure-dns.org.`  |
| `<zone>` | NS   | `ns4-xx.azure-dns.info.` |

The exact values are in the bootstrap output:

```sh
infra/terraform/scripts/tf.sh bootstrap global output -json dns_name_servers
```

Check the delegation:

```sh
dig +short NS bbm.example.com @1.1.1.1
dig +short NS staging.bbm.example.com @1.1.1.1      # child zones resolve once the parent does
```

If `up.sh` timed out waiting, add the records and run it again.

## 9. Commit what `up.sh` rewrote

The tfvars and backend files are the source of truth for this subscription; CI plans and applies
from them. `up.sh` ends with a `git status` of `infra/terraform/envs`. Commit those files on a
branch and open a PR:

- `infra/terraform/envs/global/bootstrap.tfvars`, `global.tfvars`, `backend.hcl`
- `infra/terraform/envs/<env>/data.tfvars`, `compute.tfvars`, `backend-data.hcl`,
  `backend-compute.hcl`

Also uncomment `backend "azurerm" {}` in `infra/terraform/stacks/bootstrap/versions.tf` and commit
it. Until then `up.sh` uses a gitignored `bbm_backend_override.tf` and warns, and other machines
would treat bootstrap as never applied.

## 10. Set the real `llm-api-key`

`up.sh` sets `llm-api-key` to `placeholder-set-me` in each env vault so pods can start (the Key
Vault CSI mount fails if the secret is missing). Replace it when you have the key:

```sh
KV=$(infra/terraform/scripts/tf.sh data staging output -raw key_vault_name)   # repeat per env
az keyvault secret set --vault-name "$KV" -n llm-api-key --value "<key>"
```

Terraform never manages this secret, so the real value never enters state. The CSI driver picks up
the new version within its 2-minute rotation interval. A 403 means your user isn't in
`secret_officer_user_object_ids` in `envs/<env>/data.tfvars` (`up.sh` adds you; those grants use
`principal_type = "User"`, which CI can't create, so apply changes to that list locally).

## 11. Check GitHub Environment protection

`gh_setup_commands` creates these Environments:

| Environment         | Identity            | Required reviewers                              | Deployment branches         |
| ------------------- | ------------------- | ----------------------------------------------- | --------------------------- |
| `test`              | `gh-bbm-ephemeral`  | none                                            | `main` (pushes `bbm/*:sha-*`) |
| `preview`           | `gh-bbm-preview`    | none                                            | any (PR branches need it; pushes only `bbm-preview/*`) |
| `test-infra`        | `gh-bbm-test`       | none                                            | `main`                      |
| `infra-global`      | `gh-bbm-global`     | 1                                               | `main`                      |
| `contracts-sepolia` | `gh-bbm-global`     | 1                                               | any                         |
| `staging`           | `gh-bbm-staging`    | none                                            | `main`                      |
| `prod`              | `gh-bbm-prod`       | 1                                               | `main`                      |
| `prod-power`        | `gh-bbm-prod-power` | none (scheduled auto-pause must run unattended) | `main`                      |

It also sets the repo variables `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_PLAN_CLIENT_ID`,
`TFSTATE_RG`, `TFSTATE_ACCOUNT` and `ACR_NAME`, and `AZURE_CLIENT_ID` per Environment. These are
IDs, not secrets.

If `github_reviewer_ids` was empty, the reviewer-gated Environments are created without reviewers.
Add one in **Settings → Environments → `<env>`** (tick **Required reviewers**), or with the CLI:

```sh
REPO=cse416-fa26-sixseven/bug-bounty-marketplace
REVIEWER_ID=$(gh api users/<github-login> --jq .id)
gh api -X PUT "repos/$REPO/environments/prod" --input - <<EOF
{
  "reviewers": [{ "type": "User", "id": $REVIEWER_ID }],
  "deployment_branch_policy": { "protected_branches": false, "custom_branch_policies": true }
}
EOF
```

Repeat for `infra-global`. For `contracts-sepolia`, which isn't branch-restricted, send
`"deployment_branch_policy": null`. Re-running the script keeps reviewers added by hand.

## 12. Set the shared Key Vault secrets

Terraform creates only the vault. Set the Sepolia secrets with `az`, so they never enter state:

```sh
KV=$(infra/terraform/scripts/tf.sh global global output -raw shared_key_vault_name)
az keyvault secret set --vault-name "$KV" --name sepolia-rpc-url      --value "https://..."
az keyvault secret set --vault-name "$KV" --name sepolia-deployer-key --file ./deployer.key
az keyvault secret set --vault-name "$KV" --name etherscan-api-key    --value "..."   # optional
```

Use `--file` for the deployer key so it doesn't land in shell history, then delete the file. A 403
(`ForbiddenByRbac`) means you aren't in `secret_officer_user_object_ids` in `global.tfvars`
(`up.sh` adds you), or the assignment hasn't propagated yet.

## 13. First app deploy

1. Merge the PR from section 9. The push to `main` runs `integration-azure.yml`, which builds and
   pushes `sha-<7>` images and tests them in a namespace on the test cluster.
2. Run **Deploy (AKS)** (`deploy.yml`) with `env=staging` and `image_tag=sha-<7>` from that green
   run. For prod, run it with `env=prod`; a reviewer must approve.
3. Open `https://staging.<zone>`.

After the first deploy, `env-power <env> up` redeploys the last deployed tag. Pause idle envs with
**Env power** (`env-power.yml`); see [env-lifecycle.md](env-lifecycle.md). The nightly auto-pause
also covers them.

## Verification checklist

- [ ] `up.sh` ended with `done` and no warnings you haven't dealt with.
- [ ] `dig +short NS <zone> @1.1.1.1` prints the four Azure name servers.
- [ ] `az group list --query "[?tags.project=='bbm'].name" -o tsv` lists the tfstate and shared
      RGs and `rg-bbm-<env>-data-eus2` / `rg-bbm-<env>-compute-eus2` for test, staging and prod.
- [ ] `az network dns zone list --query "[].name" -o tsv` lists `<zone>`, `test.<zone>`,
      `preview.<zone>`, `staging.<zone>` and `prod.<zone>`.
- [ ] `az lock list -g rg-bbm-tfstate-eus2 -o table` shows `lock-bbm-tfstate`.
- [ ] `infra/terraform/scripts/tf.sh bootstrap global plan` reports **No changes**.
- [ ] `az ad app list --display-name gh-bbm- --query "[].displayName" -o tsv` lists `gh-bbm-plan`,
      `gh-bbm-ephemeral`, `gh-bbm-preview`, `gh-bbm-global`, `gh-bbm-test`, `gh-bbm-staging`,
      `gh-bbm-prod` and `gh-bbm-prod-power`.
- [ ] `az acr show -n <acr> --query roleAssignmentMode -o tsv` prints `AbacRepositoryPermissions`
      (only the Container Registry Repository roles grant image access; AcrPull/AcrPush do not).
- [ ] `gh variable list --repo cse416-fa26-sixseven/bug-bounty-marketplace` shows the six repo variables.
- [ ] `gh api repos/cse416-fa26-sixseven/bug-bounty-marketplace/environments --jq '.environments[].name'`
      lists all eight Environments.
- [ ] Per cluster: `kubectl get certificate -n bbm-platform bbm-wildcard` shows `READY True`.
- [ ] `az acr repository show -n <acr> --repository mirror/postgres` and
      `--repository mirror/curl` succeed.
- [ ] The shared vault lists `sepolia-rpc-url` and `sepolia-deployer-key`; each env vault has a real
      `llm-api-key`.
- [ ] Dispatch `terraform.yml` with a `plan` of `global`. It logs in through OIDC and reports no
      changes.

## Teardown

```sh
infra/down.sh --subscription <guid> --envs staging          # one env: compute, then data
infra/down.sh --subscription <guid> --all                   # everything, including bootstrap
infra/down.sh --subscription <guid> --all --dry-run         # show what would go
```

`down.sh` asks you to type the subscription name. When prod is included (`--envs ...,prod` or
`--all`) it also asks you to type `prod`; `--yes` skips that only together with
`--yes-really-destroy-prod`, and without a terminal it refuses. Order: per env (test, staging, prod) `compute`
then `data`; with `--all` also `global`, the Cloudflare NS records (if `CLOUDFLARE_API_TOKEN` is
set), the GitHub variables and Environments (unless `--keep-github`), and bootstrap last. It pulls
the bootstrap state back to local first, because that state lives in the account being deleted.
Finally it purges the soft-deleted Key Vaults of the envs it destroyed (`kv-bbm-<tst|stg|prd>-<suffix>`,
and `kv-bbm-shared-<suffix>` only with `--all`) so the names can be reused; vaults of envs it kept
are left alone.

With `--all`, after a successful teardown it resets the per-tenant fields in the tfvars and
backend files (subscription, suffix, object-id lists, state account) to their placeholders and
prints each change; `dns_zone_name`, `alert_emails`, `github_reviewer_ids` and `github_repo` are
kept ([switching-accounts.md](switching-accounts.md) section 2). `--envs` alone changes no files.
Deleted Entra app registrations stay in the Entra recycle bin for 30 days.

For pausing instead of deleting, use **Env power** ([env-lifecycle.md](env-lifecycle.md)).

## Appendix: the manual path

What `up.sh` runs, for debugging a single step. Commands run from `infra/terraform`.

1. **Fill `envs/global/bootstrap.tfvars`:** `subscription_id`, `admin_object_ids`
   (`az ad signed-in-user show --query id -o tsv`), `alert_emails`, `budget_start_date` (first of
   the current month, RFC3339), `github_reviewer_ids` (`gh api users/<login> --jq .id`),
   `dns_zone_name`, and `preregistered_resource_providers`: every namespace from
   `stacks/bootstrap/main.tf` `local.resource_providers` that
   `az provider list --query "[?registrationState=='Registered'].namespace" -o tsv` already shows.
   Registering one again fails the apply.
2. **Bootstrap on local state** (the `backend "azurerm" {}` block in
   `stacks/bootstrap/versions.tf` commented out):

   ```sh
   terraform -chdir=stacks/bootstrap init
   ./scripts/tf.sh bootstrap global plan -out=tfplan
   ./scripts/tf.sh bootstrap global apply tfplan
   ```

3. **Migrate the state:** uncomment the backend block, set `storage_account_name` in
   `envs/global/backend.hcl` to the `tfstate_storage_account` output, then
   `./scripts/tf.sh bootstrap global init -migrate-state -force-copy`. Check
   `./scripts/tf.sh bootstrap global plan` shows no changes, then delete
   `stacks/bootstrap/terraform.tfstate*`. A 403 right after the apply is role propagation; wait and
   retry.
4. **State coordinates for later runs:**

   ```sh
   export TFSTATE_RG=rg-bbm-tfstate-eus2
   export TFSTATE_ACCOUNT=$(./scripts/tf.sh bootstrap global output -raw tfstate_storage_account)
   ```

5. **tfvars:** replace the lines between `# >>> bootstrap hint` and `# <<< bootstrap hint` in
   `envs/global/global.tfvars` with `./scripts/tf.sh bootstrap global output -raw global_tfvars_hint`.
   Set `suffix` and `subscription_id` in every `envs/<env>/*.tfvars`, `storage_account_name` in
   every `backend*.hcl`, and add your object ID to `secret_officer_user_object_ids` in
   `global.tfvars` and each `data.tfvars`.
6. **GitHub:** `./scripts/tf.sh bootstrap global output -raw gh_setup_commands > /tmp/gh-setup.sh`,
   read it, then `bash /tmp/gh-setup.sh`.
7. **Delegation:** section 8.
8. **Global and image mirrors:**

   ```sh
   ./scripts/tf.sh global global init && ./scripts/tf.sh global global plan -out=tfplan
   ./scripts/tf.sh global global apply tfplan
   ACR=$(./scripts/tf.sh global global output -raw acr_name)
   az acr import -n "$ACR" --source docker.io/library/postgres:16-alpine --image mirror/postgres:16-alpine
   az acr import -n "$ACR" --source docker.io/curlimages/curl:8.10.1   --image mirror/curl:8.10.1
   ```

   CI-run and preview namespaces pull Postgres from the mirror, and `helm test` pulls curl from it.
   The ephemeral identities can't import images, so a missing mirror fails those runs. The registry
   is in ABAC repository-permissions mode, where Owner grants no image access: bootstrap gives each
   `admin_object_ids` user Container Registry Repository Contributor + Catalog Lister on the shared
   RG, which `az acr repository show` / `show-tags` need (the import itself is control plane).
9. **Per env** (`test`, `staging`, `prod`):

   ```sh
   ./scripts/tf.sh data <env> init && ./scripts/tf.sh data <env> apply
   az keyvault secret set --vault-name "$(./scripts/tf.sh data <env> output -raw key_vault_name)" \
     -n llm-api-key --value placeholder-set-me
   ./scripts/tf.sh compute <env> init && ./scripts/tf.sh compute <env> apply
   az aks get-credentials -g rg-bbm-<env>-compute-eus2 -n aks-bbm-<env>-eus2 --overwrite-existing
   kubelogin convert-kubeconfig -l azurecli
   ./scripts/tf.sh compute <env> output -raw helm_values > /tmp/values-infra.yaml
   ../../deploy/platform/install.sh <env> --values /tmp/values-infra.yaml --wait
   ```

Restoring a damaged state file: the state account keeps blob versions and 14 days of soft delete.
Use **Portal → Storage account → Containers → tfstate → `<key>` → Versions**.

## Troubleshooting

| Symptom                                                           | Cause and fix                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up.sh`: "Not logged in to Azure" or "cannot select subscription" | Run `az login --use-device-code`, with `--tenant <id>` if the subscription is in another tenant.                                                                                                                                                                                                                                  |
| `up.sh`: "Terraform x.y found; use 1.9.x"                         | Install Terraform 1.9.x (e.g. with `tfenv`). `BBM_ALLOW_ANY_TERRAFORM=1` overrides, but state written by a newer version can't be read by CI.                                                                                                                                                                                     |
| `MissingSubscriptionRegistration`                                 | A provider isn't registered yet. The provider config sets `resource_provider_registrations = "none"`, so only bootstrap's registrations count. Re-run `up.sh`; registration can take minutes.                                                                                                                                     |
| Bootstrap apply: provider "already registered"                    | Add it to `preregistered_resource_providers` (`up.sh` does this for providers registered before the run) and re-run.                                                                                                                                                                                                              |
| `LocationIsOfferRestricted` (often PG Flexible or AKS)            | The subscription is blocked for that SKU in the region. Open a support request (**Help + support → Service and subscription limits**) or use the fallback region (section 4) before the first run.                                                                                                                                |
| `QuotaExceeded` when creating node pools                          | Not enough family or regional vCPUs. Request more (section 4). Bring up fewer envs meanwhile (`--envs test`).                                                                                                                                                                                                                     |
| `VaultAlreadyExists` / vault in deleted state                     | A soft-deleted vault holds the name. A re-apply normally recovers it (`recover_soft_deleted_key_vaults = true`). Otherwise `az keyvault list-deleted -o table`, then `az keyvault recover -n <name>` or `az keyvault purge -n <name> -l eastus2`.                                                                                 |
| `up.sh` waits for the delegation and times out                    | The NS records for `<zone>` are missing or wrong at the parent domain's DNS host, or still propagating. Compare `dig +short NS <zone> @1.1.1.1` with the `dns_name_servers` output. With Cloudflare, check the token scope (section 5). Re-run `up.sh` once they match.                                                           |
| Cloudflare: "no Cloudflare zone found for any parent of `<zone>`" | The token can't see the parent domain, or the domain isn't on Cloudflare. Fix the token's zone resources, or unset `CLOUDFLARE_API_TOKEN` and add the records by hand.                                                                                                                                                            |
| Certificate not Ready (`install.sh --wait` times out)             | `kubectl describe certificate -n bbm-platform bbm-wildcard`, then `kubectl get orders,challenges -A` and `kubectl -n cert-manager logs deploy/cert-manager`. Most often the delegation hasn't resolved yet; cert-manager retries on its own.                                                                                      |
| Challenge stuck `pending`, "propagation check failed"             | The child zone (`<env>.<zone>`) doesn't resolve publicly yet. Check `dig +short NS staging.<zone> @1.1.1.1`. The parent delegation must work first.                                                                                                                                                                               |
| Challenge error `AuthorizationFailed` on `dnsZones/TXT`           | `id-bbm-<env>-certmgr` lacks DNS Zone Contributor on that zone. Re-apply the env's `data` stack.                                                                                                                                                                                                                                  |
| Challenge error `AADSTS70021` / no matching federated identity    | The compute stack's federated credential for `system:serviceaccount:cert-manager:cert-manager` is missing (re-apply `compute`), or cert-manager started before its SA annotation. Re-run `install.sh` and `kubectl -n cert-manager rollout restart deploy/cert-manager`.                                                          |
| Let's Encrypt rate limit (`too many certificates`)                | Repeated reinstalls of the same zone. Use `install.sh <env> --values ... --issuer letsencrypt-staging` while debugging, then re-run without `--issuer`.                                                                                                                                                                           |
| `AADSTS700213: No matching federated identity record found`       | The workflow's OIDC subject doesn't match. Jobs with `environment: <env>` present `repo:cse416-fa26-sixseven/bug-bounty-marketplace:environment:<env>`; plan jobs present `...:pull_request` or `...:ref:refs/heads/main`. Check the job's `environment:`, its `AZURE_CLIENT_ID`, and `az ad app federated-credential list --id <app-id>`. |
| `AADSTS700212` (audience)                                         | The `azure/login` audience must be `api://AzureADTokenExchange` (the default).                                                                                                                                                                                                                                                    |
| 403 `AuthorizationPermissionMismatch` on state blobs              | The identity lacks its tfstate role, the key is outside its allowed prefixes (e.g. `gh-bbm-plan` reading `prod/`), or the assignment hasn't propagated (allow about 10 minutes).                                                                                                                                                  |
| Plan job can't take the state lock (403 on the lease)             | `gh-bbm-plan` is read-only on state by design. Plan with `-lock=false`.                                                                                                                                                                                                                                                           |
| `ScopeLocked` when deleting the state account or its RG           | The `lock-bbm-tfstate` lock works as intended. Use `down.sh --all`, which destroys the lock through Terraform. To remove it by hand: `az lock delete -n lock-bbm-tfstate -g rg-bbm-tfstate-eus2 --resource-type Microsoft.Storage/storageAccounts --resource <account>`.                                                          |
| CI run fails: `mirror/postgres:16-alpine is missing`              | The image mirror wasn't imported. Run the `az acr import` commands in the appendix (step 8), or re-run `up.sh`.                                                                                                                                                                                                                   |
| `az acr import` fails with an authentication error                | Your user needs Contributor or `AcrImport` on the registry. Owner on the subscription is enough.                                                                                                                                                                                                                                  |
