# stacks/compute — prod. Remote state location comes from the environment:
#   TF_VAR_tfstate_account (= TFSTATE_ACCOUNT repo var), optional TF_VAR_tfstate_resource_group.
# Do not set tfstate_* here: -var-file values would override the TF_VAR_* that CI exports.
env           = "prod"
location      = "centralus" # this env's region: infra/up.sh --env-location prod=<region>
location_abbr = "cus"

# Minor version only (patch channel keeps the patch current). Check GA versions
# before the first apply: az aks get-versions -l <location> -o table (infra/up.sh checks it)
kubernetes_version = "1.34"

# Uptime SLA for prod only (ADR 0002); test and staging stay on Free.
aks_sku_tier = "Standard"

# One system pool runs everything (no CriticalAddonsOnly taint). 4 vCPU / 16 GiB:
# the app routing Gateway API's istiod needs 2 x 500m / 2 GiB (ADR 0002 section 8).
# This subscription offers no B-series sizes, so D-series v7 (ADR 0003).
# With more load: system_only_critical_addons = true, apps pool on (min 1, max 3).
system_vm_size              = "Standard_D4as_v7"
system_min_count            = 1
system_max_count            = 3 # also leaves room for the upgrade surge node
system_only_critical_addons = false

apps_pool_enabled = false
apps_vm_size      = "Standard_D2als_v7"
apps_min_count    = 1
apps_max_count    = 3

container_insights = true

# Kata (pod sandboxing) pool for auditor PoCs (ADR 0004). Standard_D2as_v7
# is Gen2 with nested virtualisation, in the Dasv7 family this subscription has
# quota for (+2 vCPUs per env at max scale). Autoscales 0-1: no node, and no
# cost, while no PoC runs; the first PoC after an idle period waits 3-5 min.
sandbox_pool_enabled = true
sandbox_vm_size      = "Standard_D2as_v7"
sandbox_max_count    = 1

# Automatic upgrades use the defaults (patch / NodeImage); max_count leaves room
# for the surge node.

# KEDA add-on (~0.4 CPU) only serves the analysis worker's ScaledObject, and
# analysis is disabled (deploy/helm/bbm values-*.yaml). Set true before
# enabling analysis with analysis.keda.enabled.
keda_enabled = false
