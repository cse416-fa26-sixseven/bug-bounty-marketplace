# stacks/compute — prod. Remote state location comes from the environment:
#   TF_VAR_tfstate_account (= TFSTATE_ACCOUNT repo var), optional TF_VAR_tfstate_resource_group.
# Do not set tfstate_* here: -var-file values would override the TF_VAR_* that CI exports.
subscription_id = "00000000-0000-0000-0000-000000000000"
env             = "prod"

# Minor version only (patch channel keeps the patch current). Check GA versions
# before the first apply: az aks get-versions -l eastus2 -o table
kubernetes_version = "1.34"

# Uptime SLA for prod only (ADR 0002); test and staging stay on Free.
aks_sku_tier = "Standard"

# System pool reserved for critical add-ons; workloads go to the apps pool.
system_vm_size              = "Standard_B2als_v2"
system_min_count            = 1
system_max_count            = 2
system_only_critical_addons = true

apps_pool_enabled = true
apps_vm_size      = "Standard_B2als_v2"
apps_min_count    = 1
apps_max_count    = 3

sandbox_pool_enabled = false # Kata sandbox; needs Dsv5 quota
container_insights   = true
