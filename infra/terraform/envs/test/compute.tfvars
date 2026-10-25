# stacks/compute — test (CI runs + PR previews, a namespace each). Remote state location comes from the environment:
#   TF_VAR_tfstate_account (= TFSTATE_ACCOUNT repo var), optional TF_VAR_tfstate_resource_group.
# Do not set tfstate_* here: -var-file values would override the TF_VAR_* that CI exports.
subscription_id = "00000000-0000-0000-0000-000000000000"
env             = "test"

# Minor version only (patch channel keeps the patch current). Check GA versions
# before the first apply: az aks get-versions -l eastus2 -o table
kubernetes_version = "1.34"

# One system pool runs everything; up to 3 nodes for concurrent CI namespaces.
system_vm_size              = "Standard_B2als_v2"
system_min_count            = 1
system_max_count            = 3
system_only_critical_addons = false

apps_pool_enabled    = false
sandbox_pool_enabled = false
container_insights   = false
