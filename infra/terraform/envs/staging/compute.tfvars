# stacks/compute — staging. Remote state location comes from the environment:
#   TF_VAR_tfstate_account (= TFSTATE_ACCOUNT repo var), optional TF_VAR_tfstate_resource_group.
# Do not set tfstate_* here: -var-file values would override the TF_VAR_* that CI exports.
subscription_id = "00000000-0000-0000-0000-000000000000"
env             = "staging"
location        = "northcentralus" # infra/up.sh --location (same in every tfvars)
location_abbr   = "ncus"

# Minor version only (patch channel keeps the patch current). Check GA versions
# before the first apply: az aks get-versions -l <location> -o table (infra/up.sh checks it)
kubernetes_version = "1.34"

# One small system pool runs everything (no CriticalAddonsOnly taint).
system_vm_size              = "Standard_B2als_v2"
system_min_count            = 1
system_max_count            = 2
system_only_critical_addons = false

apps_pool_enabled    = false
sandbox_pool_enabled = false # Kata sandbox; needs Dsv5 quota
container_insights   = false
