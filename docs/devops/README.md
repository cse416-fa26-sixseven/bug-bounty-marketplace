# docs/devops/

How the marketplace is built, deployed and run on Azure. The topology and the interfaces that
Terraform, Helm and the workflows share are decided in
[ADR 0001](../adr/0001-azure-environment-topology.md) and
[ADR 0002](../adr/0002-aks-everywhere-and-azure-dns.md) (AKS for every env, Azure DNS, TLS,
one-command bring-up), which supersedes parts of 0001.

## Contents

- [Architecture](architecture.md): diagrams of the global, data, compute, platform and ephemeral
  layers, the OIDC and workload-identity flow, and the request path.
- [Azure bootstrap](azure-bootstrap.md): bringing the whole footprint up with `infra/up.sh`, what
  stays manual (secrets, quota, NS records at non-Cloudflare hosts, committing tfvars, first
  deploy), teardown with `infra/down.sh`, and the manual path.
- [Switching accounts or domains](switching-accounts.md): `down.sh --all` on the old subscription,
  `up.sh` on the new one, re-pointing the NS records.
- [Environment lifecycle](env-lifecycle.md): the power state machine for test, staging and prod
  (`pause`, `resume`, `down`, `up`), the test cluster's CI and preview namespaces, the janitor,
  approvals, schedules and a demo-day checklist.
- [Cost](cost.md): estimated monthly cost per environment and power state.

## Related

- [infra/terraform/README.md](../../infra/terraform/README.md): modules, stacks, `scripts/tf.sh`,
  state model, environments and DNS, static checks.
- [deploy/helm/README.md](../../deploy/helm/README.md): the `bbm` chart, values layering, secrets.
- [deploy/helm/bbm-platform/README.md](../../deploy/helm/bbm-platform/README.md): the per-cluster
  platform chart (cert-manager issuers, wildcard certificate, Gateway `bbm` of gatewayClass
  `approuting-istio`) and
  `deploy/platform/install.sh`.
- [tests/README.md](../../tests/README.md): which test tiers run in which workflow and environment.
- Workflows in [`.github/workflows/`](../../.github/workflows/): `ci.yml` (Azure-free, `CI OK`
  gate), `_build-push.yml`, `_ephemeral-env.yml`, `integration-azure.yml`, `preview.yml`,
  `terraform.yml`, `deploy.yml`, `env-power.yml`, `contracts-deploy.yml`, `infra-janitor.yml`.
