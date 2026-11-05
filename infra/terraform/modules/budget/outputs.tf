output "id" {
  description = "Budget resource ID."
  value       = local.rg_scoped ? azurerm_consumption_budget_resource_group.this[0].id : azurerm_consumption_budget_subscription.this[0].id
}

output "filter_resource_group_names" {
  description = "Resource groups a subscription budget is limited to (empty = whole subscription)."
  value       = var.filter_resource_group_names
}
