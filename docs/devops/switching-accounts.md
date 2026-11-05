# Switching accounts or domains

How to move the deployment to another Azure subscription, another tenant, or another DNS zone. The
scripts make this a teardown on the old side and a fresh bring-up on the new side. Background:
[ADR 0002](../adr/0002-aks-everywhere-and-azure-dns.md) section 6.

Nothing in the repo hardcodes a subscription or a domain. The subscription ID is not committed:
`up.sh` / `down.sh` take it from `--subscription`, and `scripts/tf.sh` from `TF_VAR_subscription_id`
/ `ARM_SUBSCRIPTION_ID` (ADR 0003). The domain is only `dns_zone_name` in
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
| `envs/global/bootstrap.tfvars` | `admin_object_ids`, `power_operator_object_ids`, `preregistered_resource_providers`                                |
| `envs/global/global.tfvars`    | hint block `suffix`, `ephemeral_ci_principal_id`, `preview_ci_principal_id`, `secret_officer_sp_object_ids`; `secret_officer_user_object_ids` |
| `envs/<env>/*.tfvars`          | `suffix`, and `secret_officer_user_object_ids` in `data.tfvars`                                                    |
| `envs/**/backend*.hcl`         | `resource_group_name`, `storage_account_name` (`stbbmtfstate0000`)                                                                    |

Kept, because they survive an account switch: `dns_zone_name`, `alert_emails`,
`github_reviewer_ids`, `github_repo`, and the regions: the home region (`location` /
`location_abbr` in `envs/global/*.tfvars`) and each env's region (`envs/<env>/*.tfvars`, mirrored
in `env_locations`). Regions are a user choice, not a per-tenant value. To change them, pass
`--location <region>` (home region: tfstate and the shared layer) and `--env-location
<env>=<region>` (or `all=<region>`) to `up.sh` in step 4. It rewrites every tfvars and backend
file and fails early, listing the allowed regions, when the subscription's policy forbids a
choice.

If you skipped step 1 (the old account is gone), `up.sh` notices: when the subscription it last
used (gitignored `envs/global/.last-subscription`, or `subscription_id` in an older
`bootstrap.tfvars`) differs from `--subscription`, it warns and offers to do the
same reset first (`--yes` resets without asking; with no terminal and no `--yes` it stops).

Also check `alert_emails` in `bootstrap.tfvars` and `global.tfvars`. `up.sh` only asks for it while
it still contains `example.com`.

If you committed the uncommented `backend "azurerm" {}` block in
`stacks/bootstrap/versions.tf`, leave it: `up.sh` writes a local-backend override for the first
apply on the new subscription.

## 3. Check quota and the remaining sizing switches

The old subscription's quota workarounds (one region per env, one pinned B-series node, an arm64 test
cluster, upgrades off; [ADR 0002 §8](../adr/0002-aks-everywhere-and-azure-dns.md)) are gone: the
committed defaults now put every env in one region on autoscaled `Standard_D4as_v7` nodes with
automatic upgrades on ([ADR 0003 §4](../adr/0003-shared-subscription-isolation.md)). Check that the
new subscription offers the size and has the quota (28 vCPUs at max scale, see
[azure-bootstrap.md](azure-bootstrap.md) section 4):

```sh
az vm list-usage -l <region> -o table        # "Total Regional vCPUs" and the Dasv7 family row
az vm list-skus -l <region> --size Standard_D4as_v7 -o table   # must be listed with no restrictions
```

If it does not, pick another size in `system_vm_size` (`envs/<env>/compute.tfvars`) or lower
`system_max_count`. A few switches are still off for cost and can be turned on with more load:

| Setting (file)                                                     | Value (now)      | With more load                       |
| ------------------------------------------------------------------ | ---------------- | ------------------------------------ |
| prod `system_only_critical_addons`, `apps_pool_enabled`            | `false`, `false` | `true`, `true` (apps `1`–`3` nodes)  |
| prod `global.nodeSelector` (`deploy/helm/bbm/values-prod.yaml`)    | `{}`             | `{ bbm.io/pool: apps }`              |
| `keda_enabled`                                                     | `false`          | `true` once the analysis worker runs |

Notes:

- The arm64 image builds in `.github/workflows/_build-push.yml` (api and web) still run, although
  no env runs arm64 any more. They cost some CI time and are harmless on x86 clusters; removing
  `linux/arm64` there is a separate change.
- `up.sh` checks every env's node size, quota and region policy before applying anything, so a
  wrong value fails at its `[4] Node SKUs, vCPU quota` step, before any resource is created.

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

## Side by side: new account first, old one after

To keep an environment running during the move, bring the new account up before tearing the old
one down. Names that must be globally unique differ (random suffix, region in the PostgreSQL
name) and the two tenants have separate `gh-bbm-*` apps. This assumes the old and new
subscriptions are in different tenants: in the same tenant the custom role names (`BBM Power
Operator`, `BBM tfstate reader` / `writer`) would clash, so tear the old one down first instead.
Three things are shared:

1. **Keep the old values.** `up.sh` overwrites the old account's suffix, object IDs and state
   account in `envs/**`, and `down.sh` needs them. Before bringing up the new account, keep a
   checkout of the current commit: `git worktree add ../bbm-old HEAD`.
2. **Bring up the new account** from the main checkout (sections 2 to 6, with
   `CLOUDFLARE_API_TOKEN` set). `up.sh` replaces the NS records, so DNS moves to the new account
   here, and it points the GitHub variables and Environments at the new account.
3. **Tear down the old account** from `../bbm-old`, after the new one is verified:

   ```sh
   unset CLOUDFLARE_API_TOKEN     # it would delete the NEW Azure NS records for the zone
   az account set -s <old-guid>
   infra/down.sh --subscription <old-guid> --all --keep-github --dry-run   # review
   infra/down.sh --subscription <old-guid> --all --keep-github
   git worktree remove ../bbm-old
   ```

   `--keep-github` matters: without it `down.sh` deletes the variables and Environments the new
   account just set.

## Changing only the domain

Same subscription, new zone: run `up.sh --subscription <guid> --zone <new-zone>`. It warns that the
zones are recreated. Bootstrap replaces the parent and child zones, `data` rewrites the records,
and the platform install issues new wildcard certificates. Then delete the old NS records at the old
domain's DNS host, add the new ones (or let the Cloudflare token do it), and commit
`bootstrap.tfvars` and `global.tfvars`. The app's ingress host comes from `helm_values`, so
redeploy staging and prod (`deploy.yml`) to move them to the new hosts.
