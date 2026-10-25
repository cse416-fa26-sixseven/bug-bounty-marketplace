# Offline test with mock azurerm/azapi providers and overridden remote state
# (no credentials, no backend).

mock_provider "azurerm" {
  mock_data "azurerm_resource_group" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-compute-eus2"
      name = "rg-bbm-staging-compute-eus2"
    }
  }

  mock_resource "azurerm_kubernetes_cluster" {
    defaults = {
      id                         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-compute-eus2/providers/Microsoft.ContainerService/managedClusters/aks-bbm-staging-eus2"
      oidc_issuer_url            = "https://eastus2.oic.prod-aks.azure.com/11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/"
      current_kubernetes_version = "1.34.1"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-compute-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-staging-kubelet"
      client_id    = "33333333-3333-3333-3333-333333333333"
      principal_id = "44444444-4444-4444-4444-444444444444"
    }
  }

  mock_resource "azurerm_kubernetes_cluster_node_pool" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-compute-eus2/providers/Microsoft.ContainerService/managedClusters/aks-bbm-staging-eus2/agentPools/apps"
    }
  }

  mock_resource "azurerm_monitor_data_collection_rule" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-compute-eus2/providers/Microsoft.Insights/dataCollectionRules/MSCI-eastus2-aks-bbm-staging-eus2"
    }
  }
}

# time_sleep (AKS RBAC propagation) is a no-op under the mock.
mock_provider "time" {}

# azapi_update_resource (app routing Gateway API) is a no-op under the mock.
mock_provider "azapi" {}

override_data {
  target = data.terraform_remote_state.global
  values = {
    outputs = {
      acr_name                   = "acrbbma1b2"
      acr_login_server           = "acrbbma1b2.azurecr.io"
      acr_id                     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-shared-eus2/providers/Microsoft.ContainerRegistry/registries/acrbbma1b2"
      law_id                     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-shared-eus2/providers/Microsoft.OperationalInsights/workspaces/log-bbm-shared-eus2"
      law_workspace_id           = "55555555-5555-5555-5555-555555555555"
      shared_resource_group_name = "rg-bbm-shared-eus2"
      location                   = "eastus2"
      suffix                     = "a1b2"
      dns_zone_name              = "bbm.example.com"
      shared_key_vault_name      = "kv-bbm-shared-a1b2"
      shared_key_vault_id        = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-shared-eus2/providers/Microsoft.KeyVault/vaults/kv-bbm-shared-a1b2"
    }
  }
}

override_data {
  target = data.terraform_remote_state.data
  values = {
    outputs = {
      resource_group_name    = "rg-bbm-staging-data-eus2"
      location               = "eastus2"
      tenant_id              = "11111111-1111-1111-1111-111111111111"
      key_vault_name         = "kv-bbm-stg-a1b2"
      key_vault_id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-eus2/providers/Microsoft.KeyVault/vaults/kv-bbm-stg-a1b2"
      pg_fqdn                = "psql-bbm-staging-eus2.postgres.database.azure.com"
      pg_server_name         = "psql-bbm-staging-eus2"
      storage_account_name   = "stbbmstga1b2"
      storage_blob_endpoint  = "https://stbbmstga1b2.blob.core.windows.net/"
      queue_name             = "analysis-jobs"
      ingress_pip_name       = "pip-bbm-staging-ingress"
      ingress_ip             = "20.0.0.1"
      ingress_fqdn           = "bbm-staging.eastus2.cloudapp.azure.com"
      subnet_aks_id          = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-eus2/providers/Microsoft.Network/virtualNetworks/vnet-bbm-staging-eus2/subnets/snet-aks"
      psql_subnet_cidr       = "10.20.16.0/24"
      postgres_enabled       = true
      dns_zone_names         = ["staging.bbm.example.com"]
      internal_dns_zone_name = "staging.internal.bbm.example.com"
      law_id                 = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-eus2/providers/Microsoft.OperationalInsights/workspaces/log-bbm-staging-eus2"
      uami = {
        aks = {
          id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-staging-aks"
          client_id    = "a0000000-0000-0000-0000-000000000001"
          principal_id = "b0000000-0000-0000-0000-000000000001"
        }
        api = {
          id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-staging-api"
          client_id    = "a0000000-0000-0000-0000-000000000002"
          principal_id = "b0000000-0000-0000-0000-000000000002"
        }
        worker = {
          id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-staging-worker"
          client_id    = "a0000000-0000-0000-0000-000000000003"
          principal_id = "b0000000-0000-0000-0000-000000000003"
        }
        sandbox = {
          id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-staging-sandbox"
          client_id    = "a0000000-0000-0000-0000-000000000004"
          principal_id = "b0000000-0000-0000-0000-000000000004"
        }
        certmgr = {
          id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-staging-certmgr"
          client_id    = "a0000000-0000-0000-0000-000000000005"
          principal_id = "b0000000-0000-0000-0000-000000000005"
        }
      }
    }
  }
}

