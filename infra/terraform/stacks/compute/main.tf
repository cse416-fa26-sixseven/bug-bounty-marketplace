# Disposable compute layer for test/staging/prod: the AKS cluster, its node pools,
# kubelet registry pull grant and the workload-identity federated credentials. Everything
# durable lives in stacks/data (read through remote state), so `down`
# (terraform destroy of this stack) and `up` (apply) lose no data, IP or DNS.

data "terraform_remote_state" "data" {
  backend = "azurerm"
  config = {
    resource_group_name  = var.tfstate_resource_group
    storage_account_name = var.tfstate_account
    container_name       = var.tfstate_container
    key                  = "${var.env}/data.tfstate"
    use_azuread_auth     = true
    use_oidc             = true
  }
}

data "terraform_remote_state" "global" {
  backend = "azurerm"
  config = {
    resource_group_name  = var.tfstate_resource_group
    storage_account_name = var.tfstate_account
    container_name       = var.tfstate_container
    key                  = "global.tfstate"
    use_azuread_auth     = true
    use_oidc             = true
  }
}

locals {
  d = data.terraform_remote_state.data.outputs
  g = data.terraform_remote_state.global.outputs
}

module "naming" {
  source = "../../modules/naming"

  env           = var.env
  layer         = "compute"
  location      = var.location
  location_abbr = var.location_abbr
  suffix        = local.g.suffix
}

# Created by stacks/bootstrap; never managed here.
data "azurerm_resource_group" "compute" {
  name = module.naming.env.compute_resource_group
}

module "aks" {
  source = "../../modules/aks"

  name                     = module.naming.env.aks_cluster
  dns_prefix               = "bbm-${var.env}"
  resource_group_name      = data.azurerm_resource_group.compute.name
  node_resource_group_name = module.naming.env.aks_node_resource_group
  location                 = var.location
  kubernetes_version       = var.kubernetes_version
  sku_tier                 = var.aks_sku_tier
  tenant_id                = local.d.tenant_id
  cluster_identity_id      = local.d.uami.aks.id
  # Not in modules/naming (yet): kubelet identity is compute-layer only.
  kubelet_identity_name         = "id-bbm-${var.env}-kubelet"
  cluster_identity_principal_id = local.d.uami.aks.principal_id
  subnet_id                     = local.d.subnet_aks_id
  acr_id                        = local.g.acr_id

  container_insights_enabled = var.container_insights
  log_analytics_workspace_id = var.container_insights ? local.d.law_id : null

  system_pool = {
    vm_size                      = var.system_vm_size
    min_count                    = var.system_min_count
    max_count                    = var.system_max_count
    only_critical_addons_enabled = var.system_only_critical_addons
  }

  apps_pool = {
    enabled   = var.apps_pool_enabled
    vm_size   = var.apps_vm_size
    min_count = var.apps_min_count
    max_count = var.apps_max_count
  }

  sandbox_pool = {
    enabled   = var.sandbox_pool_enabled
    vm_size   = var.sandbox_vm_size
    min_count = 0
    max_count = var.sandbox_max_count
  }

  tags = module.naming.tags
}

# Service accounts (deploy/helm/bbm) -> user-assigned identities from the data
# stack. These live here because the issuer URL changes on cluster recreate.
locals {
  # The app's identities, for release `bbm` in namespace `bbm` (staging/prod).
  # The test cluster has no such release: its ephemeral namespaces run with
  # azure.workloadIdentity.enabled=false (values-test.yaml), so only the
  # cert-manager credential is created there.
  app_workload_identities = {
    api = {
      user_assigned_identity_id = local.d.uami.api.id
      credentials = {
        "bbm-bbm-api"        = "system:serviceaccount:bbm:bbm-api"
        "bbm-bbm-migrations" = "system:serviceaccount:bbm:bbm-migrations"
      }
    }
    worker = {
      user_assigned_identity_id = local.d.uami.worker.id
      credentials = {
        "bbm-bbm-analysis" = "system:serviceaccount:bbm:bbm-analysis"
        # KEDA add-on authenticates its queue scaler as the operator SA.
        "kube-system-keda-operator" = "system:serviceaccount:kube-system:keda-operator"
      }
    }
    sandbox = {
      user_assigned_identity_id = local.d.uami.sandbox.id
      credentials = {
        "bbm-sandbox-bbm-sandbox-runner" = "system:serviceaccount:bbm-sandbox:bbm-sandbox-runner"
      }
    }
  }

  # cert-manager DNS-01 solver (deploy/platform), DNS Zone Contributor on the env zones.
  platform_workload_identities = {
    certmgr = {
      user_assigned_identity_id = local.d.uami.certmgr.id
      credentials = {
        "cert-manager-cert-manager" = "system:serviceaccount:cert-manager:cert-manager"
      }
    }
  }
}

module "workload_identity" {
  source = "../../modules/workload-identity-federation"

  issuer_url = module.aks.oidc_issuer_url

  identities = merge(
    { for k, v in local.app_workload_identities : k => v if var.env != "test" },
    local.platform_workload_identities,
  )
}

locals {
  # Consumed by deploy.yml as values-infra.yaml for deploy/helm/bbm (and by
  # deploy/helm/bbm-platform: dns, platform, ingress.publicIp*). Keys are pinned
  # in docs/adr/0001 and 0002; the app chart runs with
  # global.requireInfraValues=true and fails on any missing key.
  helm_values = {
    global = {
      image = {
        registry = local.g.acr_login_server
      }
    }
    azure = {
      tenantId            = local.d.tenant_id
      keyVaultName        = local.d.key_vault_name
      apiClientId         = local.d.uami.api.client_id
      workerClientId      = local.d.uami.worker.client_id
      migrationsClientId  = local.d.uami.api.client_id
      sandboxClientId     = local.d.uami.sandbox.client_id
      storageAccountName  = local.d.storage_account_name
      storageBlobEndpoint = local.d.storage_blob_endpoint
      queueName           = local.d.queue_name
    }
    # staging/prod: <env>.<zone>; test: test.<zone> (ephemeral workflows
    # override it per namespace).
    ingress = {
      host                  = local.d.dns_zone_names[0]
      publicIpName          = local.d.ingress_pip_name
      publicIpResourceGroup = local.d.resource_group_name
    }
    networkPolicy = {
      postgresCidr = local.d.psql_subnet_cidr
    }
    dns = {
      zone         = local.g.dns_zone_name
      envZones     = local.d.dns_zone_names
      internalZone = local.d.internal_dns_zone_name
    }
    platform = {
      subscriptionId      = var.subscription_id
      dnsResourceGroup    = local.d.resource_group_name
      certManagerClientId = local.d.uami.certmgr.client_id
    }
  }
}
