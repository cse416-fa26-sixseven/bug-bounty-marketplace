# Offline test with mock providers (no credentials, no backend).

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "11111111-1111-1111-1111-111111111111"
    }
  }

  mock_data "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus"
    }
  }

  mock_data "azurerm_dns_zone" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Network/dnsZones/staging.bbm.example.com"
    }
  }

  mock_resource "azurerm_virtual_network" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Network/virtualNetworks/vnet-bbm-staging-ncus"
    }
  }

  mock_resource "azurerm_subnet" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Network/virtualNetworks/vnet-bbm-staging-ncus/subnets/mock"
    }
  }

  mock_resource "azurerm_network_security_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Network/networkSecurityGroups/mock"
    }
  }

  mock_resource "azurerm_private_dns_zone" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Network/privateDnsZones/staging.private.postgres.database.azure.com"
    }
  }

  mock_resource "azurerm_public_ip" {
    defaults = {
      id         = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Network/publicIPAddresses/pip-bbm-staging-ingress"
      ip_address = "20.0.0.10"
    }
  }

  mock_resource "azurerm_log_analytics_workspace" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.OperationalInsights/workspaces/log-bbm-staging-ncus"
    }
  }

  mock_resource "azurerm_key_vault" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.KeyVault/vaults/kv-bbm-stg-a1b2"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id                    = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Storage/storageAccounts/stbbmstga1b2"
      primary_blob_endpoint = "https://stbbmstga1b2.blob.core.windows.net/"
    }
  }

  mock_resource "azurerm_storage_container" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Storage/storageAccounts/stbbmstga1b2/blobServices/default/containers/sources"
    }
  }

  mock_resource "azurerm_storage_queue" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.Storage/storageAccounts/stbbmstga1b2/queueServices/default/queues/analysis-jobs"
    }
  }

  mock_resource "azurerm_postgresql_flexible_server" {
    defaults = {
      id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.DBforPostgreSQL/flexibleServers/psql-bbm-staging-ncus"
      fqdn = "psql-bbm-staging-ncus.postgres.database.azure.com"
    }
  }

  mock_resource "azurerm_user_assigned_identity" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-staging-data-ncus/providers/Microsoft.ManagedIdentity/userAssignedIdentities/mock"
      client_id    = "33333333-3333-3333-3333-333333333333"
      principal_id = "44444444-4444-4444-4444-444444444444"
    }
  }
}

mock_provider "random" {}

mock_provider "time" {}

override_data {
  target = data.terraform_remote_state.global
  values = {
    outputs = {
      dns_zone_name = "bbm.example.com"
      suffix        = "a1b2"
    }
  }
}

variables {
  subscription_id = "00000000-0000-0000-0000-000000000000"
  env             = "staging"
  suffix          = "a1b2"
  tfstate_account = "stbbmtfstatea1b2"
  vnet_cidr       = "10.20.0.0/16"
  subnet_cidrs = {
    aks  = "10.20.0.0/20"
    psql = "10.20.16.0/24"
    pe   = "10.20.17.0/24"
  }
}

run "plan_names_and_settings" {
  command = plan

  assert {
    condition = (
      module.network.vnet_name == "vnet-bbm-staging-ncus" &&
      module.postgres[0].name == "psql-bbm-staging-ncus" &&
      module.keyvault.name == "kv-bbm-stg-a1b2" &&
      module.storage.name == "stbbmstga1b2" &&
      module.law.name == "log-bbm-staging-ncus" &&
      azurerm_public_ip.ingress.name == "pip-bbm-staging-ingress"
    )
    error_message = "resource names do not follow the naming module"
  }

  assert {
    condition = (
      module.network.subnet_cidrs.aks == "10.20.0.0/20" &&
      module.network.subnet_cidrs.psql == "10.20.16.0/24" &&
      module.network.subnet_cidrs.pe == "10.20.17.0/24"
    )
    error_message = "subnet CIDRs wrong"
  }

  assert {
    condition     = output.psql_subnet_cidr == "10.20.16.0/24"
    error_message = "psql_subnet_cidr output must be the delegated subnet CIDR"
  }

  assert {
    condition = (
      module.postgres[0].administrator_login == "bbmadmin" &&
      module.postgres[0].database_name == "bbm"
    )
    error_message = "PG admin/database wrong"
  }

  assert {
    condition = (
      module.postgres[0].sku_name == "B_Standard_B1ms" &&
      module.postgres[0].postgres_version == "16" &&
      module.postgres[0].public_network_access_enabled == false
    )
    error_message = "PG must be private B_Standard_B1ms v16"
  }

  assert {
    condition     = module.keyvault.rbac_authorization_enabled
    error_message = "env KV must use RBAC mode"
  }

  assert {
    condition     = module.storage.shared_access_key_enabled == false
    error_message = "storage shared keys must be disabled"
  }

  assert {
    condition     = azurerm_public_ip.ingress.sku == "Standard" && azurerm_public_ip.ingress.allocation_method == "Static" && azurerm_public_ip.ingress.domain_name_label == "bbm-staging"
    error_message = "ingress PIP must be Standard/Static with DNS label bbm-staging"
  }

  assert {
    condition     = output.ingress_fqdn == "bbm-staging.northcentralus.cloudapp.azure.com"
    error_message = "ingress_fqdn wrong"
  }

  assert {
    condition     = length(module.identity.role_assignment_ids) == 9
    error_message = "expected 9 role assignments (api 3, worker 4, aks 1, certmgr 1, sandbox 0)"
  }

  assert {
    condition = (
      toset(keys(azurerm_dns_a_record.ingress)) == toset(["@.staging.bbm.example.com", "*.staging.bbm.example.com"]) &&
      alltrue([for r in azurerm_dns_a_record.ingress : r.zone_name == "staging.bbm.example.com" && r.resource_group_name == "rg-bbm-staging-data-ncus"])
    )
    error_message = "expected apex + wildcard alias A records in staging.<zone>"
  }

  assert {
    condition = (
      azurerm_private_dns_zone.internal.name == "staging.internal.bbm.example.com" &&
      length(azurerm_private_dns_cname_record.postgres) == 1 &&
      azurerm_private_dns_cname_record.postgres[0].name == "postgres"
    )
    error_message = "internal zone / postgres CNAME wrong"
  }

  assert {
    condition     = module.network.psql_delegated
    error_message = "with postgres the psql subnet must be delegated and have its private zone"
  }

  assert {
    condition     = toset(module.keyvault.secret_names) == toset(["database-url", "pg-admin-password"])
    error_message = "env KV secrets wrong"
  }
}