variables {
  subscription_id    = "00000000-0000-0000-0000-000000000000"
  env                = "staging"
  tfstate_account    = "stbbmtfstatea1b2"
  kubernetes_version = "1.34"
}

run "staging_plan" {
  command = plan

  assert {
    condition     = module.aks.name == "aks-bbm-staging-eus2" && output.cluster_name == "aks-bbm-staging-eus2"
    error_message = "cluster name wrong"
  }

  assert {
    condition     = output.resource_group_name == "rg-bbm-staging-compute-eus2" && module.aks.node_resource_group == "rg-bbm-staging-aksnodes-eus2"
    error_message = "resource group / node resource group wrong"
  }

  assert {
    condition = alltrue([
      module.aks.network_profile.network_plugin == "azure",
      module.aks.network_profile.network_plugin_mode == "overlay",
      module.aks.network_profile.network_data_plane == "cilium",
      module.aks.network_profile.network_policy == "cilium",
    ])
    error_message = "expected Azure CNI overlay with Cilium data plane and policy"
  }

  assert {
    condition     = module.aks.security.oidc_issuer_enabled && module.aks.security.workload_identity_enabled
    error_message = "OIDC issuer and workload identity must be enabled"
  }

  assert {
    condition     = module.aks.security.local_account_disabled && module.aks.security.azure_rbac_enabled
    error_message = "local accounts must be disabled with Entra ID + Azure RBAC"
  }

  assert {
    condition = alltrue([
      module.aks.ingress_profile.gateway_api_installation == "Standard",
      module.aks.ingress_profile.app_routing_istio_mode == "Enabled",
      !module.aks.ingress_profile.web_app_routing_nginx,
    ])
    error_message = "expected Managed Gateway API (Standard) + app routing Gateway API (approuting-istio) and no managed NGINX"
  }

  assert {
    condition     = output.node_pools == ["system"]
    error_message = "staging must have only the system pool (apps and sandbox disabled)"
  }

  assert {
    condition = output.federated_subjects == sort([
      "system:serviceaccount:bbm:bbm-api",
      "system:serviceaccount:bbm:bbm-migrations",
      "system:serviceaccount:bbm:bbm-analysis",
      "system:serviceaccount:kube-system:keda-operator",
      "system:serviceaccount:bbm-sandbox:bbm-sandbox-runner",
      "system:serviceaccount:cert-manager:cert-manager",
    ])
    error_message = "expected exactly the 6 federated service-account subjects"
  }

  assert {
    condition = alltrue([
      yamldecode(output.helm_values).global.image.registry == "acrbbma1b2.azurecr.io",
      yamldecode(output.helm_values).azure.tenantId != "",
      yamldecode(output.helm_values).azure.keyVaultName == "kv-bbm-stg-a1b2",
      yamldecode(output.helm_values).azure.apiClientId == "a0000000-0000-0000-0000-000000000002",
      yamldecode(output.helm_values).azure.workerClientId == "a0000000-0000-0000-0000-000000000003",
      yamldecode(output.helm_values).azure.migrationsClientId == "a0000000-0000-0000-0000-000000000002",
      yamldecode(output.helm_values).azure.sandboxClientId == "a0000000-0000-0000-0000-000000000004",
      yamldecode(output.helm_values).azure.storageAccountName != "",
      yamldecode(output.helm_values).azure.storageBlobEndpoint != "",
      yamldecode(output.helm_values).azure.queueName == "analysis-jobs",
      yamldecode(output.helm_values).ingress.host == "staging.bbm.example.com",
      yamldecode(output.helm_values).ingress.publicIpName == "pip-bbm-staging-ingress",
      yamldecode(output.helm_values).ingress.publicIpResourceGroup == "rg-bbm-staging-data-eus2",
      yamldecode(output.helm_values).networkPolicy.postgresCidr == "10.20.16.0/24",
      yamldecode(output.helm_values).dns.zone == "bbm.example.com",
      yamldecode(output.helm_values).dns.envZones == ["staging.bbm.example.com"],
      yamldecode(output.helm_values).dns.internalZone == "staging.internal.bbm.example.com",
      yamldecode(output.helm_values).platform.subscriptionId == "00000000-0000-0000-0000-000000000000",
      yamldecode(output.helm_values).platform.dnsResourceGroup == "rg-bbm-staging-data-eus2",
      yamldecode(output.helm_values).platform.certManagerClientId == "a0000000-0000-0000-0000-000000000005",
    ])
    error_message = "helm_values is missing a key or has a wrong value"
  }

  assert {
    condition = alltrue([
      keys(yamldecode(output.helm_values)) == ["azure", "dns", "global", "ingress", "networkPolicy", "platform"],
      keys(yamldecode(output.helm_values).dns) == ["envZones", "internalZone", "zone"],
      keys(yamldecode(output.helm_values).platform) == ["certManagerClientId", "dnsResourceGroup", "subscriptionId"],
      alltrue([for v in values(yamldecode(output.helm_values).platform) : v != null && v != ""]),
      keys(yamldecode(output.helm_values).global) == ["image"],
      length(keys(yamldecode(output.helm_values).azure)) == 9,
      length(keys(yamldecode(output.helm_values).ingress)) == 3,
      keys(yamldecode(output.helm_values).networkPolicy) == ["postgresCidr"],
      alltrue([for v in values(yamldecode(output.helm_values).azure) : v != null && v != ""]),
      alltrue([for v in values(yamldecode(output.helm_values).ingress) : v != null && v != ""]),
    ])
    error_message = "helm_values must contain exactly the pinned keys, all non-empty"
  }

  assert {
    condition     = module.aks.sku_tier == "Free"
    error_message = "staging must use the Free AKS tier"
  }
}

