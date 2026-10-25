output "vnet_id" {
  description = "Virtual network resource ID."
  value       = azurerm_virtual_network.this.id
}

output "vnet_name" {
  description = "Virtual network name."
  value       = azurerm_virtual_network.this.name
}

output "subnet_ids" {
  description = "Subnet resource IDs keyed by role (aks, psql, pe). Available only after the NSG associations, so nothing deploys into a subnet that is still being modified."
  value = {
    aks  = azurerm_subnet.aks.id
    psql = azurerm_subnet.psql.id
    pe   = azurerm_subnet.pe.id
  }
  depends_on = [
    azurerm_subnet_network_security_group_association.aks,
    azurerm_subnet_network_security_group_association.psql,
  ]
}

output "subnet_cidrs" {
  description = "Subnet CIDRs keyed by role (aks, psql, pe)."
  value = {
    aks  = var.subnets.aks.cidr
    psql = var.subnets.psql.cidr
    pe   = var.subnets.pe.cidr
  }
}

output "postgres_private_dns_zone_id" {
  description = "Private DNS zone ID for PostgreSQL (null when postgres_enabled is false). Only resolves once the VNet link exists, so the server never races the link."
  value       = one(azurerm_private_dns_zone.postgres[*].id)
  depends_on  = [azurerm_private_dns_zone_virtual_network_link.postgres]
}

output "psql_delegated" {
  description = "Whether snet-psql is delegated to PostgreSQL Flexible Server."
  value       = length(azurerm_subnet.psql.delegation) > 0
}

output "ingress_destination_address_prefix" {
  description = "Destination of the AKS NSG Internet-ingress rule (the ingress public IP; the LB uses floating IP)."
  value       = one([for r in azurerm_network_security_group.aks.security_rule : r.destination_address_prefix if r.name == "allow-internet-ingress"])
}
