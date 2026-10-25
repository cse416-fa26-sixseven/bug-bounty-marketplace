# Offline test with mock providers: no Azure/Entra credentials needed.
# Exercises for_each keys, ABAC conditions and the gh_setup_commands output.

mock_provider "azurerm" {
  mock_data "azurerm_subscription" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id = "11111111-1111-1111-1111-111111111111"
      object_id = "22222222-2222-2222-2222-222222222222"
    }
  }

  mock_resource "azurerm_resource_group" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/mock"
    }
  }

  mock_resource "azurerm_storage_account" {
    defaults = {
      id = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-bbm-tfstate-ncus/providers/Microsoft.Storage/storageAccounts/mock"
    }
  }

  mock_resource "azurerm_dns_zone" {
    defaults = {
      id           = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/mock/providers/Microsoft.Network/dnsZones/mock"
      name_servers = ["ns1-01.azure-dns.com.", "ns2-01.azure-dns.net.", "ns3-01.azure-dns.org.", "ns4-01.azure-dns.info."]
    }
  }

  mock_resource "azurerm_role_definition" {
    defaults = {
      role_definition_resource_id = "/subscriptions/00000000-0000-0000-0000-000000000000/providers/Microsoft.Authorization/roleDefinitions/33333333-3333-3333-3333-333333333333"
    }
  }
}

mock_provider "azuread" {
  mock_data "azuread_client_config" {
    defaults = {
      object_id = "22222222-2222-2222-2222-222222222222"
    }
  }

  mock_resource "azuread_application_registration" {
    defaults = {
      id        = "/applications/66666666-6666-6666-6666-666666666666"
      client_id = "44444444-4444-4444-4444-444444444444"
    }
  }

  mock_resource "azuread_service_principal" {
    defaults = {
      object_id = "77777777-7777-7777-7777-777777777777"
    }
  }
}

mock_provider "random" {
  mock_resource "random_string" {
    defaults = {
      result = "a1b2"
    }
  }
}

variables {
  subscription_id           = "00000000-0000-0000-0000-000000000000"
  alert_emails              = ["admin@example.com"]
  admin_object_ids          = ["55555555-5555-5555-5555-555555555555"]
  power_operator_object_ids = ["55555555-5555-5555-5555-555555555555"]
  github_reviewer_ids       = [12345]
  dns_zone_name             = "bbm.example.com"
}

