# Per-RG budgets for the test/staging/prod resource groups (created by
# stacks/bootstrap). The subscription-wide budget lives in bootstrap.

data "azurerm_resource_group" "env" {
  for_each = merge([
    for env, n in module.naming_env : {
      "${env}-data"    = n.env.data_resource_group
      "${env}-compute" = n.env.compute_resource_group
    }
  ]...)

  name = each.value
}

module "rg_budget" {
  source   = "../../modules/budget"
  for_each = data.azurerm_resource_group.env

  name              = "budget-${each.value.name}"
  resource_group_id = each.value.id
  amount            = var.rg_budget_amount
  start_date        = var.budget_start_date
  alert_emails      = var.alert_emails
}
