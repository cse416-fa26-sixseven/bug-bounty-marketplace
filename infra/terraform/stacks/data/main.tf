# Persistent per-env data layer for test/staging/prod: VNet, PostgreSQL (not in
# test), Key Vault, storage, managed identities, ingress public IP, env Log
# Analytics and the env's DNS records (dns.tf).
# Everything here survives `compute` destroy/apply (down/up). The resource
# group itself is owned by stacks/bootstrap (which also ignores the
# power-state / bbm-last-deployed-tag / auto-pause tags on it).

data "azurerm_client_config" "current" {}

# Global outputs (dns_zone_name) so the env tfvars stay minimal.
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

module "naming" {
  source = "../../modules/naming"

  env           = var.env
  layer         = "data"
  location      = var.location
  location_abbr = var.location_abbr
  suffix        = var.suffix
  dns_zone_name = data.terraform_remote_state.global.outputs.dns_zone_name
}

data "azurerm_resource_group" "data" {
  name = module.naming.env.data_resource_group
}

locals {
  n    = module.naming.env
  dns  = module.naming.dns
  tags = module.naming.tags
  rg   = data.azurerm_resource_group.data.name
}

module "network" {
  source = "../../modules/network"

  name                = local.n.vnet
  resource_group_name = local.rg
  location            = var.location
  address_space       = var.vnet_cidr
  subnets = {
    aks  = { name = local.n.subnet_aks, cidr = var.subnet_cidrs.aks }
    psql = { name = local.n.subnet_psql, cidr = var.subnet_cidrs.psql }
    pe   = { name = local.n.subnet_pe, cidr = var.subnet_cidrs.pe }
  }
  postgres_enabled = var.postgres_enabled
  # VNet-integrated flexible servers need a zone ending in
  # .postgres.database.azure.com (privatelink.* is for private endpoints).
  postgres_private_dns_zone_name = "${var.env}.private.postgres.database.azure.com"
  # NSG Internet-ingress destination (AKS LB floating IP, see the module).
  ingress_public_ip = azurerm_public_ip.ingress.ip_address
  tags              = local.tags
}

# Not in test: CI-run / PR-preview namespaces run in-cluster Postgres.
module "postgres" {
  source = "../../modules/postgres-flexible"
  count  = var.postgres_enabled ? 1 : 0

  name                  = local.n.postgres_server
  resource_group_name   = local.rg
  location              = var.location
  delegated_subnet_id   = module.network.subnet_ids.psql
  private_dns_zone_id   = module.network.postgres_private_dns_zone_id
  sku_name              = var.postgres_sku_name
  postgres_version      = "16"
  storage_mb            = var.postgres_storage_mb
  backup_retention_days = var.postgres_backup_retention_days
  administrator_login   = "bbmadmin"
  database_name         = local.n.postgres_database
  tags                  = local.tags
}

module "keyvault" {
  source = "../../modules/keyvault"

  name                           = local.n.key_vault
  resource_group_name            = local.rg
  location                       = var.location
  tenant_id                      = data.azurerm_client_config.current.tenant_id
  secret_officer_sp_object_ids   = var.secret_officer_sp_object_ids
  secret_officer_user_object_ids = var.secret_officer_user_object_ids
  # CI writes these as gh-bbm-<env>, which has Key Vault Secrets Officer on
  # the data RG (stacks/bootstrap identities.tf, key data-kv-secrets). A human
  # applying locally must be in secret_officer_user_object_ids (applied
  # locally by an Owner, since CI may only grant roles to service principals).
  # Both values are generated here and therefore live in <env>/data.tfstate.
  # llm-api-key is set out of band (az keyvault secret set), never by Terraform.
  secrets = var.postgres_enabled ? {
    "database-url"      = module.postgres[0].database_url
    "pg-admin-password" = module.postgres[0].administrator_password
  } : {}
  tags = local.tags
}

module "storage" {
  source = "../../modules/storage"

  name                = local.n.storage_account
  resource_group_name = local.rg
  location            = var.location
  container_name      = local.n.storage_container
  queue_name          = local.n.storage_queue
  tags                = local.tags
}

module "law" {
  source = "../../modules/observability"

  name                = local.n.log_analytics
  resource_group_name = local.rg
  location            = var.location
  daily_quota_gb      = var.law_daily_quota_gb
  retention_in_days   = 30
  tags                = local.tags
}

# Static ingress IP. Lives here (not in compute) so the IP and DNS name survive
# compute down/up. The LoadBalancer Service of the bbm-platform Gateway (AKS
# app routing Gateway API) binds it by name (azure-pip-name +
# azure-load-balancer-resource-group in the Gateway's
# spec.infrastructure.annotations), which is why the AKS cluster identity gets
# Network Contributor on this RG.
resource "azurerm_public_ip" "ingress" {
  name                = local.n.ingress_public_ip
  resource_group_name = local.rg
  location            = var.location
  sku                 = "Standard"
  allocation_method   = "Static"
  zones               = var.ingress_pip_zones
  domain_name_label   = local.n.ingress_dns_label
  tags                = local.tags
}