run "apply_with_mocks" {
  command = apply

  # Exercises the officer grant + time_sleep RBAC propagation path.
  variables {
    secret_officer_sp_object_ids   = ["88888888-8888-8888-8888-888888888888"]
    secret_officer_user_object_ids = ["99999999-9999-9999-9999-999999999999"]
  }

  assert {
    condition = (
      module.postgres[0].fqdn == "psql-bbm-staging-ncus.postgres.database.azure.com" &&
      output.pg_fqdn == module.postgres[0].fqdn &&
      output.pg_server_name == "psql-bbm-staging-ncus"
    )
    error_message = "PG outputs wrong"
  }

  assert {
    condition     = toset(keys(output.uami)) == toset(["aks", "api", "worker", "sandbox", "certmgr"])
    error_message = "uami output must have aks, api, worker, sandbox, certmgr"
  }

  assert {
    condition = (
      azurerm_dns_a_record.ingress["@.staging.bbm.example.com"].target_resource_id == azurerm_public_ip.ingress.id &&
      azurerm_private_dns_cname_record.postgres[0].record == "psql-bbm-staging-ncus.postgres.database.azure.com" &&
      output.dns_zone_names == tolist(["staging.bbm.example.com"]) &&
      output.internal_dns_zone_name == "staging.internal.bbm.example.com" &&
      output.postgres_enabled
    )
    error_message = "DNS records / outputs wrong"
  }

  assert {
    condition     = alltrue([for v in values(output.uami) : v.client_id != "" && v.principal_id != "" && v.id != ""])
    error_message = "uami entries need id, client_id, principal_id"
  }

  assert {
    condition = (
      output.resource_group_name != "" &&
      output.key_vault_name == "kv-bbm-stg-a1b2" &&
      output.storage_account_name == "stbbmstga1b2" &&
      output.storage_blob_endpoint == "https://stbbmstga1b2.blob.core.windows.net/" &&
      output.queue_name == "analysis-jobs" &&
      output.ingress_pip_name == "pip-bbm-staging-ingress" &&
      output.tenant_id == "11111111-1111-1111-1111-111111111111" &&
      output.location == "northcentralus" &&
      output.subnet_aks_id != "" &&
      output.law_id != "" &&
      output.key_vault_id != ""
    )
    error_message = "data stack outputs missing or wrong"
  }

  assert {
    condition     = startswith(nonsensitive(module.postgres[0].database_url), "postgres://bbmadmin:") && endswith(nonsensitive(module.postgres[0].database_url), "@psql-bbm-staging-ncus.postgres.database.azure.com:5432/bbm?sslmode=require")
    error_message = "database-url format wrong"
  }

  assert {
    condition     = module.network.ingress_destination_address_prefix == "20.0.0.10" && output.ingress_ip == "20.0.0.10"
    error_message = "AKS NSG Internet ingress must target the ingress public IP (LB floating IP)"
  }

  assert {
    condition     = module.keyvault.secret_officer_principal_types == { "sp/88888888-8888-8888-8888-888888888888" = "ServicePrincipal", "user/99999999-9999-9999-9999-999999999999" = "User" }
    error_message = "KV officer grants must carry principal_type ServicePrincipal/User"
  }
}

