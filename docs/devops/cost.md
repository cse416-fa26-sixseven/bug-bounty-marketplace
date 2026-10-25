# Cost estimates

> **A typical month is ~$60–70, over the $50 subscription budget alert.** With staging and prod
> down and the test env running on working days for CI, the estimate below is about $60–70, so
> expect the 100% alert most months. The budgets stay as they are (they only notify). To get under
> $50:
>
> - **Shorter auto-pause window for test.** The nightly 06:00 UTC auto-pause leaves the test
>   cluster running from the first CI run of the day until the next morning. Pausing test a few
>   hours after the last run (an extra `env-power.yml` schedule for test only) cuts most of its
>   ~$35–40 running share.
> - **`env-power test down` when idle.** With no open PRs for a while, `down` (~$4/month) instead of
>   `paused` (~$25–28/month). CI fails until `env-power test up`.
> - **Prod off unless demoing.** Prod running all month is ~$200; keep it `down` (or at least
>   `paused`) outside demos.

> **Azure for Students: ~$100 of credit in total, not per month.** At ~$60–70/month the credit
> lasts about 6–8 weeks; with prod running all month it is gone in under 3 weeks. When the credit
> runs out, Azure disables the subscription's resources until it is upgraded to pay-as-you-go.
> Check the remaining credit at https://www.microsoftazuresponsorships.com/balance. The levers
> above matter more here than the $50 alert: keep prod `down` outside demos and pause test when
> CI is idle.

> **Rough estimates only.** Figures are approximate `eastus2` pay-as-you-go list prices in USD
> (730 hours per month), rounded, before taxes, credits or free grants unless stated. Check them
> against the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) and the
> subscription's Cost Management view before relying on them. Prices change.

The design goal is a low floor: nothing runs by default, and every AKS environment (test, staging,
prod) can be paused or torn down without losing data. See [architecture.md](architecture.md) for the layers and
[env-lifecycle.md](env-lifecycle.md) for the power actions.

## Unit prices used

| Item                                    | Approx. price                                                                         | Where it's used                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| VM `Standard_B2als_v2` (2 vCPU, 4 GiB)  | ~$0.038/h, ~$27/month                                                                 | every AKS node                                              |
| Managed OS disk, 64 GB Premium SSD (P6) | ~$10/month per node                                                                   | AKS node OS disks (exist only while nodes exist)            |
| Standard Load Balancer                  | ~$0.025/h for the first 5 rules, ~$18/month                                           | AKS: Gateway `bbm` (rules for 80, 443 and 15021) + outbound |
| Standard static public IP               | ~$0.005/h, ~$3.65/month each                                                          | `pip-bbm-<env>-ingress` (data RG), AKS outbound IP          |
| PG Flexible `B_Standard_B1ms` compute   | ~$0.017/h, ~$12.50/month                                                              | staging and prod databases                                  |
| PG Flexible storage                     | ~$0.115/GB-month, 32 GB ≈ $3.70/month                                                 | billed even when the server is stopped                      |
| PG backup storage                       | free up to 100% of provisioned storage                                                | 7-day retention, no geo-redundancy                          |
| ACR Basic                               | ~$0.167/day, ~$5/month (10 GB included)                                               | shared registry                                             |
| Log Analytics ingestion                 | ~$2.30–2.80/GB (first 5 GB/month free per billing account), 30-day retention included | shared and per-env workspaces                               |
| Key Vault (Standard)                    | ~$0.03 per 10,000 operations                                                          | shared and per-env vaults                                   |
| Storage (LRS, hot) + queue operations   | cents per month at this scale                                                         | tfstate, `sources`, `analysis-jobs`                         |
| AKS control plane, Free tier            | $0                                                                                    | test and staging clusters                                   |
| AKS control plane, Standard tier        | ~$0.10 per cluster-hour, ~$73/month if it runs all month (verify current pricing)     | prod cluster (`aks_sku_tier = "Standard"`)                  |
| Azure DNS public zone                   | ~$0.50/zone/month (first 25 zones) + ~$0.40 per million queries                       | `<zone>` and four child zones                               |
| Azure Private DNS zone                  | ~$0.25/zone/month + VNet link and query charges (cents)                               | `<env>.internal.<zone>`, plus the PG private zones          |
| Let's Encrypt certificates              | $0                                                                                    | one wildcard per env via cert-manager                       |

## Always-on baseline

Paid every month whether or not any environment is up.

