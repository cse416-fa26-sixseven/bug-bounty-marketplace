# Env DNS (ADR 0002 §2). The public env zones are created (and delegated) by
# stacks/bootstrap in this RG; this stack only writes records into them.

data "azurerm_dns_zone" "env" {
  for_each = toset(local.dns.env_zones)

  name                = each.key
  resource_group_name = local.rg
}

# Apex + wildcard alias A records -> the static ingress PIP. Alias records
# follow the PIP's address, so nothing changes if the IP is ever replaced.
resource "azurerm_dns_a_record" "ingress" {
  for_each = merge([
    for z in local.dns.env_zones : {
      for r in ["@", "*"] : "${r}.${z}" => { zone = z, name = r }
    }
  ]...)

  name                = each.value.name
  zone_name           = data.azurerm_dns_zone.env[each.value.zone].name
  resource_group_name = local.rg
  ttl                 = 300
  target_resource_id  = azurerm_public_ip.ingress.id
  tags                = local.tags
}

# Internal names inside the VNet. In-cluster service discovery still uses
# Kubernetes DNS; this is for stable names of managed services.
resource "azurerm_private_dns_zone" "internal" {
  name                = local.dns.internal_zone
  resource_group_name = local.rg
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "internal" {
  name                  = "link-${local.n.vnet}"
  resource_group_name   = local.rg
  private_dns_zone_name = azurerm_private_dns_zone.internal.name
  virtual_network_id    = module.network.vnet_id
  registration_enabled  = false
  tags                  = local.tags
}

resource "azurerm_private_dns_cname_record" "postgres" {
  count = var.postgres_enabled ? 1 : 0

  name                = "postgres"
  zone_name           = azurerm_private_dns_zone.internal.name
  resource_group_name = local.rg
  ttl                 = 300
  record              = module.postgres[0].fqdn
  tags                = local.tags
}
