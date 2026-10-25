# Pure naming/tagging module: no resources, only deterministic strings derived
# from the inputs, so every stack agrees on names without remote lookups.

locals {
  p   = var.project
  loc = var.location_abbr
  sfx = var.suffix

  # Short env codes for names with tight length limits (Key Vault, storage).
  env_short_map = {
    global  = "glb"
    test    = "tst"
    staging = "stg"
    prod    = "prd"
  }
  env_short = local.env_short_map[var.env]

  # VNet address spaces per AKS env (ADR 0001 / 0002).
  vnet_cidrs = {
    test    = "10.10.0.0/16"
    staging = "10.20.0.0/16"
    prod    = "10.30.0.0/16"
  }

  # ---- global / shared names ----------------------------------------------
  global = {
    tfstate_resource_group  = "rg-${local.p}-tfstate-${local.loc}"
    tfstate_storage_account = "st${local.p}tfstate${local.sfx}"
    tfstate_container       = "tfstate"
    shared_resource_group   = "rg-${local.p}-shared-${local.loc}"
    acr                     = "acr${local.p}${local.sfx}"
    shared_log_analytics    = "log-${local.p}-shared-${local.loc}"
    shared_key_vault        = "kv-${local.p}-shared-${local.sfx}"
  }

  # ---- per-env names (meaningful for test/staging/prod) ---------------------
  e = var.env
  env = {
    data_resource_group     = "rg-${local.p}-${local.e}-data-${local.loc}"
    compute_resource_group  = "rg-${local.p}-${local.e}-compute-${local.loc}"
    aks_node_resource_group = "rg-${local.p}-${local.e}-aksnodes-${local.loc}"
    vnet                    = "vnet-${local.p}-${local.e}-${local.loc}"
    vnet_cidr               = lookup(local.vnet_cidrs, local.e, null)
    subnet_aks              = "snet-aks"
    subnet_psql             = "snet-psql"
    subnet_pe               = "snet-pe"
    postgres_server         = "psql-${local.p}-${local.e}-${local.loc}"
    postgres_database       = local.p
    key_vault               = "kv-${local.p}-${local.env_short}-${local.sfx}"
    storage_account         = "st${local.p}${local.env_short}${local.sfx}"
    storage_container       = "sources"
    storage_queue           = "analysis-jobs"
    log_analytics           = "log-${local.p}-${local.e}-${local.loc}"
    ingress_public_ip       = "pip-${local.p}-${local.e}-ingress"
    ingress_dns_label       = "${local.p}-${local.e}"
    ingress_fqdn            = "${local.p}-${local.e}.${var.location}.cloudapp.azure.com"
    aks_cluster             = "aks-${local.p}-${local.e}-${local.loc}"
  }

  uamis = {
    for role in ["aks", "api", "worker", "sandbox", "certmgr"] : role => "id-${local.p}-${local.e}-${role}"
  }

  # ---- DNS (ADR 0002) ---------------------------------------------------------
  # Child zones per env under the parent zone; the test cluster also serves
  # PR previews. Bootstrap creates the zones, data writes their records.
  dns_env_labels = {
    test    = ["test", "preview"]
    staging = ["staging"]
    prod    = ["prod"]
  }
  dns_env_zones = var.dns_zone_name == null ? [] : [
    for l in lookup(local.dns_env_labels, local.e, []) : "${l}.${var.dns_zone_name}"
  ]
  dns = {
    zone          = var.dns_zone_name
    env_labels    = tolist(lookup(local.dns_env_labels, local.e, []))
    env_zones     = local.dns_env_zones
    host          = length(local.dns_env_zones) > 0 ? local.dns_env_zones[0] : null
    internal_zone = var.dns_zone_name == null || !contains(keys(local.dns_env_labels), local.e) ? null : "${local.e}.internal.${var.dns_zone_name}"
  }

  # ---- tags -----------------------------------------------------------------
  base_tags = {
    project     = local.p
    env         = var.env
    managed_by  = "terraform"
    repo        = var.repo
    cost_center = "cse416"
  }

  tags_by_layer = {
    for l in ["global", "data", "compute"] :
    l => merge(local.base_tags, { layer = l }, var.extra_tags)
  }
}
