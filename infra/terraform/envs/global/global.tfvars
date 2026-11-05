# stacks/global. The block between the bootstrap-hint markers is replaced by
# infra/up.sh with `./scripts/tf.sh bootstrap global output -raw global_tfvars_hint`
# (or paste that output there by hand). Keep the marker lines.
# >>> bootstrap hint (written by infra/up.sh)
suffix                       = "t9vd"
ephemeral_ci_principal_id    = "ad249478-f491-4046-bb65-5ddf9a3b1c37"
preview_ci_principal_id      = "b240e98b-c064-4c8d-811c-c511b1a44f21"
secret_officer_sp_object_ids = ["025ed226-eac7-4c74-ad13-4a01cf3bc356"]
dns_zone_name                = "bug-bounty.cse416-group.pranavjothivel.com"
# <<< bootstrap hint

location      = "eastus2" # home region: infra/up.sh --location (same as bootstrap.tfvars)
location_abbr = "eus2"

# Env regions (same as bootstrap.tfvars; infra/up.sh copies them from
# envs/<env>/data.tfvars). Used to find the env RGs for their budgets.
env_locations = {
  test    = { location = "eastus2", location_abbr = "eus2" }
  staging = { location = "centralus", location_abbr = "cus" }
  prod    = { location = "centralus", location_abbr = "cus" }
}

alert_emails       = ["alerts@bug-bounty.cse416-group.pranavjothivel.com"]
rg_budget_amount   = 20
budget_start_date  = "2026-11-01T00:00:00Z"
law_daily_quota_gb = 0.25

# Admin users who run `az keyvault secret set`. principal_type User: CI cannot
# grant these, so apply changes to this list locally as a subscription Owner.
secret_officer_user_object_ids = ["3f8bfd5e-e047-4cf0-9783-19f68e694eba"]
acr_push_principal_ids         = [] # build identities (service principals) only
