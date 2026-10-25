# GitHub Actions OIDC identities and their RBAC. See the infra spec
# "GitHub Environments / OIDC" section for the authoritative matrix.

locals {
  # Built-in role definition GUIDs that CI identities may hand out through the
  # ABAC-constrained "Role Based Access Control Administrator" role. Never
  # include Owner / User Access Administrator / RBAC Administrator here.
  role_guids = {
    acr_pull                    = "7f951dda-4ed3-4680-a7ca-43fe172d538d"
    acr_push                    = "8311e382-0749-4cb8-b61a-304f252e45ec"
    aks_rbac_cluster_admin      = "b1ff04bb-8a4e-4dc4-8eb5-8693973ce19b"
    aks_rbac_writer             = "a7ffa36f-339b-4b5c-8bdf-e2c188b2c0eb"
    dns_zone_contributor        = "befefa01-2a29-4197-83a8-272ff33ce314"
    kv_secrets_officer          = "b86a8fe4-44ce-4948-aee5-eccb2c155cd7"
    kv_secrets_user             = "4633458b-17de-408a-b874-0445c86b69e6"
    managed_identity_operator   = "f1a07417-d97a-45cb-824c-7a7467783830"
    monitoring_metrics_pub      = "3913510d-42f4-4e42-8a64-420c390055eb"
    network_contributor         = "4d97b98b-1d4f-4787-a291-c67834d212e7"
    private_dns_zone_contrib    = "b12aa53e-6015-4669-85d0-8515ebb3ae7f"
    storage_blob_data_contrib   = "ba92f5b4-2d11-453d-a403-e96b0029c9fe"
    storage_blob_data_reader    = "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1"
    storage_queue_data_contrib  = "974c5e8b-45b9-4653-ba55-5f855dd0fb88"
    storage_queue_data_reader   = "19e7f393-937e-4f77-808e-94535e297925"
    storage_queue_msg_processor = "8a0f0c08-91a1-4084-bc3d-661d67233fed"
    storage_queue_msg_sender    = "c6a89b2d-59bc-44d0-9896-0f6e12d7b80a"
  }

  # Roles the env (test/staging/prod) identities may assign inside their own
  # RGs: workload identities -> KV/storage/queue, AKS identity -> network/DNS/MI,
  # cert-manager identity -> DNS Zone Contributor on the env's public zones.
  env_delegable_roles = [for k in [
    "acr_pull", "aks_rbac_cluster_admin", "aks_rbac_writer", "dns_zone_contributor", "kv_secrets_officer", "kv_secrets_user",
    "managed_identity_operator", "monitoring_metrics_pub", "network_contributor", "private_dns_zone_contrib",
    "storage_blob_data_contrib", "storage_blob_data_reader", "storage_queue_data_contrib",
    "storage_queue_data_reader", "storage_queue_msg_processor", "storage_queue_msg_sender",
  ] : local.role_guids[k]]

  # Roles the global identity may assign inside the shared RG (ephemeral CI and
  # build identities -> AcrPush, shared KV officers/readers).
  global_delegable_roles = [for k in [
    "acr_push", "kv_secrets_officer", "kv_secrets_user",
  ] : local.role_guids[k]]

  # Env identities may only grant AcrPull (kubelet identity) in the shared RG.
  shared_acr_pull_only = [local.role_guids.acr_pull]

  # ABAC condition: role assignment writes are only allowed for the listed role
  # definitions AND service-principal assignees (workload/managed identities),
  # so a compromised CI identity cannot grant roles to a user or group it
  # controls. Deletes are limited to the same role definitions.
  rbac_condition = { for k, guids in {
    env    = local.env_delegable_roles
    global = local.global_delegable_roles
    shared = local.shared_acr_pull_only
    } : k => join(" ", [
      "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})) OR",
      "(@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${join(", ", guids)}}",
      "AND @Request[Microsoft.Authorization/roleAssignments:PrincipalType] StringEqualsIgnoreCase 'ServicePrincipal'))",
      "AND",
      "((!(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})) OR",
      "(@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${join(", ", guids)}}))",
  ]) }

  # ---- state access (ABAC on the tfstate container) -------------------------
  # Each CI identity may only touch its own state keys. Blob path excludes the
  # container name; an entry ending in "/" is a prefix, anything else an exact
  # key. List Blobs (Blob.List) has no blob path attribute, so listing the
  # container stays unconditional (names only, never contents). Leases (the
  # azurerm backend's state lock) are blobs/write on the key's own blob, so
  # locking works wherever writes are allowed. Bootstrap state is human-only.
  blob_action    = "Microsoft.Storage/storageAccounts/blobServices/containers/blobs"
  blob_path_attr = "@Resource[Microsoft.Storage/storageAccounts/blobServices/containers/blobs:path]"

  state_access = {
    # Ephemeral namespaces only read helm_values from the test env's state.
    ephemeral = { write = [], read_only = ["global.tfstate", "test/"] }
    global    = { write = ["global.tfstate"], read_only = [] }
    test      = { write = ["test/"], read_only = ["global.tfstate"] }
    staging   = { write = ["staging/"], read_only = ["global.tfstate"] }
    prod      = { write = ["prod/"], read_only = ["global.tfstate"] }
    # PR/main plans never see prod: prod plans run in the `prod` environment as gh-bbm-prod.
    plan = { write = [], read_only = ["global.tfstate", "staging/", "test/"] }
  }

  state_path_match = { for k, a in local.state_access : k => {
    for mode, paths in { read = concat(a.write, a.read_only), write = a.write } : mode => join(" OR ", [
      for p in paths : endswith(p, "/") ? "${local.blob_path_attr} StringStartsWith '${p}'" : "${local.blob_path_attr} StringEquals '${p}'"
    ])
  } }

  # Reads (except List Blobs) need a readable path; write/add/delete/move need a
  # writable path. Read-only identities get the read clause only (BBM tfstate
  # reader has no write data actions).
  state_condition = { for k, a in local.state_access : k => join(" ", concat(
    [
      "((!(ActionMatches{'${local.blob_action}/read'} AND NOT SubOperationMatches{'Blob.List'}))",
      "OR (${local.state_path_match[k].read}))",
    ],
    length(a.write) == 0 ? [] : [
      "AND",
      "((!(ActionMatches{'${local.blob_action}/write'})",
      "AND !(ActionMatches{'${local.blob_action}/add/action'})",
      "AND !(ActionMatches{'${local.blob_action}/delete'})",
      "AND !(ActionMatches{'${local.blob_action}/move/action'}))",
      "OR (${local.state_path_match[k].write}))",
    ],
  )) }

  # Custom tfstate roles (below), not the Storage Blob Data built-ins: those
  # also carry control-plane containers/write + containers/delete, which the
  # blob-path ABAC conditions cannot constrain.
  state_role_kind = { for k, a in local.state_access : k => length(a.write) == 0 ? "reader" : "writer" }

  state_role = { for k, a in local.state_access : k => {
    key                = "tfstate"
    scope              = local.tfstate_container_scope
    role_definition_id = azurerm_role_definition.tfstate[local.state_role_kind[k]].role_definition_resource_id
    condition          = local.state_condition[k]
    condition_version  = "2.0"
  } }

  rg_ids = {
    shared = azurerm_resource_group.shared.id
  }

  # Grants shared by gh-bbm-test, gh-bbm-staging and gh-bbm-prod, parameterised by env.
  env_identity_roles = { for env in local.persistent_envs : env => [
    { key = "data-contributor", scope = azurerm_resource_group.env_data[env].id, role_definition_name = "Contributor" },
    { key = "compute-contributor", scope = azurerm_resource_group.env_compute[env].id, role_definition_name = "Contributor" },
    {
      key                  = "data-rbac-admin"
      scope                = azurerm_resource_group.env_data[env].id
      role_definition_name = "Role Based Access Control Administrator"
      condition            = local.rbac_condition.env
      condition_version    = "2.0"
    },
    {
      key                  = "compute-rbac-admin"
      scope                = azurerm_resource_group.env_compute[env].id
      role_definition_name = "Role Based Access Control Administrator"
      condition            = local.rbac_condition.env
      condition_version    = "2.0"
    },
    { key = "compute-aks-admin", scope = azurerm_resource_group.env_compute[env].id, role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin" },
    # Data stack creates the env Key Vault and its TF-generated secrets.
    { key = "data-kv-secrets", scope = azurerm_resource_group.env_data[env].id, role_definition_name = "Key Vault Secrets Officer" },
    # Read ACR / LAW / UAMIs in the shared RG and grant the kubelet AcrPull.
    { key = "shared-reader", scope = local.rg_ids.shared, role_definition_name = "Reader" },
    {
      key                  = "shared-acrpull-admin"
      scope                = local.rg_ids.shared
      role_definition_name = "Role Based Access Control Administrator"
      condition            = local.rbac_condition.shared
      condition_version    = "2.0"
    },
    local.state_role[env],
  ] }
}

# Custom role for on-demand power management (az aks stop/start,
# az postgres flexible-server stop/start, power-state tags).
resource "azurerm_role_definition" "power_operator" {
  name        = "BBM Power Operator"
  scope       = local.subscription_scope
  description = "Pause/resume BBM AKS clusters and PostgreSQL flexible servers and update power-state tags."

  permissions {
    actions = [
      "Microsoft.ContainerService/managedClusters/read",
      "Microsoft.ContainerService/managedClusters/start/action",
      "Microsoft.ContainerService/managedClusters/stop/action",
      "Microsoft.DBforPostgreSQL/flexibleServers/read",
      "Microsoft.DBforPostgreSQL/flexibleServers/start/action",
      "Microsoft.DBforPostgreSQL/flexibleServers/stop/action",
      "Microsoft.Resources/subscriptions/resourceGroups/read",
      "Microsoft.Resources/tags/read",
      "Microsoft.Resources/tags/write",
    ]
  }

  assignable_scopes = [local.subscription_scope]
}

# Data-plane-only roles for CI state access, assigned on the tfstate container
# with the ABAC conditions above. The only control-plane action is
# containers/read, so a leaked CI token cannot delete or reconfigure the
# container. Defined (and assignable) at the tfstate RG: custom-role
# assignable scopes must be a subscription, RG or management group.
# Humans/admins keep the built-in Storage Blob Data Contributor (state.tf).
locals {
  tfstate_roles = {
    writer = {
      name         = "BBM tfstate writer"
      description  = "Read/write/lease Terraform state blobs (path-limited by ABAC). No container create/delete."
      data_actions = [for a in ["read", "write", "add/action", "delete", "move/action"] : "${local.blob_action}/${a}"]
    }
    reader = {
      name         = "BBM tfstate reader"
      description  = "Read Terraform state blobs (path-limited by ABAC). No container create/delete."
      data_actions = ["${local.blob_action}/read"]
    }
  }
}

resource "azurerm_role_definition" "tfstate" {
  for_each = local.tfstate_roles

  name        = each.value.name
  scope       = azurerm_resource_group.tfstate.id
  description = each.value.description

  permissions {
    actions      = ["Microsoft.Storage/storageAccounts/blobServices/containers/read"]
    data_actions = each.value.data_actions
  }

  assignable_scopes = [azurerm_resource_group.tfstate.id]
}

locals {
  # Kept as a local (not inline in the module call) so tests can assert on it.
  oidc_identities = {
    # Read-only plan identity for PRs and main. It only READS state (global,
    # staging, test; never prod or bootstrap), so plan jobs must run
    # with -lock=false. No Key Vault data-plane access: stacks that refresh
    # secret values (data) are planned by their env identity instead.
    # Accepted trade-off: staging/ state holds TF-generated staging secrets
    # (PostgreSQL admin password, database-url), so PR plans can read them.
    # prod/ is excluded for exactly this reason.
    "gh-bbm-plan" = {
      extra_subjects = ["pull_request", "ref:refs/heads/main"]
      role_assignments = [
        { key = "sub-reader", scope = local.subscription_scope, role_definition_name = "Reader" },
        local.state_role.plan,
      ]
    }

    # CI-run / PR-preview namespaces on the test cluster (no Terraform): helm
    # installs into its own namespaces, resumes a paused test env, reads
    # helm_values from test/ state. AcrPush is granted by stacks/global (the
    # registry does not exist yet at bootstrap time).
    "gh-bbm-ephemeral" = {
      environments = ["test", "preview"]
      role_assignments = [
        { key = "test-compute-aks-admin", scope = azurerm_resource_group.env_compute["test"].id, role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin" },
        { key = "test-compute-aks-user", scope = azurerm_resource_group.env_compute["test"].id, role_definition_name = "Azure Kubernetes Service Cluster User Role" },
        { key = "test-data-reader", scope = azurerm_resource_group.env_data["test"].id, role_definition_name = "Reader" },
        { key = "test-data-power-operator", scope = azurerm_resource_group.env_data["test"].id, role_definition_id = azurerm_role_definition.power_operator.role_definition_resource_id },
        { key = "test-compute-power-operator", scope = azurerm_resource_group.env_compute["test"].id, role_definition_id = azurerm_role_definition.power_operator.role_definition_resource_id },
        { key = "shared-reader", scope = local.rg_ids.shared, role_definition_name = "Reader" },
        local.state_role.ephemeral,
      ]
    }

    "gh-bbm-global" = {
      environments = ["infra-global", "contracts-sepolia"]
      role_assignments = [
        { key = "shared-contributor", scope = local.rg_ids.shared, role_definition_name = "Contributor" },
        {
          key                  = "shared-rbac-admin"
          scope                = local.rg_ids.shared
          role_definition_name = "Role Based Access Control Administrator"
          condition            = local.rbac_condition.global
          condition_version    = "2.0"
        },
        # Shared KV data plane: contracts-sepolia reads the Sepolia secrets.
        # (Terraform itself never writes secret values into the shared KV.)
        { key = "shared-kv-secrets", scope = local.rg_ids.shared, role_definition_name = "Key Vault Secrets Officer" },
        # Budgets (subscription + RG) live in stacks/global.
        { key = "sub-cost-mgmt", scope = local.subscription_scope, role_definition_name = "Cost Management Contributor" },
        local.state_role.global,
      ]
    }

    # test env infra (terraform.yml, env-power.yml, platform installs).
    "gh-bbm-test" = {
      environments     = ["test-infra"]
      role_assignments = local.env_identity_roles.test
    }

    "gh-bbm-staging" = {
      environments     = ["staging"]
      role_assignments = local.env_identity_roles.staging
    }

    "gh-bbm-prod" = {
      environments     = ["prod"]
      role_assignments = local.env_identity_roles.prod
    }

    # Scheduled/unattended prod pause+resume (the reviewer-free `prod-power`
    # environment). Only the custom power role on the prod RGs: no Contributor,
    # no RBAC admin and no state access, so skipping the prod reviewer gate
    # cannot change prod infrastructure.
    "gh-bbm-prod-power" = {
      environments = ["prod-power"]
      role_assignments = [for layer, rg in {
        data    = azurerm_resource_group.env_data["prod"].id
        compute = azurerm_resource_group.env_compute["prod"].id
        } : {
        key                = "${layer}-power-operator"
        scope              = rg
        role_definition_id = azurerm_role_definition.power_operator.role_definition_resource_id
      }]
    }
  }
}

module "github_oidc" {
  source = "../../modules/github-oidc"

  repo       = var.github_repo
  identities = local.oidc_identities
}

# ---- human access -----------------------------------------------------------
resource "azurerm_role_assignment" "admin_aks" {
  for_each = merge([
    for env in local.persistent_envs : {
      for oid in var.admin_object_ids : "${env}/${oid}" => { env = env, oid = oid }
    }
  ]...)

  scope                = azurerm_resource_group.env_compute[each.value.env].id
  role_definition_name = "Azure Kubernetes Service RBAC Cluster Admin"
  principal_id         = each.value.oid
}

resource "azurerm_role_assignment" "power_operator" {
  for_each = merge([
    for env in local.persistent_envs : merge([
      for layer in ["data", "compute"] : {
        for oid in var.power_operator_object_ids : "${env}-${layer}/${oid}" => {
          scope = layer == "data" ? azurerm_resource_group.env_data[env].id : azurerm_resource_group.env_compute[env].id
          oid   = oid
        }
      }
    ]...)
  ]...)

  scope              = each.value.scope
  role_definition_id = azurerm_role_definition.power_operator.role_definition_resource_id
  principal_id       = each.value.oid
}
