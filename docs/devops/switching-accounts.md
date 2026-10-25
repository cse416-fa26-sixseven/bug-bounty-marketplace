# Switching accounts or domains

How to move the deployment to another Azure subscription, another tenant, or another DNS zone. The
scripts make this a teardown on the old side and a fresh bring-up on the new side. Background:
[ADR 0002](../adr/0002-aks-everywhere-and-azure-dns.md) section 6.

Nothing in the repo hardcodes a subscription or a domain. The subscription lives in the tfvars that
`up.sh` writes, and the domain is only `dns_zone_name` in
`infra/terraform/envs/global/bootstrap.tfvars`.

## What is lost

A switch recreates everything. Before you start, save anything you need:

| Lost                              | Notes                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Postgres data (staging, prod)     | dump it first (`pg_dump` through a pod in the cluster) if it matters                                             |
| Uploaded sources, queue messages  | in the env storage accounts                                                                                      |
| Key Vault secrets you set by hand | `llm-api-key`, `sepolia-rpc-url`, `sepolia-deployer-key`, `etherscan-api-key`: keep the values to set them again |
| ACR images                        | CI rebuilds them; the first deploy needs a new green `integration-azure.yml` run                                 |
| Terraform state                   | the old state account is deleted with bootstrap                                                                  |

## 1. Tear down the old subscription

Log in to the old account and destroy everything, including bootstrap:

```sh
az login --use-device-code
export CLOUDFLARE_API_TOKEN=...      # optional: removes the NS records for the old zone
infra/down.sh --subscription <old-guid> --all --dry-run    # review
infra/down.sh --subscription <old-guid> --all
```

`down.sh` asks you to type the subscription name, and `prod` as well (`--all` includes prod; with
`--yes` you also need `--yes-really-destroy-prod`). It destroys `compute` and `data` per env,
`global`, the Cloudflare NS records (with the token), the GitHub repo variables and Environments,
and bootstrap last. Then it purges the soft-deleted Key Vaults of what it destroyed (env vaults
and the shared vault). Pass `--keep-github` to leave
the GitHub side alone; the next `up.sh` overwrites it anyway.

If the old account is already gone (for example, an expired student subscription), skip this step.
Remove the GitHub repo variables and Environments by hand
(`gh variable delete <name> --repo ...`, `gh api -X DELETE repos/<repo>/environments/<env>`) and
delete the old NS records at the DNS host.

## 2. Reset values that belong to the old account

After a successful teardown, `down.sh --all` resets the per-tenant fields to their committed
placeholders and prints each one it changed. Commit the result. `up.sh` only **adds** to the
object-ID lists, so without this reset bootstrap on a new tenant would try to grant roles to users
that don't exist there.

| File                           | Reset                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `envs/global/bootstrap.tfvars` | `subscription_id`, `admin_object_ids`, `power_operator_object_ids`, `preregistered_resource_providers`                                |
| `envs/global/global.tfvars`    | hint block `subscription_id`, `suffix`, `ephemeral_ci_principal_id`, `preview_ci_principal_id`, `secret_officer_sp_object_ids`; `secret_officer_user_object_ids` |
| `envs/<env>/*.tfvars`          | `subscription_id`, `suffix`, and `secret_officer_user_object_ids` in `data.tfvars`                                                    |
| `envs/**/backend*.hcl`         | `resource_group_name`, `storage_account_name` (`stbbmtfstate0000`)                                                                    |

Kept, because they survive an account switch: `dns_zone_name`, `alert_emails`,
`github_reviewer_ids`, `github_repo`, and the regions: the home region (`location` /
`location_abbr` in `envs/global/*.tfvars`) and each env's region (`envs/<env>/*.tfvars`, mirrored
in `env_locations`). Regions are a user choice, not a per-tenant value. To change them, pass
`--location <region>` (home region: tfstate and the shared layer) and `--env-location
<env>=<region>` (or `all=<region>`) to `up.sh` in step 4. It rewrites every tfvars and backend
file and fails early, listing the allowed regions, when the subscription's policy forbids a
choice.

If you skipped step 1 (the old account is gone), `up.sh` notices: when `bootstrap.tfvars` holds a
non-placeholder `subscription_id` that differs from `--subscription`, it warns and offers to do the
same reset first (`--yes` resets without asking; with no terminal and no `--yes` it stops).

Also check `alert_emails` in `bootstrap.tfvars` and `global.tfvars`. `up.sh` only asks for it while
it still contains `example.com`.

If you committed the uncommented `backend "azurerm" {}` block in
`stacks/bootstrap/versions.tf`, leave it: `up.sh` writes a local-backend override for the first
apply on the new subscription.

## 3. Undo the quota workarounds (account with more vCPUs)

