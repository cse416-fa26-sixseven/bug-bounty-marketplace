# Public DNS (ADR 0002 §2). The parent zone lives in the shared RG and is
# delegated from the domain's registrar/DNS host by infra/up.sh (or by hand).
# Each env gets child zones in its own data RG, so an env's CI identity and
# cert-manager identity can only touch their own names. stacks/data writes
# the records; this stack only creates the zones and the NS delegations.

locals {
  # "<label>" => { env, name }: test.<zone> and preview.<zone> both belong to
  # the test env (CI runs and PR previews share the test cluster).
  dns_child_zones = merge([
    for env in local.persistent_envs : {
      for i, label in module.naming_env[env].dns.env_labels : label => {
        env  = env
        name = module.naming_env[env].dns.env_zones[i]
      }
    }
  ]...)
}

resource "azurerm_dns_zone" "parent" {
  name                = var.dns_zone_name
  resource_group_name = azurerm_resource_group.shared.name
  tags                = module.naming.tags

  depends_on = [azurerm_resource_provider_registration.this]
}

resource "azurerm_dns_zone" "child" {
  for_each = local.dns_child_zones

  name                = each.value.name
  resource_group_name = azurerm_resource_group.env_data[each.value.env].name
  tags                = module.naming_env[each.value.env].tags_by_layer.data

  depends_on = [azurerm_resource_provider_registration.this]
}

resource "azurerm_dns_ns_record" "delegation" {
  for_each = azurerm_dns_zone.child

  name                = each.key
  zone_name           = azurerm_dns_zone.parent.name
  resource_group_name = azurerm_resource_group.shared.name
  ttl                 = 3600
  records             = sort(tolist(each.value.name_servers))
  tags                = module.naming.tags
}
