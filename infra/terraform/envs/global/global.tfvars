# stacks/global. The block between the bootstrap-hint markers is replaced by
# infra/up.sh with `./scripts/tf.sh bootstrap global output -raw global_tfvars_hint`
# (or paste that output there by hand). Keep the marker lines.
# >>> bootstrap hint (written by infra/up.sh)
subscription_id              = "b31dcf50-ff11-4bcb-905a-eaeeca6c1f1a"
suffix                       = "xx3m"
ephemeral_ci_principal_id    = "3deb6616-bf5d-403c-a401-f28957c251e3"
preview_ci_principal_id      = "eb6cf570-6af3-401e-9a0b-f904b7f0f3b7"
secret_officer_sp_object_ids = ["bfeebc0c-850f-4e18-910d-e3ece29814a3"]
dns_zone_name                = "bug-bounty.cse416-group.pranavjothivel.com"
# <<< bootstrap hint

location      = "northcentralus" # home region: infra/up.sh --location (same as bootstrap.tfvars)
location_abbr = "ncus"

# Env regions (same as bootstrap.tfvars; infra/up.sh copies them from
# envs/<env>/data.tfvars). Used to find the env RGs for their budgets.
env_locations = {
  test    = { location = "northcentralus", location_abbr = "ncus" }
  staging = { location = "francecentral", location_abbr = "frc" }
  prod    = { location = "canadacentral", location_abbr = "cac" }
}

alert_emails       = ["alerts@bug-bounty.cse416-group.pranavjothivel.com"]
rg_budget_amount   = 20
budget_start_date  = "2026-10-01T00:00:00Z"
law_daily_quota_gb = 0.25

# Admin users who run `az keyvault secret set`. principal_type User: CI cannot
# grant these, so apply changes to this list locally as a subscription Owner.
secret_officer_user_object_ids = ["bf41ada0-7cb4-48ca-9c34-c2616abf5b54"]
acr_push_principal_ids         = [] # build identities (service principals) only
