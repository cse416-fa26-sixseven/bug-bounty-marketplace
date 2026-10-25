data "azurerm_client_config" "current" {}

data "azurerm_subscription" "current" {}

resource "random_string" "suffix" {
  length  = 4
  upper   = false
  special = false
  numeric = true
}

module "naming" {
  source = "../../modules/naming"

  env           = "global"
  layer         = "global"
  location      = var.location
  location_abbr = var.location_abbr
  suffix        = random_string.suffix.result
  repo          = var.github_repo
}

module "naming_env" {
  source   = "../../modules/naming"
  for_each = toset(local.persistent_envs)

  env           = each.key
  location      = var.location
  location_abbr = var.location_abbr
  suffix        = random_string.suffix.result
  dns_zone_name = var.dns_zone_name
  repo          = var.github_repo
}

locals {
  # Every AKS env (data + compute RGs, CI identity, budgets). test also hosts
  # the ephemeral CI-run / PR-preview namespaces (ADR 0002).
  persistent_envs = ["test", "staging", "prod"]

  subscription_scope = data.azurerm_subscription.current.id

  resource_providers = toset([
    "Microsoft.ContainerService",
    "Microsoft.DBforPostgreSQL",
    "Microsoft.OperationalInsights",
    "Microsoft.KeyVault",
    "Microsoft.ContainerRegistry",
    "Microsoft.Storage",
    "Microsoft.Network",
    "Microsoft.ManagedIdentity",
    "Microsoft.Compute",
    # Azure lists this namespace in lowercase, and the azurerm provider check
    # is case-sensitive ("Microsoft.Insights" fails the plan).
    "microsoft.insights",
    "Microsoft.OperationsManagement",
    "Microsoft.AlertsManagement",
    "Microsoft.Consumption",
    "Microsoft.CostManagement",
  ])
}

# ---- resource providers -----------------------------------------------------
# The provider block uses resource_provider_registrations = "none", so the
# namespaces we need are registered explicitly. On a subscription where some are
# already registered, list them in var.preregistered_resource_providers (they
# get imported), or import by hand:
#   terraform import 'azurerm_resource_provider_registration.this["Microsoft.Network"]' \
#     /subscriptions/<sub>/providers/Microsoft.Network
import {
  for_each = setintersection(toset(var.preregistered_resource_providers), local.resource_providers)
  to       = azurerm_resource_provider_registration.this[each.key]
  id       = "/subscriptions/${var.subscription_id}/providers/${each.key}"
}

resource "azurerm_resource_provider_registration" "this" {
  for_each = local.resource_providers
  name     = each.key
}

# ---- long-lived resource groups --------------------------------------------
resource "azurerm_resource_group" "shared" {
  name     = module.naming.global.shared_resource_group
  location = var.location
  tags     = module.naming.tags
}

# Data RGs carry live power state as tags, mutated by scripts/env-power.sh and
# workflows — Terraform sets the initial values and then ignores them.
resource "azurerm_resource_group" "env_data" {
  for_each = module.naming_env

  name     = each.value.env.data_resource_group
  location = var.location
  tags = merge(each.value.tags_by_layer.data, {
    "power-state" = "down"
    "auto-pause"  = "true"
  })

  lifecycle {
    ignore_changes = [
      # Keep in sync with docs/devops/env-lifecycle.md ("Terraform ignores
      # these tags").
      tags["power-state"],
      tags["auto-pause"],
      tags["db-paused"],
      tags["bbm-last-deployed-tag"],
      tags["paused-at"],
      tags["resumed-at"],
      tags["down-at"],
      tags["up-at"],
      tags["deployed-at"],
    ]
  }
}

resource "azurerm_resource_group" "env_compute" {
  for_each = module.naming_env

  name     = each.value.env.compute_resource_group
  location = var.location
  tags     = each.value.tags_by_layer.compute
}

# ---- subscription budget ----------------------------------------------------
module "subscription_budget" {
  source = "../../modules/budget"

  name            = "budget-bbm-subscription"
  subscription_id = var.subscription_id
  amount          = var.subscription_budget_amount
  start_date      = var.budget_start_date
  alert_emails    = var.alert_emails

  depends_on = [azurerm_resource_provider_registration.this]
}
