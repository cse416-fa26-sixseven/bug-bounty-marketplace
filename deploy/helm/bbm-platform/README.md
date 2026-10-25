# bbm-platform Helm chart

Per-cluster platform layer from
[ADR 0002](../../../docs/adr/0002-aks-everywhere-and-azure-dns.md) section 3.
Release `bbm-platform`, namespace `bbm-platform`, one per cluster (test,
staging, prod). It needs cert-manager (CRDs), the AKS Managed Gateway API CRDs
and the app routing add-on's Gateway API implementation (GatewayClass
`approuting-istio`, enabled by `infra/terraform/modules/aks`), and is
installed with cert-manager by `deploy/platform/install.sh`.

| resource | name | what it does |
|---|---|---|
| ClusterIssuer | `letsencrypt-staging`, `letsencrypt-prod` | ACME DNS-01 on Azure DNS. One `azureDNS` solver per env zone (`selector.dnsZones`), workload identity as `id-bbm-<env>-certmgr` (`managedIdentity.clientID`) |
| Certificate | `bbm-platform/bbm-wildcard` → Secret `bbm-wildcard-tls` | `<z>` and `*.<z>` for each env zone (test: `test.<zone>` and `preview.<zone>`), issuer `certificate.issuer` (default `letsencrypt-prod`) |
| Gateway | `bbm-platform/bbm` | GatewayClass `approuting-istio`. `spec.infrastructure.annotations` `azure-pip-name` / `azure-load-balancer-resource-group` bind the add-on's LoadBalancer Service to the static PIP. Listener `http` (:80, own namespace only); `https-<zone>` and `https-wildcard-<zone>` (:443, `<z>` / `*.<z>`, TLS `Terminate` with `bbm-wildcard-tls`, routes from namespaces labelled `bbm.io/gateway-access=true`) |
| ConfigMap | `bbm-platform/bbm-gateway-options` | per-Gateway HPA (`gateway.scaling`, min 2) via `spec.infrastructure.parametersRef` |
| HTTPRoute | `bbm-platform/bbm-https-redirect` | on listener `http`: 301 to `https` for every host |

For Gateway `bbm` the add-on provisions Deployment, Service (`LoadBalancer`),
HPA and PDB `bbm-approuting-istio` in `bbm-platform`; its Envoy pods carry
`gateway.networking.k8s.io/gateway-name=bbm` (the app chart's
NetworkPolicies select that label). App HTTPRoutes (`deploy/helm/bbm`,
`ingress.enabled`) attach to the HTTPS listeners and are served with the
wildcard, so CI runs and PR previews never request their own certificates.
Their namespace needs the `bbm.io/gateway-access=true` label
(`gateway.routeNamespaceLabel`), which `deploy.yml` and `_ephemeral-env.yml`
set.

## Values

Layering: `values.yaml` → `values-<env>.yaml` (Gateway HPA) →
`values-infra.yaml` → `--set certificate.issuer=...`.

`values-infra.yaml` is the compute stack's `helm_values` output, the same file
the app chart gets. Required (the schema rejects empty values):

```yaml
dns:
  zone: <zone>
  envZones: [<env>.<zone>]          # test: [test.<zone>, preview.<zone>]
platform:
  subscriptionId: <guid>
  dnsResourceGroup: rg-bbm-<env>-data-<abbr>
  certManagerClientId: <guid>       # id-bbm-<env>-certmgr
ingress:
  publicIpName: pip-bbm-<env>-ingress
  publicIpResourceGroup: rg-bbm-<env>-data-<abbr>
```

All other keys in the file (`global`, `azure`, `ingress.host`, ...) are
ignored. Optional chart settings: `acme.email`, `certificate.issuer`,
`gateway.scaling` (`minReplicas` ≥ 2, the add-on's floor),
`gateway.routeNamespaceLabel`, `gateway.name` / `gateway.className`.

## Install

```sh
source <(infra/terraform/scripts/env-region.sh <env>)   # COMPUTE_RG / CLUSTER in the env's region
az aks get-credentials -g "$COMPUTE_RG" -n "$CLUSTER"
kubelogin convert-kubeconfig -l azurecli
infra/terraform/scripts/tf.sh compute <env> output -raw helm_values > values-infra.yaml
deploy/platform/install.sh <env> --values values-infra.yaml [--issuer letsencrypt-staging] [--wait]
```

`install.sh` runs `helm upgrade --install` for the jetstack cert-manager chart
(pinned in the script, values in `deploy/platform/cert-manager-values.yaml`,
with the controller ServiceAccount annotated
`azure.workload.identity/client-id=<platform.certManagerClientId>`), then for
this chart. Before that it waits for GatewayClass `approuting-istio` to exist
and be Accepted (it fails with a hint to apply the compute stack otherwise).
`--wait` waits up to 10 minutes for the Certificate to be Ready (printing the
Certificate, Orders and Challenges if it is not) and up to 10 minutes for
Gateway `bbm` to be `Programmed` (printing the Gateway, its pods/Service and
Service events if it is not).

After a successful install it annotates namespace `bbm-platform` with
`bbm.io/platform-rev`, a hash of the cert-manager version and values and this
chart (minus `README.md` and `ci/`). `install.sh --print-rev` prints the hash of
the current checkout; PR previews, which never install the platform, compare
the two and fail when the platform is missing or outdated. CI runs on `main`
(environment `test`) re-run `install.sh` on every deploy.

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
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json'
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

Gateway:

```sh
kubectl get gatewayclass approuting-istio            # ACCEPTED True
kubectl -n aks-istio-system get pods                  # istiod
kubectl -n bbm-platform describe gateway bbm          # Programmed, listener conditions
kubectl -n bbm-platform get deploy,svc,hpa,pdb bbm-approuting-istio
kubectl -n bbm-platform logs deploy/bbm-approuting-istio   # Envoy access log
kubectl get httproute -A                              # per-route Accepted / ResolvedRefs
```

- No GatewayClass `approuting-istio`: the Gateway API settings are not on
  the cluster. `az aks show -g rg-bbm-<env>-compute-<abbr> -n aks-bbm-<env>-<abbr>
  --query ingressProfile` (`<abbr>`: the env's region code, test `cac` / staging `dke` / prod `ncus`) should show `gatewayApi.installation: Standard` and
  `webAppRouting.gatewayApiImplementations.appRoutingIstio.mode: Enabled`;
  re-apply the compute stack.
- Gateway not `Programmed`, Service `EXTERNAL-IP` pending, events
  `AuthorizationFailed` / `PublicIPNotFound`: the cluster identity lacks
  Network Contributor on `rg-bbm-<env>-data-<abbr>`, or the annotations name the
  wrong PIP / resource group.
- Listener `ResolvedRefs=False` (`InvalidCertificateRef`): Secret
  `bbm-wildcard-tls` does not exist yet (Certificate not issued).
- App route `Accepted=False` (`NotAllowedByListeners`): its namespace lacks
  `bbm.io/gateway-access=true`, or its hostname is outside the env zones.