run "prod_plan" {
  command = plan

  variables {
    env                         = "prod"
    aks_sku_tier                = "Standard"
    system_only_critical_addons = true
    apps_pool_enabled           = true
    apps_min_count              = 1
    apps_max_count              = 3
    container_insights          = true
  }

  assert {
    condition     = output.cluster_name == "aks-bbm-prod-eus2"
    error_message = "prod cluster name wrong"
  }

  assert {
    condition     = output.node_pools == ["system", "apps"]
    error_message = "prod must have system + apps pools"
  }

  assert {
    condition     = module.aks.container_insights_enabled
    error_message = "prod must enable Container Insights"
  }

  assert {
    condition     = module.aks.sku_tier == "Standard" && output.sku_tier == "Standard"
    error_message = "prod must use the Standard AKS tier"
  }
}

run "sandbox_pool" {
  command = plan

  variables {
    sandbox_pool_enabled = true
  }

  assert {
    condition     = output.node_pools == ["system", "sandbox"]
    error_message = "sandbox pool should be created when enabled"
  }
}

run "apply_with_mocks" {
  command = apply

  assert {
    condition     = output.oidc_issuer_url != "" && output.kube_version == "1.34.1"
    error_message = "cluster outputs missing"
  }

  assert {
    condition     = length(module.workload_identity.credentials) == 6
    error_message = "expected 6 federated credentials"
  }
}