run "prod_cidrs" {
  command = plan

  variables {
    env       = "prod"
    vnet_cidr = "10.30.0.0/16"
    subnet_cidrs = {
      aks  = "10.30.0.0/20"
      psql = "10.30.16.0/24"
      pe   = "10.30.17.0/24"
    }
  }

  assert {
    condition     = module.keyvault.name == "kv-bbm-prd-a1b2" && module.storage.name == "stbbmprda1b2" && output.psql_subnet_cidr == "10.30.16.0/24"
    error_message = "prod names/CIDRs wrong"
  }
}

# test: no PG server, two public zones (CI runs + PR previews).
run "test_env_without_postgres" {
  command = apply

  variables {
    env              = "test"
    postgres_enabled = false
    vnet_cidr        = "10.10.0.0/16"
    subnet_cidrs = {
      aks  = "10.10.0.0/20"
      psql = "10.10.16.0/24"
      pe   = "10.10.17.0/24"
    }
  }

  assert {
    condition     = length(module.postgres) == 0 && output.pg_fqdn == null && output.pg_server_name == null && !output.postgres_enabled
    error_message = "test must not create a PG server"
  }

  assert {
    condition     = length(module.keyvault.secret_names) == 0 && module.keyvault.name == "kv-bbm-tst-a1b2"
    error_message = "test KV must not hold database-url / pg-admin-password"
  }

  assert {
    condition     = !module.network.psql_delegated && module.network.postgres_private_dns_zone_id == null && output.psql_subnet_cidr == "10.10.16.0/24"
    error_message = "without PG: plain psql subnet, no PG private zone, CIDR still exported"
  }

  assert {
    condition     = length(azurerm_private_dns_cname_record.postgres) == 0 && azurerm_private_dns_zone.internal.name == "test.internal.bbm.example.com"
    error_message = "test internal zone must exist without a postgres CNAME"
  }

  assert {
    condition = (
      output.dns_zone_names == tolist(["test.bbm.example.com", "preview.bbm.example.com"]) &&
      toset(keys(azurerm_dns_a_record.ingress)) == toset([
        "@.test.bbm.example.com", "*.test.bbm.example.com",
        "@.preview.bbm.example.com", "*.preview.bbm.example.com",
      ])
    )
    error_message = "test must serve apex + wildcard in test.<zone> and preview.<zone>"
  }

  assert {
    condition = (
      toset(keys(module.identity.role_assignment_ids)) == toset([
        "api-kv-secrets-user", "api-sources-blob-contributor", "api-queue-sender",
        "worker-kv-secrets-user", "worker-queue-processor", "worker-queue-reader", "worker-sources-blob-reader",
        "aks-network-contributor", "certmgr-dns-test", "certmgr-dns-preview",
      ])
    )
    error_message = "certmgr needs DNS Zone Contributor on both test zones"
  }

  assert {
    condition     = output.uami.certmgr.client_id != "" && output.resource_group_name != ""
    error_message = "certmgr identity output missing"
  }
}

run "rejects_preview_env" {
  command = plan

  variables {
    env = "preview"
  }

  expect_failures = [var.env]
}

# One region per env (ADR 0002 section 8): staging in francecentral. Region
# codes appear only in the RG / VNet / PG / LAW names; Key Vault and storage
# names carry none, so they are the same in every region.
run "env_in_its_own_region" {
  command = plan

  variables {
    location          = "francecentral"
    location_abbr     = "frc"
    ingress_pip_zones = ["1", "2", "3"]
  }

  assert {
    condition = (
      data.azurerm_resource_group.data.name == "rg-bbm-staging-data-frc" &&
      module.network.vnet_name == "vnet-bbm-staging-frc" &&
      module.postgres[0].name == "psql-bbm-staging-frc" &&
      module.law.name == "log-bbm-staging-frc" &&
      module.keyvault.name == "kv-bbm-stg-a1b2" &&
      module.storage.name == "stbbmstga1b2" &&
      azurerm_public_ip.ingress.name == "pip-bbm-staging-ingress" &&
      azurerm_public_ip.ingress.location == "francecentral" &&
      azurerm_public_ip.ingress.zones == toset(["1", "2", "3"])
    )
    error_message = "env names and placement must follow the env's own region"
  }
}

# The test env stays in the home region with its already-applied names.
run "test_env_keeps_ncus_names" {
  command = plan

  variables {
    env               = "test"
    postgres_enabled  = false
    location          = "northcentralus"
    location_abbr     = "ncus"
    ingress_pip_zones = []
    vnet_cidr         = "10.10.0.0/16"
    subnet_cidrs = {
      aks  = "10.10.0.0/20"
      psql = "10.10.16.0/24"
      pe   = "10.10.17.0/24"
    }
  }

  assert {
    condition = (
      data.azurerm_resource_group.data.name == "rg-bbm-test-data-ncus" &&
      module.network.vnet_name == "vnet-bbm-test-ncus" &&
      module.law.name == "log-bbm-test-ncus" &&
      module.keyvault.name == "kv-bbm-tst-a1b2" &&
      module.storage.name == "stbbmtsta1b2" &&
      azurerm_public_ip.ingress.name == "pip-bbm-test-ingress"
    )
    error_message = "test names must not change"
  }
}
