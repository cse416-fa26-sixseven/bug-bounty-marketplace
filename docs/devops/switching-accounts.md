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

`down.sh` asks you to type the subscription name. It destroys `compute` and `data` per env,
`global`, the Cloudflare NS records (with the token), the GitHub repo variables and Environments,
and bootstrap last. Then it purges soft-deleted `kv-bbm-*` vaults. Pass `--keep-github` to leave
the GitHub side alone; the next `up.sh` overwrites it anyway.

If the old account is already gone (for example, an expired student subscription), skip this step.
Remove the GitHub repo variables and Environments by hand
(`gh variable delete <name> --repo ...`, `gh api -X DELETE repos/<repo>/environments/<env>`) and
delete the old NS records at the DNS host.

## 2. Reset values that belong to the old account

`down.sh` leaves the tfvars as they are. `up.sh` overwrites `subscription_id`, `suffix`,
`dns_zone_name`, the state account in the backend files and the bootstrap hint block. It only
**adds** to the object-ID lists, so clear the old IDs when the tenant changes, or bootstrap will
try to grant roles to users that don't exist there:

| File                           | Set to `[]` (or the new tenant's IDs)           |
| ------------------------------ | ----------------------------------------------- |
| `envs/global/bootstrap.tfvars` | `admin_object_ids`, `power_operator_object_ids` |
| `envs/global/global.tfvars`    | `secret_officer_user_object_ids`                |
| `envs/<env>/data.tfvars`       | `secret_officer_user_object_ids`                |

Also check `alert_emails` in `bootstrap.tfvars` and `global.tfvars`. `up.sh` only asks for it while
it still contains `example.com`.

If you committed the uncommented `backend "azurerm" {}` block in
`stacks/bootstrap/versions.tf`, leave it: `up.sh` writes a local-backend override for the first
apply on the new subscription.

## 3. Bring up the new subscription

```sh
az login --use-device-code                    # the new account (add --tenant <id> if needed)
export CLOUDFLARE_API_TOKEN=...               # optional, token for the new parent domain
infra/up.sh --subscription <new-guid> --zone <new-zone>      # add --prod for prod
```

To keep the same domain, pass the same `--zone`. The new parent zone gets new Azure name servers,
so the NS records must change either way.

## 4. Re-point the NS records

With `CLOUDFLARE_API_TOKEN` set, `up.sh` replaces the NS records itself. Otherwise update the four
NS records for `<zone>` at the parent domain's DNS host to the values `up.sh` printed (see
[azure-bootstrap.md section 8](azure-bootstrap.md#8-delegate-the-zone-by-hand-dns-hosts-other-than-cloudflare)).
Delete any NS records that still point at the old name servers.

The old records may stay cached for up to their TTL. cert-manager retries until the new delegation
resolves.

## 5. Commit and finish

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
