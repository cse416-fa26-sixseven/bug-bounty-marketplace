# Shared, long-lived resources used by every environment: container registry,
# shared Log Analytics and the shared Key Vault.
# The resource groups themselves are owned by stacks/bootstrap.

data "azurerm_client_config" "current" {}

module "naming" {
  source = "../../modules/naming"

  env           = "global"
  layer         = "global"
  location      = var.location
  location_abbr = var.location_abbr
  suffix        = var.suffix
}

module "naming_env" {
  source   = "../../modules/naming"
  for_each = toset(["test", "staging", "prod"])

  env           = each.key
  location      = var.location
  location_abbr = var.location_abbr
  suffix        = var.suffix
}

data "azurerm_resource_group" "shared" {
  name = module.naming.global.shared_resource_group
}

locals {
  tags = module.naming.tags
}

module "acr" {
  source = "../../modules/acr"

  name                = module.naming.global.acr
  resource_group_name = data.azurerm_resource_group.shared.name
  location            = var.location
  tags                = local.tags
}

module "law" {
  source = "../../modules/observability"

  name                = module.naming.global.shared_log_analytics
  resource_group_name = data.azurerm_resource_group.shared.name
  location            = var.location
  daily_quota_gb      = var.law_daily_quota_gb
  retention_in_days   = 30
  tags                = local.tags
}
