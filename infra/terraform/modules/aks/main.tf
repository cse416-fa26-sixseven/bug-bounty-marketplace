# AKS cluster for one env (test/staging/prod). Disposable: everything
# durable (VNet, PIP, PG, KV, storage, UAMIs) lives in the data stack, so this
# can be destroyed and re-applied ("down"/"up") without data loss.

locals {
  # Container Insights stream group (perf, inventory, events, ContainerLogV2).
  ci_streams = ["Microsoft-ContainerInsights-Group-Default"]
}

# Kubelet (node) identity, created here rather than by AKS so AcrPull exists
# before the first node pulls an image. It lives in the compute RG and goes
# away with the cluster on `down`.
resource "azurerm_user_assigned_identity" "kubelet" {
  name                = var.kubelet_identity_name
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

# A user-assigned control-plane identity must be able to assign the kubelet
# identity to the node VMSS.
resource "azurerm_role_assignment" "cluster_kubelet_operator" {
  scope                            = azurerm_user_assigned_identity.kubelet.id
  role_definition_name             = "Managed Identity Operator"
  principal_id                     = var.cluster_identity_principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# Env CI identities may assign only AcrPull in the shared RG (bootstrap ABAC
# condition `shared_acr_pull_only`).
resource "azurerm_role_assignment" "kubelet_acr_pull" {
  scope                            = var.acr_id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_user_assigned_identity.kubelet.principal_id
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# Role assignments take a while to propagate. Creating the cluster straight
# after them fails with CustomKubeletIdentityMissingPermissionError (on the
# first apply and on every `up`, since the kubelet identity is recreated).
resource "time_sleep" "rbac_propagation" {
  create_duration = var.rbac_propagation_wait
  triggers = {
    kubelet_operator = azurerm_role_assignment.cluster_kubelet_operator.id
    kubelet_acr_pull = azurerm_role_assignment.kubelet_acr_pull.id
  }
}

resource "azurerm_kubernetes_cluster" "this" {
  name                = var.name
  location            = var.location
  resource_group_name = var.resource_group_name
  node_resource_group = var.node_resource_group_name
  dns_prefix          = var.dns_prefix
  kubernetes_version  = var.kubernetes_version
  sku_tier            = var.sku_tier
  support_plan        = "KubernetesOfficial"

  # Patch channel moves only the patch level within var.kubernetes_version,
  # which is a minor alias, so it never drifts from config.
  automatic_upgrade_channel = "patch"
  node_os_upgrade_channel   = "NodeImage"

  maintenance_window_auto_upgrade {
    frequency   = "Weekly"
    interval    = 1
    duration    = 4
    day_of_week = "Sunday"
    start_time  = "06:00"
    utc_offset  = "+00:00"
  }

  maintenance_window_node_os {
    frequency   = "Weekly"
    interval    = 1
    duration    = 4
    day_of_week = "Sunday"
    start_time  = "06:00"
    utc_offset  = "+00:00"
  }

  identity {
    type         = "UserAssigned"
    identity_ids = [var.cluster_identity_id]
  }

  kubelet_identity {
    client_id                 = azurerm_user_assigned_identity.kubelet.client_id
    object_id                 = azurerm_user_assigned_identity.kubelet.principal_id
    user_assigned_identity_id = azurerm_user_assigned_identity.kubelet.id
  }

  # Entra ID auth with Azure RBAC; no static admin kubeconfig.
  local_account_disabled = true
  azure_active_directory_role_based_access_control {
    tenant_id          = var.tenant_id
    azure_rbac_enabled = true
  }

  oidc_issuer_enabled       = true
  workload_identity_enabled = true

  image_cleaner_enabled        = true
  image_cleaner_interval_hours = 168

  default_node_pool {
    name                         = "system"
    temporary_name_for_rotation  = "systemtmp"
    vm_size                      = var.system_pool.vm_size
    os_sku                       = "AzureLinux"
    os_disk_size_gb              = var.system_pool.os_disk_size_gb
    vnet_subnet_id               = var.subnet_id
    auto_scaling_enabled         = true
    min_count                    = var.system_pool.min_count
    max_count                    = var.system_pool.max_count
    only_critical_addons_enabled = var.system_pool.only_critical_addons_enabled
    node_labels                  = { "bbm.io/pool" = "system" }
    tags                         = var.tags

    upgrade_settings {
      max_surge                     = "10%"
      drain_timeout_in_minutes      = 30
      node_soak_duration_in_minutes = 0
    }
  }

  auto_scaler_profile {
    expander                      = "least-waste"
    scale_down_unneeded           = "5m"
    scale_down_delay_after_add    = "5m"
    skip_nodes_with_local_storage = false
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
    load_balancer_sku   = "standard"
    outbound_type       = "loadBalancer"
    pod_cidr            = var.pod_cidr
    service_cidr        = var.service_cidr
    dns_service_ip      = var.dns_service_ip
  }

  # Secrets Store CSI driver; pods authenticate with workload identity.
  key_vault_secrets_provider {
    secret_rotation_enabled  = true
    secret_rotation_interval = "2m"
  }

  # No web_app_routing block: ingress is the app routing Gateway API
  # implementation (azapi_update_resource.app_routing_gateway_api below), not
  # the add-on's managed NGINX, and DNS records are managed by Terraform, not
  # by the add-on.

  workload_autoscaler_profile {
    keda_enabled = true
  }

  dynamic "oms_agent" {
    for_each = var.container_insights_enabled ? [1] : []
    content {
      log_analytics_workspace_id      = var.log_analytics_workspace_id
      msi_auth_for_monitoring_enabled = true
    }
  }

  tags = var.tags

  lifecycle {
    # The cluster autoscaler owns node_count. web_app_routing: azurerm (API
    # 2025-10-01) cannot express ingressProfile.gatewayAPI or
    # webAppRouting.gatewayAPIImplementations, which azapi sets below; if the
    # RP ever reports the shared ingressProfile.webAppRouting as a block,
    # azurerm must not "fix" it by rewriting the whole ingressProfile.
    ignore_changes = [default_node_pool[0].node_count, web_app_routing]
  }

  depends_on = [time_sleep.rbac_propagation]
}

# Ingress (ADR 0002 section 3): the Managed Gateway API CRDs (standard
# channel, bundle pinned to the Kubernetes minor) plus the application
# routing add-on's Gateway API implementation, a sidecar-less istiod in
# aks-istio-system that reconciles Gateways of GatewayClass approuting-istio.
# azurerm (4.x and 5.x) has no argument for either, so this is the azapi
# update Microsoft documents for Terraform
# (https://learn.microsoft.com/azure/aks/app-routing-gateway-api, Terraform
# tab): equivalent to `az aks update --enable-gateway-api
# --enable-app-routing-istio`. It GETs the cluster, merges this body and PUTs
# it back; the Gateway itself (static PIP, TLS) is in deploy/helm/bbm-platform.
resource "azapi_update_resource" "app_routing_gateway_api" {
  type        = "Microsoft.ContainerService/managedClusters@2026-03-01"
  resource_id = azurerm_kubernetes_cluster.this.id

  body = {
    properties = {
      ingressProfile = {
        gatewayAPI = {
          installation = "Standard"
        }
        webAppRouting = {
          gatewayAPIImplementations = {
            appRoutingIstio = {
              mode = "Enabled"
            }
          }
        }
      }
    }
  }

  response_export_values = ["properties.ingressProfile"]

  lifecycle {
    # A replaced cluster keeps its resource ID; the OIDC issuer URL is new.
    replace_triggered_by = [azurerm_kubernetes_cluster.this.oidc_issuer_url]
  }
}

resource "azurerm_kubernetes_cluster_node_pool" "apps" {
  count = var.apps_pool.enabled ? 1 : 0

  name                  = "apps"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  mode                  = "User"
  vm_size               = var.apps_pool.vm_size
  os_sku                = "AzureLinux"
  os_disk_size_gb       = var.apps_pool.os_disk_size_gb
  vnet_subnet_id        = var.subnet_id
  auto_scaling_enabled  = true
  min_count             = var.apps_pool.min_count
  max_count             = var.apps_pool.max_count
  node_labels           = { "bbm.io/pool" = "apps" }
  tags                  = var.tags

  upgrade_settings {
    max_surge = "10%"
  }

  lifecycle {
    ignore_changes = [node_count]
  }
}

# Kata (pod sandboxing) pool for untrusted PoC runs. Off by default: needs a
# nested-virtualisation size (Dsv5) and quota a new subscription may lack.
resource "azurerm_kubernetes_cluster_node_pool" "sandbox" {
  count = var.sandbox_pool.enabled ? 1 : 0

  name                  = "sandbox"
  kubernetes_cluster_id = azurerm_kubernetes_cluster.this.id
  mode                  = "User"
  vm_size               = var.sandbox_pool.vm_size
  os_sku                = "AzureLinux"
  workload_runtime      = "KataVmIsolation"
  os_disk_size_gb       = var.sandbox_pool.os_disk_size_gb
  vnet_subnet_id        = var.subnet_id
  auto_scaling_enabled  = true
  min_count             = var.sandbox_pool.min_count
  max_count             = var.sandbox_pool.max_count
  node_labels           = { "bbm.io/pool" = "sandbox" }
  node_taints           = ["bbm.io/sandbox=true:NoSchedule"]
  tags                  = var.tags

  upgrade_settings {
    max_surge = "10%"
  }

  lifecycle {
    ignore_changes = [node_count]
  }
}

# Container Insights with managed-identity auth needs a DCR + association
# (what `az aks enable-addons -a monitoring` creates behind the scenes).
resource "azurerm_monitor_data_collection_rule" "container_insights" {
  count = var.container_insights_enabled ? 1 : 0

  name                = "MSCI-${var.location}-${var.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  kind                = "Linux"
  tags                = var.tags

  destinations {
    log_analytics {
      name                  = "ciworkspace"
      workspace_resource_id = var.log_analytics_workspace_id
    }
  }

  data_flow {
    streams      = local.ci_streams
    destinations = ["ciworkspace"]
  }

  data_sources {
    extension {
      name           = "ContainerInsightsExtension"
      extension_name = "ContainerInsights"
      streams        = local.ci_streams
      extension_json = jsonencode({
        dataCollectionSettings = {
          interval               = "1m"
          namespaceFilteringMode = "Off"
          enableContainerLogV2   = true
        }
      })
    }
  }
}

resource "azurerm_monitor_data_collection_rule_association" "container_insights" {
  count = var.container_insights_enabled ? 1 : 0

  name                    = "ContainerInsightsExtension"
  target_resource_id      = azurerm_kubernetes_cluster.this.id
  data_collection_rule_id = azurerm_monitor_data_collection_rule.container_insights[0].id
  description             = "Container Insights for ${var.name}."
}