run "test_env" {
  command = plan

  variables {
    env              = "test"
    system_max_count = 3
  }

  override_data {
    target = data.terraform_remote_state.data
    values = {
      outputs = {
        resource_group_name    = "rg-bbm-test-data-eus2"
        location               = "eastus2"
        tenant_id              = "11111111-1111-1111-1111-111111111111"
        key_vault_name         = "kv-bbm-tst-a1b2"
        key_vault_id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-test-data-eus2/providers/Microsoft.KeyVault/vaults/kv-bbm-tst-a1b2"
        pg_fqdn                = null
        pg_server_name         = null
        postgres_enabled       = false
        storage_account_name   = "stbbmtsta1b2"
        storage_blob_endpoint  = "https://stbbmtsta1b2.blob.core.windows.net/"
        queue_name             = "analysis-jobs"
        ingress_pip_name       = "pip-bbm-test-ingress"
        ingress_ip             = "20.0.0.2"
        ingress_fqdn           = "bbm-test.eastus2.cloudapp.azure.com"
        subnet_aks_id          = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-test-data-eus2/providers/Microsoft.Network/virtualNetworks/vnet-bbm-test-eus2/subnets/snet-aks"
        psql_subnet_cidr       = "10.10.16.0/24"
        dns_zone_names         = ["test.bbm.example.com", "preview.bbm.example.com"]
        internal_dns_zone_name = "test.internal.bbm.example.com"
        law_id                 = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-test-data-eus2/providers/Microsoft.OperationalInsights/workspaces/log-bbm-test-eus2"
        uami = {
          aks = {
            id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-test-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-test-aks"
            client_id    = "c0000000-0000-0000-0000-000000000000"
            principal_id = "d0000000-0000-0000-0000-000000000000"
          }
          api = {
            id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-test-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-test-api"
            client_id    = "c0000000-0000-0000-0000-000000000001"
            principal_id = "d0000000-0000-0000-0000-000000000001"
          }
          worker = {
            id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-test-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-test-worker"
            client_id    = "c0000000-0000-0000-0000-000000000002"
            principal_id = "d0000000-0000-0000-0000-000000000002"
          }
          sandbox = {
            id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-test-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-test-sandbox"
            client_id    = "c0000000-0000-0000-0000-000000000003"
            principal_id = "d0000000-0000-0000-0000-000000000003"
          }
          certmgr = {
            id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-test-data-eus2/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-bbm-test-certmgr"
            client_id    = "c0000000-0000-0000-0000-000000000004"
            principal_id = "d0000000-0000-0000-0000-000000000004"
          }
        }
      }
    }
  }

  assert {
    condition     = output.cluster_name == "aks-bbm-test-eus2" && module.aks.sku_tier == "Free" && output.node_pools == ["system"]
    error_message = "test cluster must be Free tier with only the system pool"
  }

  assert {
    condition = alltrue([
      yamldecode(output.helm_values).ingress.host == "test.bbm.example.com",
      yamldecode(output.helm_values).dns.envZones == ["test.bbm.example.com", "preview.bbm.example.com"],
      yamldecode(output.helm_values).dns.internalZone == "test.internal.bbm.example.com",
      yamldecode(output.helm_values).platform.dnsResourceGroup == "rg-bbm-test-data-eus2",
      yamldecode(output.helm_values).platform.certManagerClientId == "c0000000-0000-0000-0000-000000000004",
      yamldecode(output.helm_values).networkPolicy.postgresCidr == "10.10.16.0/24",
      yamldecode(output.helm_values).azure.keyVaultName == "kv-bbm-tst-a1b2",
    ])
    error_message = "test helm_values wrong"
  }
}

run "rejects_bad_sku_tier" {
  command = plan

  variables {
    aks_sku_tier = "Premium"
  }

  expect_failures = [var.aks_sku_tier]
}
