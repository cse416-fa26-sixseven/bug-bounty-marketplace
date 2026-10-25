# Grants for the ephemeral CI identity (gh-bbm-ephemeral) on resources that
# only exist after this stack runs: it pushes the images its CI-run / PR-preview
# namespaces deploy. gh-bbm-global may only assign roles in
# global_delegable_roles (ABAC condition in stacks/bootstrap/identities.tf).
resource "azurerm_role_assignment" "ephemeral_ci_acr_push" {
  count = var.ephemeral_ci_principal_id == null ? 0 : 1

  scope                = module.acr.id
  role_definition_name = "AcrPush"
  principal_id         = var.ephemeral_ci_principal_id
  principal_type       = "ServicePrincipal"
}

# Build identities only (service principals / managed identities), so the
# assignment satisfies the ABAC PrincipalType condition on gh-bbm-global.
resource "azurerm_role_assignment" "acr_push" {
  for_each = toset(var.acr_push_principal_ids)

  scope                = module.acr.id
  role_definition_name = "AcrPush"
  principal_id         = each.key
  principal_type       = "ServicePrincipal"
}
