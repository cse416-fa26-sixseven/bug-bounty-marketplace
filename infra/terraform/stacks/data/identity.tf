# Workload identities. Federated credentials (K8s service accounts) are added
# by the compute stack; only identities + RBAC live here.
#
# Every role below must be in env_delegable_roles in
# stacks/bootstrap/identities.tf, otherwise gh-bbm-<env> cannot assign it.
#
# id-bbm-<env>-aks is the AKS control-plane (cluster) identity. The compute
# stack creates an explicit kubelet identity and grants this identity Managed
# Identity Operator on it there (compute RG). Here it needs Network Contributor
# on this RG to bind the static ingress public IP. If the compute stack puts
# nodes into snet-aks it also needs subnet join rights; Network Contributor at
# RG scope already covers the VNet in this RG.

# certmgr (cert-manager DNS-01 solver): DNS Zone Contributor on each public
# env zone only, never on the RG.
locals {
  certmgr_dns_grants = {
    for z in local.dns.env_zones : "certmgr-dns-${split(".", z)[0]}" => {
      identity = "certmgr"
      scope    = data.azurerm_dns_zone.env[z].id
      role     = "DNS Zone Contributor"
    }
  }

  # worker (analysis): Key Vault Secrets User on exactly the two secrets its
  # SecretProviderClass mounts (deploy/helm/bbm bbm-kv-analysis), never on
  # the vault. The worker runs Slither on untrusted Solidity next to the PoC
  # sandbox, and the vault also holds chain-operator-key and session-secret.
  # Azure only accepts a secret-scoped assignment once the secret exists:
  #   database-url  written by this stack (staging/prod only; test runs
  #                 in-cluster Postgres and has none). The scope comes from
  #                 the secret resource, so the grant waits for it.
  #   llm-api-key   set out of band, never by Terraform (its value would land
  #                 in state on refresh). infra/up.sh applies the vault alone
  #                 first and seeds a placeholder before the full apply.
  worker_kv_secret_scopes = merge(
    { for k, s in module.keyvault.managed_secret_scopes : k => s if k == local.kv_secrets.database_url },
    { (local.kv_secrets.llm_api_key) = "${module.keyvault.id}/secrets/${local.kv_secrets.llm_api_key}" },
  )
  worker_kv_grants = {
    for name, scope in local.worker_kv_secret_scopes : "worker-kv-secret-${name}" => {
      identity = "worker"
      scope    = scope
      role     = "Key Vault Secrets User"
    }
  }
}

module "identity" {
  source = "../../modules/identity"

  identities          = module.naming.uamis
  resource_group_name = local.rg
  location            = var.location
  tags                = local.tags

  role_assignments = merge({
    # api (also used by the migrations job): KV secrets, read/write sources,
    # enqueue analysis jobs.
    api-kv-secrets-user = {
      identity = "api"
      scope    = module.keyvault.id
      role     = "Key Vault Secrets User"
    }
    api-sources-blob-contributor = {
      identity = "api"
      scope    = module.storage.container_id
      role     = "Storage Blob Data Contributor"
    }
    api-queue-sender = {
      identity = "api"
      scope    = module.storage.queue_id
      role     = "Storage Queue Data Message Sender"
    }

    # worker (analysis): its two KV secrets (local.worker_kv_grants), consume
    # jobs, read sources.
    worker-queue-processor = {
      identity = "worker"
      scope    = module.storage.queue_id
      role     = "Storage Queue Data Message Processor"
    }
    # KEDA's azure-queue scaler authenticates as the worker identity (via the
    # keda-operator federated credential) and reads queue metadata/length.
    worker-queue-reader = {
      identity = "worker"
      scope    = module.storage.id
      role     = "Storage Queue Data Reader"
    }
    worker-sources-blob-reader = {
      identity = "worker"
      scope    = module.storage.container_id
      role     = "Storage Blob Data Reader"
    }

    # aks cluster identity: bind the static ingress PIP in this RG.
    aks-network-contributor = {
      identity = "aks"
      scope    = data.azurerm_resource_group.data.id
      role     = "Network Contributor"
    }

    # sandbox: runs untrusted PoC code, so it deliberately gets no grants.
  }, local.worker_kv_grants, local.certmgr_dns_grants)
}
