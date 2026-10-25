variable "name" {
  description = "PostgreSQL Flexible Server name (psql-bbm-<env>-<abbr>)."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group for the server."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "delegated_subnet_id" {
  description = "Subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers (VNet integration)."
  type        = string
}

variable "private_dns_zone_id" {
  description = "Private DNS zone (*.postgres.database.azure.com) linked to the VNet."
  type        = string
}

variable "sku_name" {
  description = "Compute SKU. B_Standard_B1ms is the cheapest burstable tier."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_version" {
  description = "PostgreSQL major version."
  type        = string
  default     = "16"
}

variable "storage_mb" {
  description = "Storage size in MB (32768 = 32 GB, the minimum)."
  type        = number
  default     = 32768
}

variable "backup_retention_days" {
  description = "Point-in-time-restore window in days (7-35)."
  type        = number
  default     = 7
}

variable "administrator_login" {
  description = "Admin user name."
  type        = string
  default     = "bbmadmin"
}

variable "database_name" {
  description = "Application database created on the server."
  type        = string
  default     = "bbm"
}

variable "tags" {
  description = "Tags applied to the server."
  type        = map(string)
  default     = {}
}
