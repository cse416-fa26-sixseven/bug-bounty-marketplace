# stacks/compute — test (CI runs + PR previews, a namespace each). Remote state location comes from the environment:
#   TF_VAR_tfstate_account (= TFSTATE_ACCOUNT repo var), optional TF_VAR_tfstate_resource_group.
# Do not set tfstate_* here: -var-file values would override the TF_VAR_* that CI exports.
env           = "test"
location      = "eastus2" # this env's region: infra/up.sh --env-location test=<region>
location_abbr = "eus2"

# Minor version only (patch channel keeps the patch current). Check GA versions
# before the first apply: az aks get-versions -l <location> -o table (infra/up.sh checks it)
kubernetes_version = "1.34"

# One system pool runs everything (no CriticalAddonsOnly taint). 4 vCPU / 16 GiB:
# the app routing Gateway API's istiod needs 2 x 500m / 2 GiB (ADR 0002 section 8).
# This subscription offers no B-series sizes, so D-series v7 (ADR 0003).
system_vm_size              = "Standard_D4as_v7"
system_min_count            = 1
system_max_count            = 2 # also leaves room for the upgrade surge node
system_only_critical_addons = false

apps_pool_enabled    = false
sandbox_pool_enabled = false
container_insights   = false

# Automatic upgrades use the defaults (patch / NodeImage); max_count leaves room
# for the surge node.

# KEDA add-on (~0.4 CPU) only serves the analysis worker's ScaledObject, and
# analysis is disabled (deploy/helm/bbm values-*.yaml). Set true before
# enabling analysis with analysis.keda.enabled.
keda_enabled = false
