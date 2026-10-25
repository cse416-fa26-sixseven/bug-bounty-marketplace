variable "name" {
  description = "Registry name (5-50 alphanumeric, globally unique)."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9]{5,50}$", var.name))
    error_message = "ACR name must be 5-50 alphanumeric characters."
  }
}

variable "resource_group_name" {
  description = "Resource group to create the registry in."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "sku" {
  description = "Registry SKU. Basic is enough for this project (no geo-replication/private endpoints)."
  type        = string
  default     = "Basic"
}

variable "role_assignment_mode" {
  description = "Role assignment permissions mode. AbacRepositoryPermissions (all SKUs, Basic included) honors only the Container Registry Repository Reader/Writer/Contributor/Catalog Lister data roles, optionally repository-scoped by ABAC conditions; LegacyRegistryPermissions honors AcrPull/AcrPush."
  type        = string
  default     = "AbacRepositoryPermissions"

  validation {
    condition     = contains(["AbacRepositoryPermissions", "LegacyRegistryPermissions"], var.role_assignment_mode)
    error_message = "role_assignment_mode must be AbacRepositoryPermissions or LegacyRegistryPermissions."
  }
}

variable "tags" {
  description = "Tags applied to the registry."
  type        = map(string)
  default     = {}
}
