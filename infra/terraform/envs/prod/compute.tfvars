# stacks/compute — prod. Remote state location comes from the environment:
#   TF_VAR_tfstate_account (= TFSTATE_ACCOUNT repo var), optional TF_VAR_tfstate_resource_group.
# Do not set tfstate_* here: -var-file values would override the TF_VAR_* that CI exports.
subscription_id = "b31dcf50-ff11-4bcb-905a-eaeeca6c1f1a"
env             = "prod"
location        = "canadacentral" # this env's region: infra/up.sh --env-location prod=<region>
location_abbr   = "cac"

# Minor version only (patch channel keeps the patch current). Check GA versions
# before the first apply: az aks get-versions -l <location> -o table (infra/up.sh checks it)
kubernetes_version = "1.34"

# Uptime SLA for prod only (ADR 0002); test and staging stay on Free.
aks_sku_tier = "Standard"

# One system pool runs everything while the vCPU quota is 6 (see below).
# With more quota: system_only_critical_addons = true, apps pool on (min 1, max 3).
system_vm_size              = "Standard_B4as_v2"
system_min_count            = 1
system_max_count            = 1
system_only_critical_addons = false

apps_pool_enabled = false
apps_vm_size      = "Standard_B2als_v2"
apps_min_count    = 1
apps_max_count    = 3

sandbox_pool_enabled = false # Kata sandbox; needs Dsv5 quota
container_insights   = true

# Azure for Students: 6 vCPUs per region, so each env has its own region and
# one Standard_B4as_v2 node (4 vCPU / 16 GiB): 4 of 6 vCPU per region. Two
# vCPUs (B2als_v2) could not fit the AKS system pods plus the app routing
# Gateway API's istiod (2 x 500m / 2 GiB, fixed by Azure); ADR 0002 section 8.
# A 4-vCPU surge node does not fit in the remaining 2 (and max unavailable
# cannot be set on a system pool), so automatic upgrades are off. Upgrade by
# recreating the cluster: bump kubernetes_version, then env-power <env> down
# and up (data, IP and DNS survive). Or restore the defaults (min 1/max 2-3,
# patch/NodeImage) on a subscription with more quota.
automatic_upgrade_channel = "none"
node_os_upgrade_channel   = "None"

# KEDA add-on (~0.4 CPU) only serves the analysis worker's ScaledObject, and
# analysis is disabled (deploy/helm/bbm values-*.yaml). Set true before
# enabling analysis with analysis.keda.enabled.
keda_enabled = false
