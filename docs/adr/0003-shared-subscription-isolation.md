# ADR 0003: Shared subscription, isolated by resource group, one region

- **Status:** Accepted
- **Date:** 2026-11-04
- **Scope:** `infra/terraform/stacks/bootstrap/**`, `infra/up.sh`, `infra/down.sh`,
  `infra/terraform/envs/**`, `docs/devops/**`
- **Amends:** [ADR 0002](0002-aks-everywhere-and-azure-dns.md) §7 (home region rationale) and §8
  (one region per environment). Everything else in 0001 and 0002 still holds.

## Context

- BBM moves from a subscription it had to itself to a **shared subscription** that also hosts
  unrelated workloads. Nobody on the team may get, or need, rights over those workloads, and no
  BBM identity, script or budget may see, change or count them.
- Until now some BBM identities held roles at subscription scope: `gh-bbm-plan` had subscription
  **Reader**, `gh-bbm-global` had subscription **Cost Management Contributor**, the custom role
  `BBM Power Operator` was assignable at the subscription, and the bootstrap budget counted the
  whole subscription's spend.
- ADR 0002 §8 split the envs over three regions only because the old subscription allowed 6 vCPUs
  per region and offered an x86 4 vCPU B-series size in just two of its regions. The new
  subscription has no such per-region limit that forces a split.

## Decision

### 1. Isolation by resource group

- **BBM owns only its resource groups.** Bootstrap creates every one of them (ADR 0001, pinned
  "Ownership conventions"): `rg-bbm-tfstate-<home>`, `rg-bbm-shared-<home>` and per env
  `rg-bbm-<env>-data-<abbr>` / `rg-bbm-<env>-compute-<abbr>`. AKS creates the node RGs
  `rg-bbm-<env>-aksnodes-<abbr>` (names from `modules/naming`). No BBM resource lives outside
  these RGs, apart from the few subscription-level objects in section 3.
- **No CI identity has a role at subscription scope.**
  - `gh-bbm-plan`: **Reader on each BBM RG** (tfstate, shared and the six env data/compute RGs)
    instead of subscription Reader. The AKS node RGs don't exist at bootstrap time and are not
    in this list; plans don't need them.
  - `gh-bbm-global`: **Cost Management Contributor on the six env data/compute RGs** (where
    `stacks/global` creates the per-RG budgets) instead of at subscription scope.
  - The other `gh-bbm-*` identities were already RG-scoped (ADR 0001 §4, ADR 0002 §4); they are
    unchanged.
- **`BBM Power Operator`** (custom role for `env-power`) is defined at an RG and its assignable
  scopes are the six env data/compute RGs only, never the subscription.

### 2. Who runs what

- **Bootstrap is run by a subscription Owner**, locally (`infra/up.sh`). It is the only step that
  needs subscription rights: it registers resource providers, creates the BBM RGs, the BBM budget,
  the custom roles and the role assignments of the `gh-bbm-*` identities.
- **Teammates get Owner or Contributor on the BBM RGs only**, assigned by that Owner, not on the
  subscription. Everything after bootstrap (`tf.sh` on `global` / `data` / `compute`, `env-power`,
  Key Vault secrets, `kubectl`) works with RG-scoped roles.

### 3. Subscription-level objects BBM still owns

- **The BBM budget** (`budget-bbm-subscription`) stays a subscription budget resource, but filtered
  by the `ResourceGroupName` dimension to the BBM RGs, including the AKS node RGs. It counts only
  BBM spend. The per-RG budgets of `stacks/global` are unchanged.
- **Custom role definitions** (`BBM Power Operator`, `BBM tfstate reader`) are defined at BBM RGs.
- **Resource provider registrations** are subscription-wide and shared with the other workloads.
  `up.sh` imports the ones already registered; `infra/down.sh --all` removes them from the
  bootstrap state before destroying it, so a teardown never unregisters a provider.
- `down.sh` otherwise destroys only through the BBM stacks' own state, purges only the soft-deleted
  Key Vaults it names (`kv-bbm-<short>-<suffix>`), and deletes only the GitHub variables and
  Environments that bootstrap's `gh_setup_commands` creates.

### 4. One region for every env

- **All three envs (test, staging, prod) run in one region**, `<region>`, chosen at bring-up:

  ```sh
  infra/up.sh --subscription <sub> --location <region> --env-location all=<region> --prod
  ```

  `--location` sets the home region (tfstate, shared RG; ADR 0002 §7, unchanged in role), and
  `--env-location all=` writes the same region into every env's data/compute tfvars and both
  `env_locations` maps (ADR 0002 §8, "Where the region lives"; the mechanism is unchanged).
- Each env keeps its own cluster, RGs, Key Vault and Gateway (the isolation argued for in ADR 0002
  §8 "Why not one shared cluster"); only the region is shared. Prod no longer pulls images across
  regions, and there is one region to watch.
- **Quota:** one region now needs about **12 B-series vCPUs** (three 4 vCPU nodes) plus a surge
  node per upgrade if automatic upgrades are turned back on, and PostgreSQL Flexible
  `Standard_B1ms` for staging and prod. `up.sh` checks it per region as before.
- Node sizes and upgrade channels stay per env in `envs/<env>/compute.tfvars`; this ADR does not
  change them.

## Alternatives considered

- **A dedicated subscription for BBM.** Cleanest isolation, but none is available; RG scoping gives
  the same separation for everything BBM touches.
- **Keep the three-region split.** It only existed for the old quota (ADR 0002 §8) and costs
  cross-region image pulls and three regions to watch.
- **Keep subscription Reader for `gh-bbm-plan`.** Simpler, but it lets every PR plan list the other
  workloads' resources. Plans only read BBM RGs and state, so RG Reader is enough.

## Consequences

- Any new RG must be added in bootstrap together with its `gh-bbm-plan` Reader assignment, the
  budget filter and, for env RGs, the `BBM Power Operator` assignable scopes; otherwise PR plans
  fail on it and its spend is not counted.
- A teammate without subscription rights cannot run bootstrap (`up.sh` warns when you lack Owner);
  changes to `stacks/bootstrap` go through the subscription Owner.
- Moving subscriptions is `down.sh --all` on the old one, then the `up.sh` command above on the new
  one ([azure-bootstrap.md](../devops/azure-bootstrap.md), "Moving to another subscription").
