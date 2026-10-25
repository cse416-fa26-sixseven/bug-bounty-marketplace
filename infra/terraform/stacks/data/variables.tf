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
  description = "Region of this env (full name), e.g. northcentralus. infra/up.sh --env-location <env>=<region> writes it into the env's data and compute tfvars."
  type        = string
  default     = "northcentralus"
}

variable "location_abbr" {
  description = "Short region code used in names (e.g. ncus). Null derives it from location (modules/naming local.location_abbrs)."
  type        = string
  default     = null
}

variable "suffix" {
  description = "4-char suffix from the bootstrap output `suffix` (same value as envs/global/global.tfvars)."
  type        = string
}

variable "tfstate_resource_group" {
  description = "Resource group of the Terraform state account (for terraform_remote_state). tf.sh sets TF_VAR_tfstate_resource_group from TFSTATE_RG."
  type        = string
  default     = "rg-bbm-tfstate-ncus"
}

variable "tfstate_account" {
  description = "Terraform state storage account (stbbmtfstate<sfx>) holding global.tfstate. tf.sh sets TF_VAR_tfstate_account from TFSTATE_ACCOUNT."
  type        = string
}

variable "tfstate_container" {
  description = "Blob container holding Terraform state."
  type        = string
  default     = "tfstate"
}

variable "vnet_cidr" {
  description = "VNet address space (test 10.10.0.0/16, staging 10.20.0.0/16, prod 10.30.0.0/16)."
  type        = string
}

variable "subnet_cidrs" {
  description = "Subnet CIDRs inside vnet_cidr: aks (/20 for nodes), psql (/24, delegated to PostgreSQL when postgres_enabled), pe (/24, private endpoints)."
  type = object({
    aks  = string
    psql = string
    pe   = string
  })
}

variable "postgres_enabled" {
  description = "Create the PostgreSQL Flexible Server (and its database-url / pg-admin-password secrets). False for test, whose namespaces run in-cluster Postgres."
  type        = bool
  default     = true
}

variable "postgres_sku_name" {
  description = "PostgreSQL Flexible Server SKU."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  description = "PostgreSQL storage size in MB."
  type        = number
  default     = 32768
}

variable "postgres_backup_retention_days" {
  description = "PostgreSQL backup retention in days."
  type        = number
  default     = 7
}

variable "law_daily_quota_gb" {
  description = "Daily ingestion cap (GB) for the env Log Analytics workspace."
  type        = number
  default     = 0.5
}

variable "ingress_pip_zones" {
  description = "Availability zones for the ingress public IP (all three = zone-redundant, no extra cost). Empty list for regions without zones."
  type        = list(string)
  default     = ["1", "2", "3"]
}

variable "secret_officer_sp_object_ids" {
  description = "Service principal object IDs granted Key Vault Secrets Officer on the env vault. Assigned with principal_type ServicePrincipal, so CI can apply them. CI (gh-bbm-<env>) already has the role via bootstrap and need not be listed."
  type        = list(string)
  default     = []
}

variable "secret_officer_user_object_ids" {
  description = "Entra user object IDs granted Key Vault Secrets Officer on the env vault: the human running a local apply (Terraform writes database-url/pg-admin-password) and whoever sets llm-api-key out of band. Assigned with principal_type User, which CI cannot grant: apply changes to this list locally as a subscription Owner first, after which CI sees no diff."
  type        = list(string)
  default     = []
}
