output "id" {
  description = "Registry resource ID."
  value       = azurerm_container_registry.this.id
}

output "name" {
  description = "Registry name."
  value       = azurerm_container_registry.this.name
}

output "login_server" {
  description = "Registry login server (<name>.azurecr.io)."
  value       = azurerm_container_registry.this.login_server
}

output "sku" {
  description = "Registry SKU."
  value       = azurerm_container_registry.this.sku
}

output "role_assignment_mode" {
  description = "Role assignment permissions mode (AbacRepositoryPermissions: only the Container Registry Repository roles grant data access)."
  value       = azurerm_container_registry.this.role_assignment_mode
}
