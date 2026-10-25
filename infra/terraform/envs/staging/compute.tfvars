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
system_max_count            = 1
system_only_critical_addons = false

apps_pool_enabled    = false
sandbox_pool_enabled = false # Kata sandbox; needs Dsv5 quota
container_insights   = false

# Azure for Students: 6 vCPUs per region and three clusters, so each cluster is
# pinned to one B2als_v2 node (6/6). No surge node fits, so automatic upgrades
# are off; upgrade by hand after pausing another env, or restore the defaults
# (min 1/max 2-3, patch/NodeImage) on a subscription with more quota.
automatic_upgrade_channel = "none"
node_os_upgrade_channel   = "None"
