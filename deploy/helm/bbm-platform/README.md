# bbm-platform Helm chart

Per-cluster platform layer from
[ADR 0002](../../../docs/adr/0002-aks-everywhere-and-azure-dns.md) section 3.
Release `bbm-platform`, namespace `bbm-platform`, one per cluster (test,
staging, prod). It needs cert-manager (CRDs) and the AKS app-routing add-on,
and is installed with cert-manager by `deploy/platform/install.sh`.

| resource | name | what it does |
|---|---|---|
| ClusterIssuer | `letsencrypt-staging`, `letsencrypt-prod` | ACME DNS-01 on Azure DNS. One `azureDNS` solver per env zone (`selector.dnsZones`), workload identity as `id-bbm-<env>-certmgr` (`managedIdentity.clientID`) |
| Certificate | `bbm-platform/bbm-wildcard` → Secret `bbm-wildcard-tls` | `<z>` and `*.<z>` for each env zone (test: `test.<zone>` and `preview.<zone>`), issuer `certificate.issuer` (default `letsencrypt-prod`) |
| NginxIngressController (cluster-scoped) | `bbm` | IngressClass `bbm-nginx`, LoadBalancer bound to the static PIP (`azure-pip-name`, `azure-load-balancer-resource-group`), `defaultSSLCertificate` = `bbm-platform/bbm-wildcard-tls` |

App Ingresses with `ingress.tls.mode: defaultCert` (no `secretName`) are
served with the wildcard, so CI runs and PR previews never request their own
certificates.

## Values

Layering: `values.yaml` → `values-<env>.yaml` (controller scaling) →
`values-infra.yaml` → `--set certificate.issuer=...`.

`values-infra.yaml` is the compute stack's `helm_values` output, the same file
the app chart gets. Required (the schema rejects empty values):

```yaml
dns:
  zone: <zone>
  envZones: [<env>.<zone>]          # test: [test.<zone>, preview.<zone>]
platform:
  subscriptionId: <guid>
  dnsResourceGroup: rg-bbm-<env>-data-eus2
  certManagerClientId: <guid>       # id-bbm-<env>-certmgr
ingress:
  publicIpName: pip-bbm-<env>-ingress
  publicIpResourceGroup: rg-bbm-<env>-data-eus2
```

All other keys in the file (`global`, `azure`, `ingress.host`, ...) are
ignored. Optional chart settings: `acme.email`, `certificate.issuer`,
`controller.scaling`, `controller.forceSSLRedirect`.

## Install

```sh
az aks get-credentials -g rg-bbm-<env>-compute-eus2 -n aks-bbm-<env>-eus2
kubelogin convert-kubeconfig -l azurecli
infra/terraform/scripts/tf.sh compute <env> output -raw helm_values > values-infra.yaml
deploy/platform/install.sh <env> --values values-infra.yaml [--issuer letsencrypt-staging] [--wait]
```

`install.sh` runs `helm upgrade --install` for the jetstack cert-manager chart
(pinned in the script, values in `deploy/platform/cert-manager-values.yaml`,
with the controller ServiceAccount annotated
`azure.workload.identity/client-id=<platform.certManagerClientId>`), then for
this chart. `--wait` waits up to 10 minutes for the Certificate to be Ready
and prints the Certificate, Orders and Challenges if it is not.

Use `--issuer letsencrypt-staging` while a new zone's delegation is being
debugged: it avoids Let's Encrypt rate limits, but browsers don't trust it.
Re-run without `--issuer` to switch back to `letsencrypt-prod`.

## Validate locally

```sh
cd deploy/helm
for e in test staging prod; do for fx in test prod; do
  helm lint --strict bbm-platform -f bbm-platform/values-$e.yaml -f bbm-platform/ci/$fx-values.yaml
  helm template bbm-platform bbm-platform -n bbm-platform \
    -f bbm-platform/values-$e.yaml -f bbm-platform/ci/$fx-values.yaml |
    kubeconform -strict -summary -kubernetes-version 1.34.0 -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      -schema-location 'kubeconform-schemas/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
done; done
```

`ci/prod-values.yaml` and `ci/test-values.yaml` are fake `values-infra.yaml`
files (one and two env zones). chart-testing lints with them too.

## Troubleshooting

```sh
kubectl -n bbm-platform describe certificate bbm-wildcard
kubectl get orders,challenges -A
kubectl -n cert-manager logs deploy/cert-manager | grep -i azure
```

- `AADSTS70021` / no matching federated identity: the federated credential
  for `system:serviceaccount:cert-manager:cert-manager` is missing on
  `id-bbm-<env>-certmgr`, or the pod started before the SA annotation was
  set. Re-run `install.sh` and restart `deploy/cert-manager`.
- `AuthorizationFailed` on `Microsoft.Network/dnsZones/TXT`: the identity
  lacks DNS Zone Contributor on that zone.
- Challenges stuck in `pending` with "propagation check failed": the child
  zone's NS delegation from the parent zone has not resolved yet.