run "apply_with_mocks" {
  command = apply

  assert {
    condition     = length(module.github_oidc.client_ids) == 8
    error_message = "expected 8 OIDC identities"
  }

  assert {
    condition     = module.github_oidc.subjects["gh-bbm-prod"] == ["repo:cse416-fa26-sixseven/bug-bounty-marketplace:environment:prod"]
    error_message = "gh-bbm-prod must trust only the reviewer-gated prod environment"
  }

  assert {
    condition     = module.github_oidc.subjects["gh-bbm-prod-power"] == ["repo:cse416-fa26-sixseven/bug-bounty-marketplace:environment:prod-power"]
    error_message = "gh-bbm-prod-power must trust only prod-power"
  }

  assert {
    condition = (
      length(local.oidc_identities["gh-bbm-prod-power"].role_assignments) == 2 &&
      alltrue([for ra in local.oidc_identities["gh-bbm-prod-power"].role_assignments :
      ra.role_definition_id == azurerm_role_definition.power_operator.role_definition_resource_id])
    )
    error_message = "gh-bbm-prod-power must hold only BBM Power Operator (data + compute)"
  }

  assert {
    condition     = contains(module.github_oidc.subjects["gh-bbm-plan"], "repo:cse416-fa26-sixseven/bug-bounty-marketplace:pull_request")
    error_message = "plan identity must trust pull_request"
  }

  assert {
    condition = (
      length(local.oidc_identities["gh-bbm-plan"].role_assignments) == 2 &&
      local.oidc_identities["gh-bbm-plan"].role_assignments[0].role_definition_name == "Reader" &&
      local.oidc_identities["gh-bbm-plan"].role_assignments[1] == local.state_role.plan
    )
    error_message = "plan identity must have only Reader + the (conditioned) BBM tfstate reader"
  }

  # ---- state ABAC --------------------------------------------------------------
  assert {
    condition = alltrue([
      for name, id in local.oidc_identities : alltrue([
        for ra in id.role_assignments : ra.condition != null && ra.condition_version == "2.0"
        if ra.key == "tfstate"
      ])
    ])
    error_message = "every CI state grant must carry an ABAC condition"
  }

  assert {
    condition = (
      strcontains(local.state_condition.prod, "StringStartsWith 'prod/'") &&
      strcontains(local.state_condition.prod, "StringEquals 'global.tfstate'") &&
      !strcontains(local.state_condition.prod, "'staging/'") &&
      strcontains(local.state_path_match.prod.write, "'prod/'") &&
      !strcontains(local.state_path_match.prod.write, "global.tfstate")
    )
    error_message = "prod state condition wrong (write prod/, read prod/ + global.tfstate)"
  }

  assert {
    condition = (
      strcontains(local.state_path_match.ephemeral.read, "StringStartsWith 'test/'") &&
      strcontains(local.state_path_match.ephemeral.read, "StringEquals 'global.tfstate'") &&
      !strcontains(local.state_condition.ephemeral, "preview/") &&
      !strcontains(local.state_condition.ephemeral, "/write")
    )
    error_message = "ephemeral state access must be read-only on test/ + global.tfstate"
  }

  assert {
    condition = (
      local.state_path_match.test.write == "@Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringStartsWith 'test/'" &&
      strcontains(local.state_path_match.test.read, "StringEquals 'global.tfstate'")
    )
    error_message = "gh-bbm-test must write test/ and read global.tfstate"
  }

  assert {
    condition     = local.state_path_match.global.write == "@Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path] StringEquals 'global.tfstate'"
    error_message = "global identity may only write global.tfstate"
  }

  assert {
    condition = (
      !strcontains(local.state_condition.plan, "prod/") &&
      !strcontains(local.state_condition.plan, "preview/") &&
      strcontains(local.state_condition.plan, "StringStartsWith 'test/'") &&
      strcontains(local.state_condition.plan, "StringStartsWith 'staging/'") &&
      !strcontains(local.state_condition.plan, "bootstrap") &&
      !strcontains(local.state_condition.plan, "/write") &&
      strcontains(local.state_condition.plan, "NOT SubOperationMatches{'Blob.List'}")
    )
    error_message = "plan state condition must be read-only and exclude prod/ and bootstrap"
  }

  assert {
    condition = (
      local.state_role_kind == { ephemeral = "reader", preview = "reader", global = "writer", test = "writer", staging = "writer", prod = "writer", plan = "reader" } &&
      alltrue([for k, r in local.state_role : r.role_definition_id == azurerm_role_definition.tfstate[local.state_role_kind[k]].role_definition_resource_id])
    )
    error_message = "CI state grants must use the custom BBM tfstate writer/reader roles (plan: reader)"
  }

  # No CI state role may carry container write/delete (the built-in Storage
  # Blob Data roles do, and ABAC blob-path conditions cannot limit them).
  assert {
    condition = alltrue([for k, r in azurerm_role_definition.tfstate : (
      toset(r.permissions[0].actions) == toset(["Microsoft.Storage/storageAccounts/blobServices/containers/read"]) &&
      toset(r.assignable_scopes) == toset([azurerm_resource_group.tfstate.id])
    )])
    error_message = "tfstate custom roles may only hold containers/read as a control-plane action"
  }

  assert {
    condition = (
      azurerm_role_definition.tfstate["writer"].name == "BBM tfstate writer" &&
      toset(azurerm_role_definition.tfstate["writer"].permissions[0].data_actions) == toset([
        for a in ["read", "write", "add/action", "delete", "move/action"] : "Microsoft.Storage/storageAccounts/blobServices/containers/blobs/${a}"
      ]) &&
      azurerm_role_definition.tfstate["reader"].name == "BBM tfstate reader" &&
      toset(azurerm_role_definition.tfstate["reader"].permissions[0].data_actions) == toset(["Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read"])
    )
    error_message = "tfstate custom role data actions wrong"
  }

  assert {
    condition = alltrue(flatten([for name, id in local.oidc_identities : [
      for ra in id.role_assignments : !contains(["Storage Blob Data Contributor", "Storage Blob Data Reader", "Storage Blob Data Owner"], try(ra.role_definition_name, "-"))
    ]]))
    error_message = "CI identities must not hold built-in Storage Blob Data roles"
  }

  # ---- constrained RBAC admin --------------------------------------------------
  assert {
    condition = alltrue([
      for k, c in local.rbac_condition :
      strcontains(c, "@Request[Microsoft.Authorization/roleAssignments:PrincipalType] StringEqualsIgnoreCase 'ServicePrincipal'")
    ])
    error_message = "RBAC admin conditions must restrict new assignments to service principals"
  }

  assert {
    condition = alltrue([for g in ["19e7f393-937e-4f77-808e-94535e297925", "8a0f0c08-91a1-4084-bc3d-661d67233fed", "c6a89b2d-59bc-44d0-9896-0f6e12d7b80a"] :
    contains(local.env_delegable_roles, g)])
    error_message = "env identities must be able to delegate the Storage Queue Data Reader / Message Processor / Message Sender roles"
  }

  assert {
    condition     = contains(local.env_delegable_roles, "befefa01-2a29-4197-83a8-272ff33ce314") && strcontains(local.rbac_condition.env, "befefa01-2a29-4197-83a8-272ff33ce314")
    error_message = "env identities must be able to delegate DNS Zone Contributor (cert-manager)"
  }

  assert {
    condition = (
      !contains(local.global_delegable_roles, local.role_guids.managed_identity_operator) &&
      contains(local.global_delegable_roles, local.role_guids.acr_repo_writer) &&
      contains(local.global_delegable_roles, local.role_guids.acr_repo_reader)
    )
    error_message = "global identity must delegate the ACR Repository Writer/Reader roles (and no longer Managed Identity Operator)"
  }

  # ABAC-mode registry: the legacy AcrPull/AcrPush GUIDs are not honored and
  # must not be delegable anywhere.
  assert {
    condition = alltrue([for c in values(local.rbac_condition) :
      !strcontains(c, "7f951dda-4ed3-4680-a7ca-43fe172d538d") && !strcontains(c, "8311e382-0749-4cb8-b61a-304f252e45ec")
    ]) && local.shared_acr_reader_only == ["b93aa761-3e63-49ed-ac28-beffa264f7ac"]
    error_message = "constrained RBAC must delegate Repository Reader (kubelet), never AcrPull/AcrPush"
  }

  assert {
    condition = (
      contains([for ra in local.oidc_identities["gh-bbm-global"].role_assignments : try(ra.role_definition_name, "-")], "Container Registry Repository Contributor") &&
      contains([for ra in local.oidc_identities["gh-bbm-global"].role_assignments : try(ra.role_definition_name, "-")], "Container Registry Repository Catalog Lister") &&
      alltrue([for env in ["test", "staging", "prod"] :
      contains([for ra in local.oidc_identities["gh-bbm-${env}"].role_assignments : ra.key], "shared-acr-repo-reader")])
    )
    error_message = "gh-bbm-global needs Repository Contributor + Catalog Lister (janitor purge); env identities need Repository Reader (deploy image checks)"
  }

  assert {
    condition     = length(azurerm_role_assignment.admin_acr) == 2
    error_message = "each admin needs Repository Contributor + Catalog Lister on the shared RG (ABAC-mode registry)"
  }

  # ---- test env + ephemeral namespaces -----------------------------------------
  assert {
    condition = (
      module.github_oidc.subjects["gh-bbm-test"] == ["repo:cse416-fa26-sixseven/bug-bounty-marketplace:environment:test-infra"] &&
      [for ra in local.oidc_identities["gh-bbm-test"].role_assignments : ra.key] == [for ra in local.oidc_identities["gh-bbm-staging"].role_assignments : ra.key] &&
      local.oidc_identities["gh-bbm-test"].role_assignments[0].scope == azurerm_resource_group.env_data["test"].id
    )
    error_message = "gh-bbm-test must trust test-infra and mirror gh-bbm-staging's roles on the test RGs"
  }

  assert {
    condition = alltrue([for id in ["gh-bbm-ephemeral", "gh-bbm-preview"] :
      toset([for ra in local.oidc_identities[id].role_assignments : ra.key]) == toset([
        "test-compute-aks-admin", "test-compute-aks-user", "test-data-reader",
        "test-data-power-operator", "test-compute-power-operator", "shared-reader", "tfstate",
      ])
    ])
    error_message = "gh-bbm-ephemeral / gh-bbm-preview role set wrong"
  }

  assert {
    condition = alltrue(flatten([for id in ["gh-bbm-ephemeral", "gh-bbm-preview"] : [
      for ra in local.oidc_identities[id].role_assignments :
      !contains(["Contributor", "Owner", "Role Based Access Control Administrator", "Managed Identity Operator"], try(ra.role_definition_name, "-")) &&
      !startswith(try(ra.role_definition_name, "-"), "Container Registry")
    ]]))
    error_message = "gh-bbm-ephemeral / gh-bbm-preview must not hold Contributor / RBAC admin / MI Operator (registry grants come from stacks/global)"
  }

  # `test` (sha-* pushes) is main-only; `preview` has its own identity.
  assert {
    condition = (
      module.github_oidc.subjects["gh-bbm-ephemeral"] == ["repo:cse416-fa26-sixseven/bug-bounty-marketplace:environment:test"] &&
      module.github_oidc.subjects["gh-bbm-preview"] == ["repo:cse416-fa26-sixseven/bug-bounty-marketplace:environment:preview"] &&
      local.github_environments["test"].main_only &&
      !local.github_environments["preview"].main_only &&
      jsondecode(local.env_payload["test"]).deployment_branch_policy.custom_branch_policies &&
      jsondecode(local.env_payload["preview"]).deployment_branch_policy == null &&
      jsondecode(local.env_payload["preview"]).reviewers == [] &&
      strcontains(output.gh_setup_commands, "repos/cse416-fa26-sixseven/bug-bounty-marketplace/environments/test/deployment-branch-policies") &&
      !strcontains(output.gh_setup_commands, "environments/preview/deployment-branch-policies") &&
      strcontains(output.gh_setup_commands, "# --- environment: preview (gh-bbm-preview)") &&
      strcontains(output.gh_setup_commands, "gh variable set AZURE_CLIENT_ID --repo cse416-fa26-sixseven/bug-bounty-marketplace --env preview")
    )
    error_message = "test must be main-only (gh-bbm-ephemeral); preview must map to gh-bbm-preview, any branch, no reviewer"
  }

  assert {
    condition     = strcontains(output.global_tfvars_hint, "preview_ci_principal_id      = \"77777777-7777-7777-7777-777777777777\"")
    error_message = "global_tfvars_hint must emit preview_ci_principal_id"
  }

  assert {
    condition = (
      azurerm_resource_group.env_data["test"].name == "rg-bbm-test-data-ncus" &&
      azurerm_resource_group.env_compute["test"].name == "rg-bbm-test-compute-ncus" &&
      azurerm_resource_group.env_data["test"].tags["power-state"] == "down" &&
      azurerm_resource_group.env_data["test"].tags["auto-pause"] == "true"
    )
    error_message = "test env resource groups wrong"
  }

  assert {
    condition     = !contains(values(output.resource_groups), "rg-bbm-test-ncus") && !contains(values(output.resource_groups), "rg-bbm-preview-ncus") && length(output.resource_groups) == 8
    error_message = "ACA resource groups must be gone (shared, tfstate + 3 envs x data/compute)"
  }

  # ---- DNS -------------------------------------------------------------------
  assert {
    condition     = azurerm_dns_zone.parent.name == "bbm.example.com" && azurerm_dns_zone.parent.resource_group_name == "rg-bbm-shared-ncus"
    error_message = "parent zone must be dns_zone_name in the shared RG"
  }

  assert {
    condition = (
      { for k, z in azurerm_dns_zone.child : k => [z.name, z.resource_group_name] } == {
        prod    = ["prod.bbm.example.com", "rg-bbm-prod-data-ncus"]
        staging = ["staging.bbm.example.com", "rg-bbm-staging-data-ncus"]
        test    = ["test.bbm.example.com", "rg-bbm-test-data-ncus"]
        preview = ["preview.bbm.example.com", "rg-bbm-test-data-ncus"]
      }
    )
    error_message = "child zones / resource groups wrong"
  }

  assert {
    condition = alltrue([for k, r in azurerm_dns_ns_record.delegation : (
      r.name == k && r.zone_name == "bbm.example.com" && r.resource_group_name == "rg-bbm-shared-ncus" && length(r.records) == 4
    )]) && length(azurerm_dns_ns_record.delegation) == 4
    error_message = "expected 4 NS delegation records in the parent zone"
  }

  assert {
    condition = (
      output.dns_zone_name == "bbm.example.com" &&
      length(output.dns_name_servers) == 4 &&
      output.dns_child_zones == {
        test    = ["preview.bbm.example.com", "test.bbm.example.com"]
        staging = ["staging.bbm.example.com"]
        prod    = ["prod.bbm.example.com"]
      }
    )
    error_message = "DNS outputs wrong"
  }

  assert {
    condition     = strcontains(output.global_tfvars_hint, "dns_zone_name                = \"bbm.example.com\"")
    error_message = "global_tfvars_hint must carry dns_zone_name"
  }

  assert {
    condition     = azurerm_resource_group.env_data["prod"].tags["power-state"] == "down" && azurerm_resource_group.env_data["prod"].tags["layer"] == "data"
    error_message = "data RG initial tags wrong"
  }

  assert {
    condition     = strcontains(output.gh_setup_commands, "# --- environment: prod-power (gh-bbm-prod-power)")
    error_message = "gh_setup_commands must map prod-power to gh-bbm-prod-power"
  }

  assert {
    condition     = strcontains(output.gh_setup_commands, "gh variable set AZURE_CLIENT_ID --repo cse416-fa26-sixseven/bug-bounty-marketplace --env prod-power")
    error_message = "gh_setup_commands missing prod-power client id"
  }

  assert {
    condition = (
      strcontains(output.gh_setup_commands, "gh variable set AZURE_LOCATION --repo cse416-fa26-sixseven/bug-bounty-marketplace --body 'northcentralus'") &&
      strcontains(output.gh_setup_commands, "gh variable set AZURE_LOCATION_ABBR --repo cse416-fa26-sixseven/bug-bounty-marketplace --body 'ncus'")
    )
    error_message = "gh_setup_commands must set the AZURE_LOCATION / AZURE_LOCATION_ABBR repo variables"
  }

  assert {
    condition     = strcontains(output.gh_setup_commands, "repos/cse416-fa26-sixseven/bug-bounty-marketplace/environments/infra-global/deployment-branch-policies")
    error_message = "gh_setup_commands missing infra-global branch policy"
  }

  assert {
    condition = (
      strcontains(output.gh_setup_commands, "# --- environment: test-infra (gh-bbm-test)") &&
      strcontains(output.gh_setup_commands, "repos/cse416-fa26-sixseven/bug-bounty-marketplace/environments/test-infra/deployment-branch-policies") &&
      strcontains(output.gh_setup_commands, "gh variable set AZURE_CLIENT_ID --repo cse416-fa26-sixseven/bug-bounty-marketplace --env test-infra") &&
      jsondecode(local.env_payload["test-infra"]).reviewers == [] &&
      alltrue([for e in ["test", "preview", "infra-global", "contracts-sepolia", "staging", "prod", "prod-power"] :
      strcontains(output.gh_setup_commands, "# --- environment: ${e} (")])
    )
    error_message = "gh_setup_commands must create test-infra (main-only, no reviewers) and keep the other envs"
  }

  assert {
    condition     = strcontains(output.global_tfvars_hint, "secret_officer_sp_object_ids = [\"77777777-7777-7777-7777-777777777777\"]") && !strcontains(output.global_tfvars_hint, "secret_officer_object_ids")
    error_message = "global_tfvars_hint must emit secret_officer_sp_object_ids with the gh-bbm-global SP"
  }

  assert {
    condition     = jsondecode(local.env_payload["prod"]).reviewers == [{ type = "User", id = 12345 }]
    error_message = "prod payload must carry the configured reviewer"
  }

  assert {
    condition     = length(azurerm_resource_provider_registration.this) == 14 && !contains(keys(azurerm_resource_provider_registration.this), "Microsoft.App")
    error_message = "expected 14 resource provider registrations (no Microsoft.App)"
  }

  assert {
    condition     = length(azurerm_role_assignment.power_operator) == 6 && length(azurerm_role_assignment.admin_aks) == 3
    error_message = "unexpected human role assignment count"
  }
}

