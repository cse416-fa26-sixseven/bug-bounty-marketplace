output "suffix" {
  description = "The suffix the names were built with."
  value       = var.suffix
}

output "location" {
  description = "Azure region (full name)."
  value       = var.location
}

output "location_abbr" {
  description = "Short region code the names were built with (var.location_abbr, or derived from var.location)."
  value       = local.loc
}

output "global" {
  description = "Names of global/shared resources (tfstate, shared RG, ACR, shared LAW/KV)."
  value       = local.global
}

output "env" {
  description = "Names of per-environment resources for var.env (data/compute RGs, VNet, PG, KV, storage, LAW, PIP, AKS)."
  value       = local.env
}

output "uamis" {
  description = "Per-environment user-assigned managed identity names keyed by role (aks, api, worker, sandbox, certmgr)."
  value       = local.uamis
}

output "env_short" {
  description = "Short environment code used in length-limited names (tst, stg, prd, glb)."
  value       = local.env_short
}

output "dns" {
  description = "DNS names for var.env from var.dns_zone_name: zone, env_labels, env_zones (test: test.<zone> + preview.<zone>), host (first env zone), internal_zone (<env>.internal.<zone>). Empty/null when dns_zone_name is null."
  value       = local.dns
}

output "tags" {
  description = "Standard tags for var.layer."
  value       = local.tags_by_layer[var.layer]
}

output "tags_by_layer" {
  description = "Standard tags for every layer (global, data, compute), for stacks that span layers."
  value       = local.tags_by_layer
}
