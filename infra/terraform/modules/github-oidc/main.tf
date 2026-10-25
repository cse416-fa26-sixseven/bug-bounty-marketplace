# One Entra app registration + service principal per CI identity, trusted by
# GitHub Actions OIDC (no client secrets anywhere), plus its Azure RBAC grants.

data "azuread_client_config" "current" {}

locals {
  issuer   = "https://token.actions.githubusercontent.com"
  audience = "api://AzureADTokenExchange"
  # GitHub's default subject is repo:<owner>/<name>:...; repos with the
  # immutable subject setting send repo:<owner>@<id>/<name>@<id>:... instead.
  subject_prefix = var.subject_prefix != "" ? var.subject_prefix : "repo:${var.repo}"
  owners         = distinct(concat([data.azuread_client_config.current.object_id], var.owner_object_ids))
  # Entra makes the creator of an app registration its owner automatically, so
  # an azuread_application_owner for the caller fails with "already exists".
  extra_app_owners = [for o in local.owners : o if o != data.azuread_client_config.current.object_id]

  # "<identity>/<subject-suffix>" => {identity, subject}
  credentials = merge([
    for name, id in var.identities : {
      for s in concat([for e in id.environments : "environment:${e}"], id.extra_subjects) :
      "${name}/${s}" => {
        identity = name
        subject  = "${local.subject_prefix}:${s}"
        # Credential display names allow only [A-Za-z0-9_-], max 120 chars.
        display_name = substr(replace(s, "/[^A-Za-z0-9_-]/", "-"), 0, 120)
      }
    }
  ]...)

  # "<identity>/<key or index>" => assignment
  role_assignments = merge([
    for name, id in var.identities : {
      for i, ra in id.role_assignments :
      "${name}/${coalesce(ra.key, tostring(i))}" => merge(ra, { identity = name })
    }
  ]...)
}

resource "azuread_application_registration" "this" {
  for_each = var.identities

  display_name     = each.key
  sign_in_audience = "AzureADMyOrg"
  notes            = "GitHub Actions OIDC identity for ${var.repo}. Managed by Terraform (infra/terraform/stacks/bootstrap)."
}

resource "azuread_application_owner" "this" {
  for_each = merge([
    for name in keys(var.identities) : {
      for o in local.extra_app_owners : "${name}/${o}" => { identity = name, owner = o }
    }
  ]...)

  application_id  = azuread_application_registration.this[each.value.identity].id
  owner_object_id = each.value.owner
}

resource "azuread_service_principal" "this" {
  for_each = var.identities

  client_id = azuread_application_registration.this[each.key].client_id
  owners    = local.owners
}

resource "azuread_application_federated_identity_credential" "this" {
  for_each = local.credentials

  application_id = azuread_application_registration.this[each.value.identity].id
  display_name   = each.value.display_name
  description    = "GitHub Actions: ${each.value.subject}"
  audiences      = [local.audience]
  issuer         = local.issuer
  subject        = each.value.subject
}

resource "azurerm_role_assignment" "this" {
  for_each = local.role_assignments

  scope                            = each.value.scope
  role_definition_name             = each.value.role_definition_name
  role_definition_id               = each.value.role_definition_id
  condition                        = each.value.condition
  condition_version                = each.value.condition_version
  principal_id                     = azuread_service_principal.this[each.value.identity].object_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
  description                      = "GitHub OIDC identity ${each.value.identity} (managed by Terraform)"
}
