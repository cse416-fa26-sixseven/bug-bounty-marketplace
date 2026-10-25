variable "name" {
  description = "Cluster name (aks-bbm-<env>-eus2)."
  type        = string
}

variable "dns_prefix" {
  description = "DNS prefix for the API server FQDN."
  type        = string
}

variable "resource_group_name" {
  description = "Existing resource group for the cluster (rg-bbm-<env>-compute-eus2)."
  type        = string
}

variable "node_resource_group_name" {
  description = "Name of the AKS-managed node resource group (rg-bbm-<env>-aksnodes-eus2). AKS creates and deletes it."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "kubernetes_version" {
  description = "Kubernetes minor version (e.g. \"1.33\"). The patch auto-upgrade channel keeps the patch level current. List GA versions with `az aks get-versions -l eastus2 -o table`."
  type        = string

  validation {
    condition     = can(regex("^1\\.[0-9]+$", var.kubernetes_version))
    error_message = "kubernetes_version must be a minor version like \"1.33\" (no patch), so the patch upgrade channel does not cause drift."
  }
}

variable "sku_tier" {
  description = "AKS control-plane tier: Free (no SLA) or Standard (uptime SLA; prod only, ADR 0002)."
  type        = string
  default     = "Free"

  validation {
    condition     = contains(["Free", "Standard"], var.sku_tier)
    error_message = "sku_tier must be Free or Standard."
  }
}

variable "tenant_id" {
  description = "Entra tenant for AKS-managed Entra ID integration with Azure RBAC."
  type        = string
}

variable "cluster_identity_id" {
  description = "Resource ID of the user-assigned identity for the control plane (id-bbm-<env>-aks). It needs Network Contributor on the subnet / data RG (granted by the data stack)."
  type        = string
}

variable "cluster_identity_principal_id" {
  description = "Principal (object) ID of the control-plane identity; gets Managed Identity Operator on the kubelet identity."
  type        = string
}

variable "kubelet_identity_name" {
  description = "Name of the kubelet user-assigned identity created in resource_group_name."
  type        = string
}

variable "subnet_id" {
  description = "Subnet ID for the nodes (snet-aks). Pods use the overlay CIDR, not this subnet."
  type        = string
}

variable "pod_cidr" {
  description = "Overlay pod CIDR. Must not overlap the VNet or service CIDR."
  type        = string
  default     = "192.168.0.0/16"
}

variable "service_cidr" {
  description = "Kubernetes service CIDR. Must not overlap the VNet."
  type        = string
  default     = "172.16.0.0/16"
}

variable "dns_service_ip" {
  description = "Cluster DNS service IP (inside service_cidr)."
  type        = string
  default     = "172.16.0.10"
}

variable "acr_id" {
  description = "Container registry ID; the kubelet identity gets Container Registry Repository Reader on it."
  type        = string
}

variable "container_insights_enabled" {
  description = "Enable the Container Insights (oms_agent) add-on with a data collection rule to log_analytics_workspace_id."
  type        = bool
  default     = false
}

variable "log_analytics_workspace_id" {
  description = "Log Analytics workspace ARM ID for Container Insights. Required when container_insights_enabled."
  type        = string
  default     = null

  validation {
    condition     = !var.container_insights_enabled || var.log_analytics_workspace_id != null
    error_message = "log_analytics_workspace_id is required when container_insights_enabled is true."
  }
}

variable "system_pool" {
  description = "Default (system) node pool sizing. only_critical_addons_enabled taints it CriticalAddonsOnly so app pods land on the apps pool."
  type = object({
    vm_size                      = optional(string, "Standard_B2als_v2")
    min_count                    = optional(number, 1)
    max_count                    = optional(number, 2)
    only_critical_addons_enabled = optional(bool, false)
    os_disk_size_gb              = optional(number, 64)
  })
  default = {}

  validation {
    condition     = var.system_pool.min_count >= 1 && var.system_pool.max_count >= var.system_pool.min_count
    error_message = "system_pool needs min_count >= 1 and max_count >= min_count."
  }
}

variable "apps_pool" {
  description = "Optional user node pool `apps` (label bbm.io/pool=apps)."
  type = object({
    enabled         = optional(bool, false)
    vm_size         = optional(string, "Standard_B2als_v2")
    min_count       = optional(number, 0)
    max_count       = optional(number, 3)
    os_disk_size_gb = optional(number, 64)
  })
  default = {}

  validation {
    condition     = var.apps_pool.min_count >= 0 && var.apps_pool.max_count >= max(1, var.apps_pool.min_count)
    error_message = "apps_pool needs min_count >= 0 and max_count >= max(1, min_count)."
  }
}

variable "sandbox_pool" {
  description = "Optional Kata VM-isolated user node pool `sandbox` (label bbm.io/pool=sandbox, taint bbm.io/sandbox=true:NoSchedule). VM size must support nested virtualisation (Dsv5)."
  type = object({
    enabled         = optional(bool, false)
    vm_size         = optional(string, "Standard_D2s_v5")
    min_count       = optional(number, 0)
    max_count       = optional(number, 1)
    os_disk_size_gb = optional(number, 64)
  })
  default = {}

  validation {
    condition     = var.sandbox_pool.min_count >= 0 && var.sandbox_pool.max_count >= max(1, var.sandbox_pool.min_count)
    error_message = "sandbox_pool needs min_count >= 0 and max_count >= max(1, min_count)."
  }
}

variable "tags" {
  description = "Tags applied to the cluster, node pools and DCR."
  type        = map(string)
  default     = {}
}

variable "rbac_propagation_wait" {
  description = "How long to wait after the Managed Identity Operator / registry pull grants before creating the cluster (RBAC propagation)."
  type        = string
  default     = "90s"
}
