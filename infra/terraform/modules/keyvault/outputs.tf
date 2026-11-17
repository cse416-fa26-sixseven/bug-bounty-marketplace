output "id" {
  description = "Key Vault resource ID."
  value       = azurerm_key_vault.this.id
}

output "name" {
  description = "Key Vault name."
  value       = azurerm_key_vault.this.name
}

output "vault_uri" {
  description = "Key Vault data-plane URI."
  value       = azurerm_key_vault.this.vault_uri
}

output "secret_names" {
  description = "Names of the Terraform-managed secrets."
  value       = sort(keys(azurerm_key_vault_secret.managed))
}

output "rbac_authorization_enabled" {
  description = "Whether the vault uses Azure RBAC for data-plane access (always true)."
  value       = azurerm_key_vault.this.rbac_authorization_enabled
}

output "secret_officer_principal_types" {
  description = "Secrets Officer grants made by this module (sp/<id> or user/<id> => principal_type)."
  value       = { for k, ra in azurerm_role_assignment.secrets_officer : k => ra.principal_type }
}

output "managed_secret_scopes" {
  description = "ARM scope (<vault id>/secrets/<name>) of each Terraform-managed secret, for secret-scoped role assignments. Built from the secret resources, so a grant on one is created only after the secret exists."
  value       = { for k, s in azurerm_key_vault_secret.managed : k => "${azurerm_key_vault.this.id}/secrets/${s.name}" }
}
