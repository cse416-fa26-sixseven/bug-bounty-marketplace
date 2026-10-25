variable "subscription_id" {
  description = "Target Azure subscription GUID."
  type        = string
}

variable "env" {
  description = "Environment: test, staging or prod."
  type        = string

  validation {
    condition     = contains(["test", "staging", "prod"], var.env)
    error_message = "env must be test, staging or prod."
  }
}

variable "location" {
  description = "Azure region (full name), e.g. northcentralus. infra/up.sh --location writes it into every tfvars."
  type        = string
  default     = "northcentralus"
}

variable "location_abbr" {
  description = "Short region code used in names (e.g. ncus). Null derives it from location (modules/naming local.location_abbrs)."
  type        = string
  default     = null
}

variable "tfstate_resource_group" {
  description = "Resource group of the Terraform state account (for terraform_remote_state). CI sets TF_VAR_tfstate_resource_group from the TFSTATE_RG repo variable."
  type        = string
  default     = "rg-bbm-tfstate-ncus"
}

variable "tfstate_account" {
  description = "Terraform state storage account (stbbmtfstate<sfx>). CI sets TF_VAR_tfstate_account from the TFSTATE_ACCOUNT repo variable."
  type        = string
}

variable "tfstate_container" {
  description = "Blob container holding Terraform state."
  type        = string
  default     = "tfstate"
}

variable "kubernetes_version" {
  description = "Kubernetes minor version, e.g. \"1.33\". Pick a GA, non-LTS-only version from `az aks get-versions -l <location> -o table`."
  type        = string
}

variable "aks_sku_tier" {
  description = "AKS control-plane tier: Free, or Standard (uptime SLA, prod only)."
  type        = string
  default     = "Free"

  validation {
    condition     = contains(["Free", "Standard"], var.aks_sku_tier)
    error_message = "aks_sku_tier must be Free or Standard."
  }
}

variable "system_vm_size" {
  description = "VM size of the system node pool."
  type        = string
  default     = "Standard_B2als_v2"
}

variable "system_min_count" {
  description = "Minimum nodes in the system pool."
  type        = number
  default     = 1
}

variable "system_max_count" {
  description = "Maximum nodes in the system pool."
  type        = number
  default     = 2
}

variable "system_only_critical_addons" {
  description = "Taint the system pool CriticalAddonsOnly (true when a separate apps pool runs workloads)."
  type        = bool
  default     = false
}

variable "apps_pool_enabled" {
  description = "Create the `apps` user node pool (label bbm.io/pool=apps)."
  type        = bool
  default     = false
}

variable "apps_vm_size" {
  description = "VM size of the apps node pool."
  type        = string
  default     = "Standard_B2als_v2"
}

variable "apps_min_count" {
  description = "Minimum nodes in the apps pool."
  type        = number
  default     = 0
}

variable "apps_max_count" {
  description = "Maximum nodes in the apps pool."
  type        = number
  default     = 3
}

variable "sandbox_pool_enabled" {
  description = "Create the Kata `sandbox` node pool (needs Dsv5 quota)."
  type        = bool
  default     = false
}

variable "sandbox_vm_size" {
  description = "VM size of the sandbox pool (must support nested virtualisation)."
  type        = string
  default     = "Standard_D2s_v5"
}

variable "sandbox_max_count" {
  description = "Maximum nodes in the sandbox pool (minimum is 0)."
  type        = number
  default     = 1
}

variable "container_insights" {
  description = "Enable Container Insights to the env Log Analytics workspace."
  type        = bool
  default     = false
}

variable "automatic_upgrade_channel" {
  description = "AKS auto-upgrade channel (modules/aks). Set \"none\" while the subscription's vCPU quota is full."
  type        = string
  default     = "patch"
}

variable "node_os_upgrade_channel" {
  description = "Node OS upgrade channel (modules/aks). Set \"None\" while the subscription's vCPU quota is full."
  type        = string
  default     = "NodeImage"
}
