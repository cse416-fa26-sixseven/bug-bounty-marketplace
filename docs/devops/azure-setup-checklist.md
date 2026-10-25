# Azure setup checklist (handoff, 2026-10-20)

Local working notes for the first Azure bring-up. The authoritative runbook is
[azure-bootstrap.md](azure-bootstrap.md); this file is the short ordered list plus the things
decided or deferred along the way. Not committed.

## Where things stand

- All M3 DevOps work is merged into `feat/m3-devops`. The final PR #25 (`feat/m3-devops` → `main`)
  is open and **left unmerged** for team review.
- Nothing exists in Azure yet. Every Azure workflow is gated on repo variables and skips cleanly, and
  `CI OK` never depends on Azure.
- Everything below runs against `feat/m3-devops` (or `main` once #25 merges). Several workflows only
  run from `main`, including `integration-azure`, the scheduled jobs and the env identities. Merge #25
  before expecting them to fire.

## Before you start (about 10 min)

- [ ] Tools: `az` CLI, Terraform **1.9.8**, `gh` CLI logged in as a **repo admin** (it creates
      Environments and variables).
- [ ] `! az login` then `az account set -s <SUBSCRIPTION_ID>`.
- [ ] Note your IDs: subscription, tenant, and your user object ID
      (`az ad signed-in-user show --query id -o tsv`).
- [ ] Find the numeric GitHub user IDs of the people who will approve prod
      (`gh api users/<login> --jq .id`).

## Day-one order

1. **Resource providers** (runbook §3). List the ones already registered. They go into
   `preregistered_resource_providers` so bootstrap imports them instead of failing.
2. **Quota and SKUs** (§4). This is the most likely blocker on a new subscription.
   - [ ] `az vm list-usage -l eastus2 -o table`. You need about 2 vCPU of BASv2 for staging, and
         about 6 for staging and prod running at once.
   - [ ] `az postgres flexible-server list-skus -l eastus2`. Confirm `B_Standard_B1ms` is offered.
   - [ ] `az aks get-versions -l eastus2 -o table`. Put the current GA minor into
         `infra/terraform/envs/{staging,prod}/compute.tfvars` (`kubernetes_version`, currently a
         `"1.34"` placeholder).
   - If eastus2 is restricted, fall back to `centralus` (§4, "Fallback region").
3. **Fill `infra/terraform/envs/global/bootstrap.tfvars`** (§5): subscription, `admin_object_ids`
   (you), `alert_emails`, `budget_start_date` (`2026-10-01T00:00:00Z`), `github_reviewer_ids`, and
   `preregistered_resource_providers`.
4. **Apply bootstrap on local state** (§6), then **migrate the state** into the new storage account
   (§7). Uncomment the backend block, set `storage_account_name` in `envs/global/backend.hcl`, then
   run `./scripts/tf.sh bootstrap global init -migrate-state`.
5. **GitHub setup** (§8–9):
   `terraform output -raw gh_setup_commands > gh-setup.sh`, read it, then `bash gh-setup.sh`. Check
   reviewers on `prod`, `infra-global` and `contracts-sepolia`.
6. **Replace the `"0000"` suffix placeholders** with the bootstrap `suffix` output in
   `envs/global/global.tfvars` and `envs/{staging,prod}/data.tfvars`. Paste `global_tfvars_hint` into
   `global.tfvars`, and add yourself to `secret_officer_user_object_ids`.
7. **Apply global locally as Owner** (§10): `./scripts/tf.sh global global apply`. Run it locally
   because CI can't grant User principals.
8. **Mirror images into ACR** (§11): `mirror/postgres:16-alpine` (the ACA test and preview envs need
   it) and `mirror/curl:8.10.1` (`helm test`).
9. **Shared Key Vault secrets** (§12): `sepolia-rpc-url`, `sepolia-deployer-key`. Optional until you
   deploy contracts.
10. **First pipeline test env:** Actions, then `integration-azure` → _Run workflow_ on `main`. It
    should build, provision ACA, run the tests and destroy everything. Check the resource group
    `rg-bbm-test-eus2` is empty afterwards.
11. **Staging:**
    - [ ] Actions → `terraform` → dispatch `staging-data` / `apply`. The first data apply with your
          user in `secret_officer_user_object_ids` may need to run locally instead
          (`./scripts/tf.sh data staging apply`).
    - [ ] Set `llm-api-key` in the staging vault (§13), even as `placeholder-set-me`. Without it pods
          hang in ContainerCreating and the Helm deploy rolls back.
    - [ ] Actions → `env-power` → `staging` / `up`. This applies compute, then deploys the last tag.
          The first time there is no last tag, so run `deploy` with `image_tag=sha-<7>` from a green
          `integration-azure` run.
    - [ ] `env-power` → `status`, open `http://bbm-staging.eastus2.cloudapp.azure.com`, then
          `env-power` → `pause`.
12. **Prod:** same as staging with `prod-*`. Every step except `pause` needs a reviewer.

## Daily use (once set up)

| Want                      | Do                                                                       |
| ------------------------- | ------------------------------------------------------------------------ |
| Demo or test on prod      | `env-power` prod `resume` (5–15 min), then `status`, then share the URL  |
| Done for the day          | `env-power` prod `pause` (or let the nightly 06:00 UTC auto-pause do it) |
| Away for a week or more   | `env-power` `down` (type the env name to confirm). Data and IP survive.  |
| Back                      | `env-power` `up` (about 10–15 min plus the deploy)                       |
| Keep it running overnight | `az group update -n rg-bbm-<env>-data-eus2 --set tags.auto-pause=false`  |

Full details are in [env-lifecycle.md](env-lifecycle.md). Cost estimates are in [cost.md](cost.md).

## Decisions made while I was away (worth a look)

- **Manual prod `pause` needs no reviewer.** It runs in `prod-power`, which holds only the BBM Power
  Operator role. Resume, down, up and deploy all need approval.
- **No extra ACR role for CI.** The permission classifier blocked a new "BBM ACR Operator" role, so:
  - the Postgres and curl mirrors are seeded by hand (step 8);
  - the weekly image purge runs as `gh-bbm-global` in `infra-global` and **waits for a reviewer**
    each Sunday;
  - if you'd rather automate both, that role needs your explicit OK.
- **ACR in ABAC repository-permissions mode; previews get their own identity.** `gh-bbm-preview`
  (Environment `preview`) may push only `bbm-preview/*`, and `test` (`gh-bbm-ephemeral`, which
  pushes the `bbm/*:sha-*` images staging/prod deploy) is main-only. In ABAC mode AcrPull/AcrPush
  and Owner/Contributor/Reader grant no image access, so bootstrap/global use the built-in
  Container Registry Repository Reader/Writer/Contributor/Catalog Lister roles instead (kubelets,
  CI identities, `gh-bbm-global` for the purge, and your admin user for `up.sh`'s mirror check).
- **PR plans for staging stacks are unrefreshed** (`-refresh=false`). The read-only plan identity
  can't read Key Vault secrets or AKS credentials. Refreshed plans run via `terraform` dispatch in
  `staging` or `prod`.
- **A teammate (LoistCloist) merged #18 and #19 before their review fixes.** The fixes went in as
  #21 and #22, and the current branch is correct. Check a PR's state before pushing to its branch.

## Known gaps (not blockers for tomorrow)

- API is pinned to 1 replica until uploads move from local disk to Blob storage.
- The analysis queue is not wired, and `/analyze` returns 501.
- Ingress is plain HTTP (no TLS yet).
- Nothing deploys to staging automatically after `integration-azure` passes; it's manual.
- `uml/component-deployment-diagram.png` is stale. Re-render it from the `.mmd` on an x86 machine
  (`npx @mermaid-js/mermaid-cli -p uml/puppeteer-config.json`).
- `.github/rulesets/main.json` is still not applied to the live ruleset (see `TODO.md`).

## If something fails

- **Subscription problems:** "already registered", "location is restricted", KV soft-delete name
  clash, and AADSTS7002xx OIDC subject errors are all in the troubleshooting table at the end of
  [azure-bootstrap.md](azure-bootstrap.md).
- **Pause refused:** usually the AKS maintenance window (Sunday 06:00–10:00 UTC), or the cluster
  isn't in `Succeeded`. Wait and retry.
- **ACA env left behind after a failed run:** the janitor sweeps it within 6 h. To delete it now,
  run `infra/terraform/scripts/janitor.sh --apply`.
