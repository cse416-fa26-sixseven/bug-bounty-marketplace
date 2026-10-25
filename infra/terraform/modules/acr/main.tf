resource "azurerm_container_registry" "this" {
  name                = var.name
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = var.sku
  # Pulls/pushes use Entra identities (Container Registry Repository
  # Reader/Writer roles), never the admin user.
  admin_enabled = false
  # "RBAC Registry + ABAC Repository Permissions": the Repository roles can
  # carry ABAC conditions on the repository name (the PR-preview identity may
  # only push bbm-preview/*). Legacy AcrPull/AcrPush are NOT honored in this
  # mode, and Owner/Contributor/Reader grant no registry data access.
  role_assignment_mode = var.role_assignment_mode
  tags                 = var.tags
}
