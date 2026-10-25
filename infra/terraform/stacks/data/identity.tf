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

    # worker (analysis): KV secrets, consume jobs, read sources.
    worker-kv-secrets-user = {
      identity = "worker"
      scope    = module.keyvault.id
      role     = "Key Vault Secrets User"
    }
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
  }, local.certmgr_dns_grants)
}
