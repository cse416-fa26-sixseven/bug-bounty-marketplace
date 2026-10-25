variable "name" {
  description = "Virtual network name (vnet-bbm-<env>-eus2)."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group for the VNet, NSGs and private DNS zone."
  type        = string
}

variable "location" {
  description = "Azure region."
  type        = string
}

variable "address_space" {
  description = "VNet CIDR (staging 10.20.0.0/16, prod 10.30.0.0/16)."
  type        = string

  validation {
    condition     = can(cidrhost(var.address_space, 0))
    error_message = "address_space must be a valid IPv4 CIDR."
  }
}

variable "subnets" {
  description = "Subnet names and CIDRs. aks hosts the AKS nodes, psql is delegated to PostgreSQL Flexible Server, pe is reserved for private endpoints."
  type = object({
    aks  = object({ name = string, cidr = string })
    psql = object({ name = string, cidr = string })
    pe   = object({ name = string, cidr = string })
  })
}

variable "postgres_enabled" {
  description = "Delegate snet-psql to PostgreSQL Flexible Server and create its private DNS zone + VNet link. False for envs without a PG server (test)."
  type        = bool
  default     = true
}

variable "postgres_private_dns_zone_name" {
  description = "Private DNS zone for the VNet-integrated PostgreSQL server. Must end in .postgres.database.azure.com and must not be privatelink.postgres.database.azure.com (that zone is for private endpoints)."
  type        = string

  validation {
    condition = (
      endswith(var.postgres_private_dns_zone_name, ".postgres.database.azure.com") &&
      var.postgres_private_dns_zone_name != "privatelink.postgres.database.azure.com"
    )
    error_message = "Zone name must end with .postgres.database.azure.com and must not be the privatelink zone."
  }
}

variable "ingress_public_ip" {
  description = "Ingress public IP address (the AKS LB frontend). Used as the NSG destination for Internet ingress because the LB uses floating IP, so packets arrive addressed to this IP rather than to a node IP."
  type        = string

  validation {
    condition     = can(cidrhost("${var.ingress_public_ip}/32", 0))
    error_message = "ingress_public_ip must be a single IPv4 address."
  }
}

variable "ingress_ports" {
  description = "TCP ports allowed from the Internet into the AKS subnet (ingress load balancer)."
  type        = list(string)
  default     = ["80", "443"]
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