| Item                                                       | Approx. per month                                 |
| ---------------------------------------------------------- | ------------------------------------------------- |
| ACR Basic                                                  | $5                                                |
| Shared Log Analytics (cap 0.25 GB/day)                     | $0–5 typical. At the cap every day: ~7.5 GB ≈ $17 |
| tfstate storage, shared Key Vault                          | < $1                                              |
| Public DNS zones (parent + 4 child zones)                  | ~$2.50                                            |
| Private DNS zones (3 `<env>.internal.<zone>` + 2 PG zones) | ~$1.25                                            |
| Budgets, Entra app registrations, RBAC                     | $0                                                |
| **Global layer total**                                     | **~$9–14**                                        |

The child DNS zones sit in the env data RGs but are created by bootstrap, so they exist even when
an env is torn down. Each env's **data** layer also never goes away. Its cost depends on the power
state and is included in the next table.

## Environments by power state

Per environment, per month if left in that state the whole month. Test runs everything on one
system pool (1–3 nodes, no Postgres server: each namespace runs its own Postgres pod). Staging runs
everything on one system node (no `apps` pool, Container Insights off). Prod runs at least one
system node and one `apps` node, with Container Insights on, on the AKS Standard tier.

| State       | What is billed                                                                                                      | Test                             | Staging              | Prod                                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------- | ---------------------------------------------------------------- |
| **running** | nodes + OS disks, LB, 2 public IPs, PG compute + storage (not test), Log Analytics, KV, storage, prod control plane | ~$60–70 (~$2.10/day) with 1 node | ~$75–85 (~$2.60/day) | ~$195–225 (~$6.50–7.50/day), more when the autoscaler adds nodes |
| **paused**  | LB, 2 public IPs, PG storage, KV, storage, idle Log Analytics. Nodes and PG compute stop                            | ~$25–28 (~$0.85/day)             | ~$25–30 (~$0.90/day) | ~$25–30 (~$0.90/day), see the Standard-tier note                 |
| **down**    | ingress public IP, PG storage, KV, storage. Compute stack (cluster, nodes, LB, outbound IP) destroyed               | ~$4 (~$0.13/day)                 | ~$7–9 (~$0.25/day)   | ~$7–9 (~$0.25/day)                                               |

Every cluster also runs at least 2 Envoy replicas for Gateway `bbm` (the app routing add-on's
floor; HPA up to 3 on test/staging, 5 on prod). They are small pods on the existing nodes, so they
add no node cost unless the autoscaler needs another node.

How the running figures break down (staging): node ~$27, OS disk ~$10, LB ~$18, two public IPs
~$7, PG B1ms ~$12.50, PG storage ~$3.70, logs and the rest ~$0–5. Test is the same without
Postgres; each extra node while several CI runs or previews are open adds ~$37/month pro rata.
Prod adds a second node and disk (~$37), Container Insights and the Standard-tier control plane
(~$73 if it runs all month). Its workspace is capped at 0.5 GB/day, so ingestion is at most
~15 GB/month (~$35) and usually far less.

Notes:

- **A paused cluster still bills the load balancer and the public IPs.** AKS stop deallocates the
  nodes but keeps the Standard LB and its frontend IPs. Only `down` removes them. The ingress IP
  lives in the data RG on purpose, so it survives `down` and keeps the DNS name.
- **Postgres auto-starts after 7 days stopped.** The 06:30 UTC re-pause job stops it again, but up
  to a day of PG compute (~$0.40) can be billed each time.
- The running cost scales with **hours**, not days. A staging cluster up 8 hours a day on weekdays
  and paused otherwise is about $15–20 of running time plus ~$20 of paused time per month.
- **Prod's Standard tier bills per cluster-hour while the cluster runs** (ADR 0002). Check in Cost
  Management whether a stopped Standard-tier cluster still bills the control plane; if it does, add
  ~$2.40/day to prod's paused figure. `down` removes it either way.
- **The test cluster runs whenever CI does.** The first Azure CI run after the nightly pause
  resumes it, and it then runs until the next 06:00 UTC pause. With a push to `main` most days,
  plan on the test env being `running` for most working hours.
- The paused figure here (~$0.90/day) is higher than the quick table in
  [env-lifecycle.md](env-lifecycle.md), mainly because it counts the Standard LB at its full
  hourly rate. Treat the LB line as the one to verify in Cost Management.

## CI runs and PR previews

These are namespaces on the test cluster, so they add no Azure resources of their own. Their cost
is the test cluster's running time (above), plus extra nodes when the autoscaler needs them.

