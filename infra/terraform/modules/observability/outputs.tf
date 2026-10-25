output "id" {
  description = "Workspace ARM resource ID."
  value       = azurerm_log_analytics_workspace.this.id
}

output "workspace_id" {
  description = "Workspace (customer) GUID used by monitoring agents."
  value       = azurerm_log_analytics_workspace.this.workspace_id
}

output "name" {
  description = "Workspace name."
  value       = azurerm_log_analytics_workspace.this.name
}
