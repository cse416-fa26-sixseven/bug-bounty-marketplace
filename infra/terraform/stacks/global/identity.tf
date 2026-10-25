# Registry data-plane grants for the CI push identities, on resources that
# only exist after this stack runs. The registry is in ABAC repository
# permissions mode (modules/acr), so these use the Container Registry
# Repository roles (AcrPull/AcrPush are not honored there). gh-bbm-global may
# only assign roles in global_delegable_roles, to service principals (ABAC
# condition in stacks/bootstrap/identities.tf).

locals {
  acr_data_action = "Microsoft.ContainerRegistry/registries/repositories"
  acr_repo_name   = "@Request[Microsoft.ContainerRegistry/registries/repositories:name]"

  # Repository prefixes (trailing slash required: 'bbm-preview' alone would
  # also match 'bbm-previewx/...').
  preview_repo_prefix = "bbm-preview/"
  mirror_repo_prefix  = "mirror/"

  # gh-bbm-preview: push/pull only under bbm-preview/, plus read mirror/ (the
  # preview workflow checks that mirror/postgres exists). Every other
  # repository, bbm/* included, is denied. Same shape as Microsoft's
  # repository-prefix examples
  # (learn.microsoft.com/azure/container-registry/container-registry-rbac-abac-repository-permissions).
  preview_acr_condition = join(" ", [
    "((!(ActionMatches{'${local.acr_data_action}/content/read'})",
    "AND !(ActionMatches{'${local.acr_data_action}/metadata/read'}))",
    "OR (${local.acr_repo_name} StringStartsWithIgnoreCase '${local.preview_repo_prefix}'",
    "OR ${local.acr_repo_name} StringStartsWithIgnoreCase '${local.mirror_repo_prefix}'))",
    "AND",
    "((!(ActionMatches{'${local.acr_data_action}/content/write'})",
    "AND !(ActionMatches{'${local.acr_data_action}/metadata/write'}))",
    "OR (${local.acr_repo_name} StringStartsWithIgnoreCase '${local.preview_repo_prefix}'))",
  ])
}

# gh-bbm-ephemeral (environment `test`, main only): pushes the sha-* images
# staging/prod deploy and reads mirror/*. Registry-wide (no condition).
resource "azurerm_role_assignment" "ephemeral_ci_acr_writer" {
  count = var.ephemeral_ci_principal_id == null ? 0 : 1

  scope                = module.acr.id
  role_definition_name = "Container Registry Repository Writer"
  principal_id         = var.ephemeral_ci_principal_id
  principal_type       = "ServicePrincipal"
}

# gh-bbm-preview (environment `preview`, any PR branch): repository-scoped,
# so a PR that edits a workflow still cannot overwrite bbm/*:sha-* tags.
resource "azurerm_role_assignment" "preview_ci_acr_writer" {
  count = var.preview_ci_principal_id == null ? 0 : 1

  scope                = module.acr.id
  role_definition_name = "Container Registry Repository Writer"
  principal_id         = var.preview_ci_principal_id
  principal_type       = "ServicePrincipal"
  condition            = local.preview_acr_condition
  condition_version    = "2.0"
}

# Build identities only (service principals / managed identities), so the
# assignment satisfies the ABAC PrincipalType condition on gh-bbm-global.
resource "azurerm_role_assignment" "acr_push" {
  for_each = toset(var.acr_push_principal_ids)

  scope                = module.acr.id
  role_definition_name = "Container Registry Repository Writer"
  principal_id         = each.key
  principal_type       = "ServicePrincipal"
}
