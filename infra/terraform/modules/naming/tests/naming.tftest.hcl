# terraform test for the naming module (no providers needed — pure locals).

variables {
  suffix = "a1b2"
}

run "global_names" {
  command = plan

  assert {
    condition     = output.global.shared_resource_group == "rg-bbm-shared-ncus"
    error_message = "unexpected shared RG name"
  }

  assert {
    condition     = output.global.acr == "acrbbma1b2"
    error_message = "unexpected ACR name"
  }

  assert {
    condition     = output.global.tfstate_storage_account == "stbbmtfstatea1b2"
    error_message = "unexpected tfstate storage account name"
  }

  assert {
    condition     = output.global.shared_key_vault == "kv-bbm-shared-a1b2"
    error_message = "unexpected shared Key Vault name"
  }

  assert {
    condition     = output.tags.layer == "global" && output.tags.project == "bbm" && output.tags.managed_by == "terraform"
    error_message = "unexpected global tags"
  }

  assert {
    condition     = !contains(keys(output.global), "aca_pull_identity") && !contains(keys(output.global), "test_resource_group")
    error_message = "ACA-era names must be gone"
  }

  assert {
    condition     = output.dns.zone == null && length(output.dns.env_zones) == 0 && output.dns.host == null
    error_message = "dns names must be empty without dns_zone_name"
  }
}

run "staging_names" {
  command = plan

  variables {
    env   = "staging"
    layer = "data"
  }

  assert {
    condition     = output.env.data_resource_group == "rg-bbm-staging-data-ncus"
    error_message = "unexpected staging data RG name"
  }

  assert {
    condition     = output.env.aks_node_resource_group == "rg-bbm-staging-aksnodes-ncus"
    error_message = "unexpected AKS node RG name"
  }

  assert {
    condition     = output.env.key_vault == "kv-bbm-stg-a1b2" && output.env.storage_account == "stbbmstga1b2"
    error_message = "unexpected staging KV/storage names"
  }

  assert {
    condition     = output.env.ingress_fqdn == "bbm-staging.northcentralus.cloudapp.azure.com"
    error_message = "unexpected ingress FQDN"
  }

  assert {
    condition     = output.env.vnet_cidr == "10.20.0.0/16" && output.uamis.api == "id-bbm-staging-api" && output.uamis.certmgr == "id-bbm-staging-certmgr"
    error_message = "unexpected VNet CIDR or UAMI name"
  }
}

run "staging_dns" {
  command = plan

  variables {
    env           = "staging"
    dns_zone_name = "bbm.example.com"
  }

  assert {
    condition = (
      output.dns.env_zones == tolist(["staging.bbm.example.com"]) &&
      output.dns.host == "staging.bbm.example.com" &&
      output.dns.internal_zone == "staging.internal.bbm.example.com"
    )
    error_message = "unexpected staging DNS names"
  }
}

run "test_env" {
  command = plan

  variables {
    env           = "test"
    layer         = "compute"
    dns_zone_name = "bbm.example.com"
  }

  assert {
    condition = (
      output.env.data_resource_group == "rg-bbm-test-data-ncus" &&
      output.env.compute_resource_group == "rg-bbm-test-compute-ncus" &&
      output.env.aks_cluster == "aks-bbm-test-ncus" &&
      output.env.vnet_cidr == "10.10.0.0/16" &&
      output.env.key_vault == "kv-bbm-tst-a1b2" &&
      output.env_short == "tst"
    )
    error_message = "unexpected test env names"
  }

  assert {
    condition = (
      output.dns.env_zones == tolist(["test.bbm.example.com", "preview.bbm.example.com"]) &&
      output.dns.env_labels == tolist(["test", "preview"]) &&
      output.dns.host == "test.bbm.example.com" &&
      output.dns.internal_zone == "test.internal.bbm.example.com"
    )
    error_message = "test env must serve test.<zone> and preview.<zone>"
  }

  assert {
    condition     = output.tags.layer == "compute" && output.tags.env == "test"
    error_message = "unexpected test tags"
  }
}

