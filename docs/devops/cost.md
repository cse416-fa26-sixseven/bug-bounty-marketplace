# Cost estimates

> **A typical month is ~$85–95, well over the $50 subscription budget alert.** Each cluster now
> runs one `Standard_B4as_v2` node (4 vCPU / 16 GiB, ADR 0002 §8), about 4× the old B2als_v2 per
> hour. With staging and prod down and the test env running ~10 hours on working days for CI, the
> estimate below is about $85–95, so expect the 100% alert every month. The budgets stay as they
> are (they only notify). The levers that matter:
>
> - **Shorter auto-pause window for test.** The nightly 06:00 UTC auto-pause leaves the test
>   cluster running from the first CI run of the day until the next morning, ~$0.16 per hour.
>   Pausing test a few hours after the last run (an extra `env-power.yml` schedule for test only)
>   cuts most of its running share.
> - **`env-power test down` when idle.** With no open PRs for a while, `down` (~$4/month) instead of
>   `paused` (~$26/month). CI fails until `env-power test up`.
> - **Prod off unless demoing.** Prod running all month is ~$250–280; keep it `down` (or at least
>   `paused`) outside demos.

> **Azure for Students: ~$100 of credit in total, not per month.** See
> [What the $100 credit buys](#what-the-100-credit-buys): with the nightly pause and prod down it
> lasts about **4–5 weeks**; with staging also running on weekday afternoons about 3 weeks; with
> prod running all month about 10 days. When the credit runs out, Azure disables the
> subscription's resources until it is upgraded to pay-as-you-go. Check the remaining credit at
> https://www.microsoftazuresponsorships.com/balance.

> **Rough estimates only.** Figures are approximate pay-as-you-go list prices in USD (730 hours per
> month), rounded, before taxes, credits or free grants unless stated. Node prices are per region
> (each env has its own, ADR 0002 §8); the other items differ little between `northcentralus`,
> `francecentral` and `canadacentral` and use one approximate figure. Check them
> against the [Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/) and the
> subscription's Cost Management view before relying on them. Prices change.

The design goal is a low floor: nothing runs by default, and every AKS environment (test, staging,
prod) can be paused or torn down without losing data. See [architecture.md](architecture.md) for the layers and
[env-lifecycle.md](env-lifecycle.md) for the power actions.

## Unit prices used

<!-- B4as_v2 prices: Azure Retail Prices API (prices.azure.com, armSkuName Standard_B4as_v2,
     "Virtual Machines Basv2 Series", Consumption), October 2026. -->

| Item                                    | Approx. price                                                                         | Where it's used                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| VM `Standard_B4as_v2` (4 vCPU, 16 GiB), Linux | test `northcentralus` $0.150/h (~$110/month); staging `francecentral` $0.170/h (~$124/month); prod `canadacentral` $0.167/h (~$122/month) | the one node of every AKS cluster |
| VM `Standard_B2als_v2` (2 vCPU, 4 GiB)  | ~$0.038/h, ~$27/month                                                                 | optional `apps` pool (off)                                  |
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

Per environment, per month if left in that state the whole month. Every cluster runs everything on
one `Standard_B4as_v2` system node in its own region (min = max = 1: test `northcentralus`, staging
`francecentral`, prod `canadacentral`). Test has no Postgres server (each namespace runs its own
Postgres pod). Staging and prod have Postgres B1ms; prod adds Container Insights and the AKS
Standard tier. No `apps` pool anywhere.

| State       | What is billed                                                                                                      | Test (ncus)                       | Staging (frc)          | Prod (cac)                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------- | ---------------------------------- |
| **running** | node + OS disk, LB, 2 public IPs, PG compute + storage (not test), Log Analytics, KV, storage, prod control plane | ~$145–150 (~$4.90/day, ~$0.20/h) | ~$175–185 (~$6/day)   | ~$250–280 (~$8.50–9/day)           |
| **paused**  | LB, 2 public IPs, PG storage, KV, storage, idle Log Analytics. Node and PG compute stop                              | ~$25–28 (~$0.85/day)             | ~$28–32 (~$1/day)     | ~$28–32 (~$1/day), see the Standard-tier note |
| **down**    | ingress public IP, PG storage, KV, storage. Compute stack (cluster, node, LB, outbound IP) destroyed                | ~$4 (~$0.13/day)                 | ~$7–9 (~$0.25/day)    | ~$7–9 (~$0.25/day)                 |

Going from paused to running adds, per running hour: test ~$0.16 (node $0.150 + OS disk), staging
~$0.20 (node $0.170 + disk + PG compute $0.017), prod ~$0.30 (node $0.167 + disk + PG + Standard
tier $0.10, plus Container Insights ingestion).

Every cluster also runs at least 2 Envoy replicas for Gateway `bbm` (the app routing add-on's
floor; HPA up to 3 on test/staging, 5 on prod). They are small pods on the existing nodes, so they
add no node cost: the node pool is pinned to one node (no autoscaling while the student quota is
6 vCPUs per region).

How the running figures break down (staging): node ~$124, OS disk ~$10, LB ~$18, two public IPs
~$7, PG B1ms ~$12.50, PG storage ~$3.70, logs and the rest ~$0–5. Test is the same without
Postgres and with the cheaper `northcentralus` node (~$110). Prod adds Container Insights and the
Standard-tier control plane (~$73 if it runs all month). Its workspace is capped at 0.5 GB/day, so
ingestion is at most ~15 GB/month (~$35) and usually far less.

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
| One CI run or preview on a running node | nothing extra while it fits on the node                                                   |
| Several open previews at once           | nothing extra: the pool is pinned to one node, so too many at once stay Pending           |
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
| `budget-rg-bbm-<env>-<layer>-<abbr>` | $20/month each | `rg-bbm-test-{data,compute}-ncus`, `rg-bbm-staging-{data,compute}-frc`, `rg-bbm-prod-{data,compute}-cac` (`stacks/global`) | same thresholds |

Alerts go to `alert_emails` in `envs/global/*.tfvars`. Budgets only notify; they never stop
anything.

**Gap:** AKS bills nodes, OS disks, the load balancer and the outbound IP in the **node** resource
group `rg-bbm-<env>-aksnodes-<abbr>`, which has no per-RG budget. The `compute` RG holds only the
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
| **One node per cluster, no `apps` pool** | one B4as_v2 per env (4 of the 6 vCPUs of its region)                                                 | `system_min_count = system_max_count = 1`, `apps_pool_enabled = false` |
| **KEDA add-on off**                    | ~0.4 CPU of requests freed on the one node while analysis is disabled                                   | `keda_enabled = false` in `envs/<env>/compute.tfvars`         |
| **Sandbox pool off**                   | no Dsv5 node until PoC execution is needed (DSv5 quota is 0 on Azure for Students)                      | `sandbox_pool_enabled = false`                                |
| **Burstable SKUs**                     | B-series nodes and PG B1ms are the cheapest that run the stack                                          | `*_vm_size`, `postgres_sku_name`                              |
| **Namespaces always deleted**          | `integration-azure.yml` deletes its namespace with `always()`, `preview.yml` on PR close                | workflows                                                     |
| **Janitor** (every 6 h, weekly purge)  | deletes expired ephemeral namespaces; purges old ACR tags (keeps the 10 newest, protects deployed tags) | `infra-janitor.yml`                                           |
| **Free AKS tier** for test and staging | no control-plane charge (no uptime SLA). Only prod pays for Standard                                    | `aks_sku_tier` in `envs/<env>/compute.tfvars`                 |
| **Wildcard certificates**              | one certificate per env, no per-preview issuance                                                        | `deploy/helm/bbm-platform`                                    |

## Typical month

Staging and prod down, a handful of PRs and the nightly test runs: about **$85–95** (global layer
~$9–14, staging and prod data layers ~$15, the test env paused ~$26 plus ~220 running hours at
~$0.16 ≈ $36). That is already well over the $50 subscription alert.

Add staging running 8 hours a day on weekdays, paused the rest of the time: about **$125–135**
(~176 running hours at ~$0.20 ≈ $35, and paused instead of down ≈ +$22). Prod running around the
clock alone (~$250–280) is five times the budget, so keep prod paused or down except for demos. To
cut the test env's share, run `env-power test pause` after a CI-heavy day, or `down` it when no PRs
are open for a while (CI then fails until `env-power test up`).

## What the $100 credit buys

Azure for Students grants ~$100 once. With the nightly auto-pause on and prod `down`:

| Scenario (per month)                                                                  | Approx. cost | $100 lasts    |
| ------------------------------------------------------------------------------------- | ------------ | ------------- |
| test only, running ~10 h on working days (paused otherwise); staging and prod `down`  | ~$85–95      | ~4.5–5 weeks  |
| same, but test runs until the 06:00 UTC pause (~18 h on working days, ~400 h)         | ~$115–120    | ~3.5–4 weeks  |
| test as in row 1 + staging running 8 h on weekdays (paused otherwise)                 | ~$125–135    | ~3–3.5 weeks  |
| everything `down` (no CI), global + data layers only                                  | ~$27–36      | ~3 months     |
| prod running all month (plus the row 1 baseline)                                      | ~$335–370    | ~8–9 days     |

Each running cluster-hour costs ~$0.16 (test), ~$0.20 (staging) or ~$0.30 (prod) on top of its
paused cost, so the credit is about 500–600 test cluster-hours if nothing else ran. Plan demos
around `env-power <env> up` / `down` and keep test `down` during breaks.
