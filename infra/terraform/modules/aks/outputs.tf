output "id" {
  description = "Cluster resource ID."
  value       = azurerm_kubernetes_cluster.this.id
}

output "name" {
  description = "Cluster name."
  value       = azurerm_kubernetes_cluster.this.name
}

output "oidc_issuer_url" {
  description = "OIDC issuer URL for workload identity federation. Changes when the cluster is recreated."
  value       = azurerm_kubernetes_cluster.this.oidc_issuer_url
}

output "sku_tier" {
  description = "AKS control-plane tier (Free or Standard)."
  value       = azurerm_kubernetes_cluster.this.sku_tier
}

output "kubernetes_version" {
  description = "Kubernetes version currently running (including patch)."
  value       = azurerm_kubernetes_cluster.this.current_kubernetes_version
}

output "node_resource_group" {
  description = "AKS-managed node resource group name."
  value       = azurerm_kubernetes_cluster.this.node_resource_group
}

output "kubelet_identity_principal_id" {
  description = "Principal ID of the kubelet identity (has Container Registry Repository Reader on the ACR)."
  value       = azurerm_user_assigned_identity.kubelet.principal_id
}

output "ingress_profile" {
  description = "Requested ingress settings (azapi): Managed Gateway API installation and the app routing Gateway API implementation (GatewayClass approuting-istio)."
  value = {
    gateway_api_installation = azapi_update_resource.app_routing_gateway_api.body.properties.ingressProfile.gatewayAPI.installation
    app_routing_istio_mode   = azapi_update_resource.app_routing_gateway_api.body.properties.ingressProfile.webAppRouting.gatewayAPIImplementations.appRoutingIstio.mode
    web_app_routing_nginx    = length(azurerm_kubernetes_cluster.this.web_app_routing) > 0
  }
}

output "node_pools" {
  description = "Names of the node pools that exist (system plus enabled user pools)."
  value = concat(
    ["system"],
    [for p in azurerm_kubernetes_cluster_node_pool.apps : p.name],
    [for p in azurerm_kubernetes_cluster_node_pool.sandbox : p.name],
  )
}

output "network_profile" {
  description = "Effective network settings (plugin, mode, data plane, policy, outbound type)."
  value = {
    network_plugin      = azurerm_kubernetes_cluster.this.network_profile[0].network_plugin
    network_plugin_mode = azurerm_kubernetes_cluster.this.network_profile[0].network_plugin_mode
    network_data_plane  = azurerm_kubernetes_cluster.this.network_profile[0].network_data_plane
    network_policy      = azurerm_kubernetes_cluster.this.network_profile[0].network_policy
    outbound_type       = azurerm_kubernetes_cluster.this.network_profile[0].outbound_type
  }
}

output "security" {
  description = "Identity/auth posture: OIDC issuer, workload identity, local accounts, Azure RBAC."
  value = {
    oidc_issuer_enabled       = azurerm_kubernetes_cluster.this.oidc_issuer_enabled
    workload_identity_enabled = azurerm_kubernetes_cluster.this.workload_identity_enabled
    local_account_disabled    = azurerm_kubernetes_cluster.this.local_account_disabled
    azure_rbac_enabled        = azurerm_kubernetes_cluster.this.azure_active_directory_role_based_access_control[0].azure_rbac_enabled
  }
}

output "container_insights_enabled" {
  description = "Whether the Container Insights add-on and its data collection rule are configured."
  value       = length(azurerm_kubernetes_cluster.this.oms_agent) > 0 && length(azurerm_monitor_data_collection_rule_association.container_insights) > 0
}

output "keda_enabled" {
  description = "Whether the KEDA add-on is enabled."
  value       = try(azurerm_kubernetes_cluster.this.workload_autoscaler_profile[0].keda_enabled, false)
}

output "upgrades" {
  description = "Upgrade posture: the planned upgrade channels (automatic_upgrade_channel is null when off) and how many maintenance-window blocks are configured."
  value = {
    automatic_upgrade_channel       = azurerm_kubernetes_cluster.this.automatic_upgrade_channel
    node_os_upgrade_channel         = azurerm_kubernetes_cluster.this.node_os_upgrade_channel
    maintenance_window_auto_upgrade = length(azurerm_kubernetes_cluster.this.maintenance_window_auto_upgrade)
    maintenance_window_node_os      = length(azurerm_kubernetes_cluster.this.maintenance_window_node_os)
  }
}
