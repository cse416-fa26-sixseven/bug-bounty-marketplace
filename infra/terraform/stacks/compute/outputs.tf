output "cluster_name" {
  description = "AKS cluster name."
  value       = module.aks.name
}

output "cluster_id" {
  description = "AKS cluster resource ID."
  value       = module.aks.id
}

output "resource_group_name" {
  description = "Resource group holding the cluster."
  value       = data.azurerm_resource_group.compute.name
}

output "node_resource_group" {
  description = "AKS-managed node resource group."
  value       = module.aks.node_resource_group
}

output "sku_tier" {
  description = "AKS control-plane tier (Free or Standard)."
  value       = module.aks.sku_tier
}

output "oidc_issuer_url" {
  description = "Cluster OIDC issuer URL."
  value       = module.aks.oidc_issuer_url
}

output "kube_version" {
  description = "Running Kubernetes version (with patch)."
  value       = module.aks.kubernetes_version
}

output "node_pools" {
  description = "Node pools that exist."
  value       = module.aks.node_pools
}

output "federated_subjects" {
  description = "Service-account subjects federated to the env identities."
  value       = module.workload_identity.subjects
}

output "helm_values" {
  description = "values-infra.yaml for deploy/helm/bbm (write with `terraform output -raw helm_values`)."
  value       = yamlencode(local.helm_values)
}