run "length_limits" {
  command = plan

  # Worst case for length: the longest env name, a long region name and the
  # longest allowed region code (6 chars) for a region outside the map.
  variables {
    env           = "staging"
    location      = "southafricanorth"
    location_abbr = "safnzz"
    suffix        = "zz99"
  }

  assert {
    condition = alltrue([
      for n in [output.global.shared_key_vault, output.env.key_vault] :
      length(n) >= 3 && length(n) <= 24 && can(regex("^[a-z][a-z0-9-]*[a-z0-9]$", n)) && !strcontains(n, "--")
    ])
    error_message = "Key Vault names must be 3-24 chars, start with a letter, no consecutive hyphens"
  }

  assert {
    condition = alltrue([
      for n in [output.global.tfstate_storage_account, output.env.storage_account] :
      can(regex("^[a-z0-9]{3,24}$", n))
    ])
    error_message = "storage account names must be 3-24 lowercase alphanumeric chars"
  }

  assert {
    condition     = can(regex("^[a-z0-9]{5,50}$", output.global.acr))
    error_message = "ACR name must be 5-50 alphanumeric chars"
  }

  # Region-bearing names: RGs <= 90 (AKS node RG <= 80), AKS/PG/LAW <= 63, VNet <= 64.
  assert {
    condition = (
      length(output.env.aks_node_resource_group) <= 80 &&
      alltrue([for n in [output.env.data_resource_group, output.env.compute_resource_group, output.global.tfstate_resource_group, output.global.shared_resource_group] : length(n) <= 90]) &&
      alltrue([for n in [output.env.aks_cluster, output.env.postgres_server, output.env.log_analytics, output.global.shared_log_analytics] : length(n) <= 63]) &&
      length(output.env.vnet) <= 64
    )
    error_message = "a region-bearing name exceeds its Azure length limit"
  }
}

# The built-in region map (ADR 0002): location alone picks the abbreviation.
run "region_map" {
  command = plan

  variables {
    env      = "test"
    location = "canadacentral"
  }

  assert {
    condition = (
      output.location_abbr == "cac" &&
      output.env.aks_cluster == "aks-bbm-test-cac" &&
      output.global.tfstate_resource_group == "rg-bbm-tfstate-cac" &&
      output.env.ingress_fqdn == "bbm-test.canadacentral.cloudapp.azure.com"
    )
    error_message = "canadacentral must map to cac"
  }
}

run "region_map_default" {
  command = plan

  assert {
    condition     = output.location == "northcentralus" && output.location_abbr == "ncus"
    error_message = "default region must be northcentralus / ncus"
  }
}

run "region_map_france" {
  command = plan

  variables {
    location = "francecentral"
  }

  assert {
    condition     = output.location_abbr == "frc" && output.global.shared_resource_group == "rg-bbm-shared-frc"
    error_message = "francecentral must map to frc"
  }
}

run "region_map_legacy" {
  command = plan

  variables {
    location      = "eastus2"
    location_abbr = "eus2"
  }

  assert {
    condition     = output.location_abbr == "eus2" && output.global.shared_resource_group == "rg-bbm-shared-eus2"
    error_message = "eastus2 with its matching abbreviation must still work"
  }
}

run "region_unknown_with_abbr" {
  command = plan

  variables {
    location      = "swedencentral"
    location_abbr = "sdc"
  }

  assert {
    condition     = output.location_abbr == "sdc" && output.global.shared_resource_group == "rg-bbm-shared-sdc"
    error_message = "an explicit location_abbr must be used for regions outside the map"
  }
}

run "rejects_unknown_region_without_abbr" {
  command = plan

  variables {
    location = "swedencentral"
  }

  expect_failures = [var.location_abbr]
}

run "rejects_mismatched_abbr" {
  command = plan

  variables {
    location      = "northcentralus"
    location_abbr = "eus2"
  }

  expect_failures = [var.location_abbr]
}

run "rejects_bad_abbr" {
  command = plan

  variables {
    location      = "swedencentral"
    location_abbr = "Sweden-Central"
  }

  expect_failures = [var.location_abbr]
}

run "rejects_preview_env" {
  command = plan

  variables {
    env = "preview"
  }

  expect_failures = [var.env]
}

run "rejects_bad_suffix" {
  command = plan

  variables {
    suffix = "ABCDE"
  }

  expect_failures = [var.suffix]
}