| Case                                    | Approx. cost                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| One CI run or preview on a running node | nothing extra while it fits on the existing node(s)                                       |
| Several open previews at once           | the system pool scales up to 3 nodes: each extra node ~$0.05/h (~$1.20/day) with its disk |
| First run after the nightly pause       | resumes the test cluster, which then bills as `running` until the next pause              |
| Image builds pushed to ACR              | storage within the 10 GB included; the weekly janitor purges old `pr-*` / `sha-*` tags (incl. `bbm-preview/*`) |
| TLS                                     | one wildcard certificate per env zone, so previews never request their own                |

A preview lives at most 168 hours after its last push. The janitor deletes any ephemeral namespace
past its `bbm.io/expires-on` annotation every 6 hours (while the cluster runs), so a forgotten
preview only holds pod resources on the test cluster.

## Budget alerts

| Budget                             | Amount         | Scope                                                              | Notifications                        |
| ---------------------------------- | -------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `budget-bbm-subscription`          | $50/month      | the whole subscription (`stacks/bootstrap`)                        | 50%, 80%, 100% actual; 100% forecast |
| `budget-rg-bbm-<env>-<layer>-eus2` | $20/month each | `rg-bbm-{test,staging,prod}-{data,compute}-eus2` (`stacks/global`) | same thresholds                      |

Alerts go to `alert_emails` in `envs/global/*.tfvars`. Budgets only notify; they never stop
anything.

**Gap:** AKS bills nodes, OS disks, the load balancer and the outbound IP in the **node** resource
group `rg-bbm-<env>-aksnodes-eus2`, which has no per-RG budget. The `compute` RG holds only the
cluster object, so its $20 budget sees little (prod's Standard-tier fee is billed on the cluster,
so the prod compute budget does see that). Running cost is caught mainly by the subscription
budget today. A filtered subscription budget (by `env` tag or by node RG) would close this.

## Cost levers

| Lever                                  | Effect                                                                                                  | Where                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Nightly auto-pause** (06:00 UTC)     | turns a forgotten running env (~$2.60–5/day) into a paused one (~$0.90/day)                             | `env-power.yml` schedule; opt out with `auto-pause=false`     |
| **`down` for long breaks**             | paused → down saves ~$20/month per env and avoids the 12-month stopped-cluster limit                    | `env-power.yml action=down confirm=<env>`                     |
| **Daily PG re-pause** (06:30 UTC)      | undoes Azure's 7-day auto-start of a stopped server                                                     | `env-power.yml` schedule                                      |
| **Log Analytics daily caps**           | worst-case ingestion bounded: shared 0.25 GB/day, each env 0.5 GB/day                                   | `law_daily_quota_gb` in tfvars                                |
| **Container Insights off in staging**  | avoids most per-node log ingestion                                                                      | `container_insights = false` in `envs/staging/compute.tfvars` |
| **No `apps` pool in staging**          | one node instead of two                                                                                 | `apps_pool_enabled = false`                                   |
| **Sandbox pool off**                   | no Dsv5 node (a D2s_v5 is roughly 2.5× a B2als_v2 per hour) until PoC execution is needed               | `sandbox_pool_enabled = false`                                |
| **Burstable SKUs**                     | B-series nodes and PG B1ms are the cheapest that run the stack                                          | `*_vm_size`, `postgres_sku_name`                              |
| **Namespaces always deleted**          | `integration-azure.yml` deletes its namespace with `always()`, `preview.yml` on PR close                | workflows                                                     |
| **Janitor** (every 6 h, weekly purge)  | deletes expired ephemeral namespaces; purges old ACR tags (keeps the 10 newest, protects deployed tags) | `infra-janitor.yml`                                           |
| **Free AKS tier** for test and staging | no control-plane charge (no uptime SLA). Only prod pays for Standard                                    | `aks_sku_tier` in `envs/<env>/compute.tfvars`                 |
| **Wildcard certificates**              | one certificate per env, no per-preview issuance                                                        | `deploy/helm/bbm-platform`                                    |

## Typical month

Staging and prod down, a handful of PRs and the nightly test runs: about **$60–70** (global layer
~$9–14, staging and prod data layers ~$15, the test env running ~10 hours on working days and
paused otherwise ~$35–40). That is already over the $50 subscription alert.

Add staging running 8 hours a day on weekdays, paused the rest of the time: about **$90–105**. Prod running around the clock alone (~$200) is four times the budget,
so keep prod paused or down except for demos. To cut the test env's share, run `env-power test
pause` after a CI-heavy day, or `down` it when no PRs are open for a while (CI then fails until
`env-power test up`).