The current settings fit **Azure for Students** ([ADR 0002 §8](../adr/0002-aks-everywhere-and-azure-dns.md)):
6 vCPUs per region and only five allowed regions. Of those regions, only northcentralus and
denmarkeast offer an x86 4 vCPU B-series size, and canadacentral offers ARM only. So each env sits
in its own region on one pinned node, with upgrades and KEDA off. These are config, not code. On a
subscription with normal quota, check it first, then set the standard sizing:

```sh
az vm list-usage -l <region> -o table        # "Total Regional vCPUs" and "Standard BASv2 Family vCPUs"
az vm list-skus -l <region> --size Standard_B4as_v2 -o table   # must be listed with no restrictions
```

Everything fits in one region once that region has about 16+ vCPUs: three clusters at 1 to 3
nodes, prod's apps pool, and one surge node per upgrade.

| Setting (file)                                                     | Student-quota value (now)                                  | Standard value                                    |
| ------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| Env regions (`up.sh --env-location`)                               | test canadacentral, staging denmarkeast, prod northcentralus | one region for all: `--env-location all=<region>` |
| `system_vm_size` (`envs/<env>/compute.tfvars`)                     | `Standard_B4as_v2`; test `Standard_B4ps_v2` (arm64)        | `Standard_B4as_v2` everywhere (x86)               |
| `system_min_count` / `system_max_count`                            | `1` / `1`                                                  | `1` / `3`                                         |
| prod `system_only_critical_addons`, `apps_pool_enabled`            | `false`, `false`                                           | `true`, `true` (apps `1`–`3` nodes)               |
| prod `global.nodeSelector` (`deploy/helm/bbm/values-prod.yaml`)    | `{}`                                                       | `{ bbm.io/pool: apps }`                           |
| `automatic_upgrade_channel` / `node_os_upgrade_channel`            | `"none"` / `"None"`                                        | `"patch"` / `"NodeImage"`                         |
| `keda_enabled`                                                     | `false`                                                    | `true` once the analysis worker runs              |

Notes:

- The arm64 image builds in `.github/workflows/_build-push.yml` (api and web) can stay. They cost
  some CI time and are harmless on x86 clusters. Remove `linux/arm64` there if no env runs on
  arm64.
- With upgrades back on, the next compute apply re-enables the weekly maintenance windows (Sunday
  06:00–10:00 UTC).
- `up.sh` checks every env's node size, quota and region policy before applying anything, so a
  wrong value fails at its `[4] Node SKUs, vCPU quota` step, before any resource is created.

> **Planned: sizing profiles.** To turn this table into one flag, `up.sh` could take
> `--profile student` or `--profile standard` and write these values itself, so nobody edits
> tfvars by hand when switching accounts. Not built yet; to be added after the current Azure for
> Students bring-up is finished.

## 4. Bring up the new subscription

```sh
az login --use-device-code                    # the new account (add --tenant <id> if needed)
export CLOUDFLARE_API_TOKEN=...               # optional, token for the new parent domain
infra/up.sh --subscription <new-guid> --zone <new-zone> --prod \
  --location <region> --env-location all=<region>     # e.g. eastus2 for everything
```

To keep the same domain, pass the same `--zone`. The new parent zone gets new Azure name servers,
so the NS records must change either way. Expect about an hour. Most of it is Azure creating the
AKS clusters and the two PostgreSQL servers. Every step is idempotent, so after a failure fix the
cause and run the same command again.

## 5. Re-point the NS records

With `CLOUDFLARE_API_TOKEN` set, `up.sh` replaces the NS records itself. Otherwise update the four
NS records for `<zone>` at the parent domain's DNS host to the values `up.sh` printed (see
[azure-bootstrap.md section 8](azure-bootstrap.md#8-delegate-the-zone-by-hand-dns-hosts-other-than-cloudflare)).
Delete any NS records that still point at the old name servers.

The old records may stay cached for up to their TTL. cert-manager retries until the new delegation
resolves.

## 6. Commit and finish

1. Commit the tfvars and backend files `up.sh` rewrote ([azure-bootstrap.md section 9](azure-bootstrap.md#9-commit-what-upsh-rewrote)).
2. Set the real secrets again: `llm-api-key` per env, the Sepolia secrets in the shared vault
   (sections 10 and 12 of the bootstrap runbook).
3. Add required reviewers if `github_reviewer_ids` is empty (section 11).
4. Deploy: wait for a green `integration-azure.yml` run on `main`, then run `deploy.yml` with its
   `sha-<7>` tag (section 13).

## Changing only the domain

Same subscription, new zone: run `up.sh --subscription <guid> --zone <new-zone>`. It warns that the
zones are recreated. Bootstrap replaces the parent and child zones, `data` rewrites the records,
and the platform install issues new wildcard certificates. Then delete the old NS records at the old
domain's DNS host, add the new ones (or let the Cloudflare token do it), and commit
`bootstrap.tfvars` and `global.tfvars`. The app's ingress host comes from `helm_values`, so
redeploy staging and prod (`deploy.yml`) to move them to the new hosts.