# Without github_reviewer_ids, reviewer-gated envs must not send `reviewers`
# (a re-run would otherwise wipe reviewers added by hand); unattended envs
# still send an explicit empty list.
run "no_reviewer_ids" {
  command = plan

  variables {
    github_reviewer_ids = []
  }

  assert {
    condition = alltrue([
      for env in ["prod", "infra-global", "contracts-sepolia"] : !contains(keys(jsondecode(local.env_payload[env])), "reviewers")
    ])
    error_message = "reviewer-gated env payloads must omit reviewers when github_reviewer_ids is empty"
  }

  assert {
    condition     = jsondecode(local.env_payload["prod-power"]).reviewers == [] && jsondecode(local.env_payload["staging"]).reviewers == []
    error_message = "unattended envs must explicitly clear reviewers"
  }

  assert {
    condition     = strcontains(output.gh_setup_commands, "NOTE: github_reviewer_ids is empty")
    error_message = "missing manual-reviewer note"
  }
}

run "rejects_empty_dns_zone" {
  command = plan

  variables {
    dns_zone_name = ""
  }

  expect_failures = [var.dns_zone_name]
}

run "rejects_bad_dns_zone" {
  command = plan

  variables {
    dns_zone_name = "Not A Zone."
  }

  expect_failures = [var.dns_zone_name]
}

# up.sh may list every registered namespace; unknown ones must be ignored.
run "preregistered_providers_filtered" {
  command = plan

  variables {
    preregistered_resource_providers = ["Microsoft.Network", "Microsoft.ResourceHealth"]
  }

  assert {
    condition     = length(azurerm_resource_provider_registration.this) == 14
    error_message = "preregistered providers outside the managed list must be ignored"
  }
}

# Region switch (up.sh --location): names and repo variables follow location;
# location_abbr = null derives the code from modules/naming.
run "other_region" {
  command = plan

  variables {
    location      = "canadacentral"
    location_abbr = null
  }

  assert {
    condition = (
      azurerm_resource_group.tfstate.name == "rg-bbm-tfstate-cac" &&
      azurerm_resource_group.shared.location == "canadacentral" &&
      azurerm_resource_group.env_compute["prod"].name == "rg-bbm-prod-compute-cac" &&
      strcontains(output.gh_setup_commands, "gh variable set AZURE_LOCATION_ABBR --repo cse416-fa26-sixseven/bug-bounty-marketplace --body 'cac'")
    )
    error_message = "names and AZURE_LOCATION_ABBR must follow location"
  }
}
