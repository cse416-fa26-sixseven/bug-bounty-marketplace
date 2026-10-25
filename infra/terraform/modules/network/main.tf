# Env VNet with three subnets, NSGs and the private DNS zone that the
# VNet-integrated PostgreSQL Flexible Server registers its A record in.

resource "azurerm_virtual_network" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  address_space       = [var.address_space]
  tags                = var.tags
}

# AKS nodes (and pods, if the compute stack picks a non-overlay CNI).
resource "azurerm_subnet" "aks" {
  name                 = var.subnets.aks.name
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [var.subnets.aks.cidr]
}

# Delegated subnet: only PostgreSQL Flexible Servers may live here. Without
# postgres (test env) it stays a plain, empty subnet so the CIDR plan and the
# Helm networkPolicy.postgresCidr value are the same in every env.
resource "azurerm_subnet" "psql" {
  name                 = var.subnets.psql.name
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [var.subnets.psql.cidr]

  dynamic "delegation" {
    for_each = var.postgres_enabled ? [1] : []
    content {
      name = "postgres-flexible"

      service_delegation {
        name    = "Microsoft.DBforPostgreSQL/flexibleServers"
        actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
      }
    }
  }
}

# Reserved for private endpoints (KV/storage) if public access is ever closed.
resource "azurerm_subnet" "pe" {
  name                 = var.subnets.pe.name
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [var.subnets.pe.cidr]
}

# ---- NSGs ---------------------------------------------------------------------
# AKS subnet: a subnet-level NSG is evaluated in addition to the NSG AKS
# manages on the node NICs, and AKS never edits this one, so the ingress
# ports must be opened explicitly. Default rules still allow VNet and
# AzureLoadBalancer traffic.
#
# The destination is the ingress public IP, not the subnet CIDR: the AKS
# Standard LB uses floating IP (direct server return), so inbound packets
# reach the node still addressed to the LB frontend IP. A rule scoped to the
# subnet CIDR would never match and DenyAllInBound would drop the traffic.
resource "azurerm_network_security_group" "aks" {
  name                = "nsg-${var.name}-${var.subnets.aks.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  security_rule {
    name                       = "allow-internet-ingress"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_address_prefix      = "Internet"
    source_port_range          = "*"
    destination_address_prefix = var.ingress_public_ip
    destination_port_ranges    = var.ingress_ports
  }
}

# PostgreSQL subnet: only the AKS subnet (and the subnet itself) may reach 5432.
resource "azurerm_network_security_group" "psql" {
  name                = "nsg-${var.name}-${var.subnets.psql.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  security_rule {
    name                       = "allow-postgres-from-aks"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_address_prefixes    = [var.subnets.aks.cidr, var.subnets.psql.cidr]
    source_port_range          = "*"
    destination_address_prefix = var.subnets.psql.cidr
    destination_port_range     = "5432"
  }

  security_rule {
    name                       = "deny-other-vnet-inbound"
    priority                   = 4000
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_address_prefix      = "VirtualNetwork"
    source_port_range          = "*"
    destination_address_prefix = "*"
    destination_port_range     = "*"
  }
}

resource "azurerm_subnet_network_security_group_association" "aks" {
  subnet_id                 = azurerm_subnet.aks.id
  network_security_group_id = azurerm_network_security_group.aks.id
}

resource "azurerm_subnet_network_security_group_association" "psql" {
  subnet_id                 = azurerm_subnet.psql.id
  network_security_group_id = azurerm_network_security_group.psql.id
}

# ---- private DNS for PostgreSQL ---------------------------------------------------
resource "azurerm_private_dns_zone" "postgres" {
  count = var.postgres_enabled ? 1 : 0

  name                = var.postgres_private_dns_zone_name
  resource_group_name = var.resource_group_name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  count = var.postgres_enabled ? 1 : 0

  name                  = "link-${var.name}"
  resource_group_name   = var.resource_group_name
  private_dns_zone_name = azurerm_private_dns_zone.postgres[0].name
  virtual_network_id    = azurerm_virtual_network.this.id
  registration_enabled  = false
  tags                  = var.tags
}
