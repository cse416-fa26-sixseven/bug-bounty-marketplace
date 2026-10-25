output "suffix" {
  description = "Random 4-char suffix for globally unique names. Pass to other stacks (envs/*/*.tfvars: suffix)."
  value       = random_string.suffix.result
}

output "tenant_id" {
  description = "Entra tenant ID."
  value       = data.azurerm_client_config.current.tenant_id
}

output "subscription_id" {
  description = "Subscription GUID."
  value       = var.subscription_id
}

output "location" {
  description = "Azure region."
  value       = var.location
}

output "tfstate_resource_group" {
  description = "State resource group (backend resource_group_name)."
  value       = azurerm_resource_group.tfstate.name
}

output "tfstate_storage_account" {
  description = "State storage account (backend storage_account_name / TFSTATE_ACCOUNT)."
  value       = azurerm_storage_account.tfstate.name
}

output "tfstate_container" {
  description = "State container (backend container_name)."
  value       = azurerm_storage_container.tfstate.name
}

output "resource_groups" {
  description = "Long-lived resource group names keyed by purpose."
  value = merge(
    { shared = azurerm_resource_group.shared.name, tfstate = azurerm_resource_group.tfstate.name },
    { for k, v in azurerm_resource_group.env_data : "${k}-data" => v.name },
    { for k, v in azurerm_resource_group.env_compute : "${k}-compute" => v.name },
  )
}

output "github_client_ids" {
  description = "AZURE_CLIENT_ID per OIDC identity."
  value       = module.github_oidc.client_ids
}

output "github_principal_ids" {
  description = "Service principal object ID per OIDC identity (stacks/global needs gh-bbm-global, gh-bbm-ephemeral and gh-bbm-preview)."
  value       = module.github_oidc.principal_ids
}

output "power_operator_role_definition_id" {
  description = "Resource ID of the custom 'BBM Power Operator' role."
  value       = azurerm_role_definition.power_operator.role_definition_resource_id
}

output "dns_zone_name" {
  description = "Parent DNS zone (in the shared RG)."
  value       = azurerm_dns_zone.parent.name
}

output "dns_name_servers" {
  description = "Name servers of the parent zone: add these as NS records for dns_zone_name at the domain's DNS host (infra/up.sh does it for Cloudflare)."
  value       = sort(tolist(azurerm_dns_zone.parent.name_servers))
}

output "dns_child_zones" {
  description = "Delegated child zones per env (test: test.<zone>, preview.<zone>), each in that env's data RG."
  value = {
    for env in local.persistent_envs : env => [
      for label, z in local.dns_child_zones : azurerm_dns_zone.child[label].name if z.env == env
    ]
  }
}

# Pasted verbatim between the bootstrap-hint markers in envs/global/global.tfvars
# by infra/up.sh. Keep the `=` aligned so the file stays `terraform fmt` clean.
output "global_tfvars_hint" {
  description = "Values for the bootstrap-hint block of envs/global/global.tfvars."
  value       = <<-EOT
    subscription_id              = "${var.subscription_id}"
    suffix                       = "${random_string.suffix.result}"
    ephemeral_ci_principal_id    = "${module.github_oidc.principal_ids["gh-bbm-ephemeral"]}"
    preview_ci_principal_id      = "${module.github_oidc.principal_ids["gh-bbm-preview"]}"
    secret_officer_sp_object_ids = ["${module.github_oidc.principal_ids["gh-bbm-global"]}"]
    dns_zone_name                = "${var.dns_zone_name}"
  EOT
}

output "gh_setup_commands" {
  description = "Shell commands that create the GitHub repo variables and Environments for this subscription. Review, then run with an authenticated gh CLI (repo admin)."
  value       = join("\n", concat(local.gh_header_lines, local.gh_repo_lines, local.gh_env_lines, [""]))
}
