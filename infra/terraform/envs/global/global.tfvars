# stacks/global. The block between the bootstrap-hint markers is replaced by
# infra/up.sh with `./scripts/tf.sh bootstrap global output -raw global_tfvars_hint`
# (or paste that output there by hand). Keep the marker lines.
# >>> bootstrap hint (written by infra/up.sh)
subscription_id              = "00000000-0000-0000-0000-000000000000"
suffix                       = "0000"
ephemeral_ci_principal_id    = null # gh-bbm-ephemeral SP object ID
preview_ci_principal_id      = null # gh-bbm-preview SP object ID
secret_officer_sp_object_ids = []   # gh-bbm-global SP (CI can apply)
dns_zone_name                = ""   # parent zone, e.g. bug-bounty.example.com
# <<< bootstrap hint

location      = "northcentralus" # infra/up.sh --location (same in every tfvars)
location_abbr = "ncus"

alert_emails       = ["bbm-admins@example.com"]
rg_budget_amount   = 20
budget_start_date  = "2026-10-01T00:00:00Z"
law_daily_quota_gb = 0.25

# Admin users who run `az keyvault secret set`. principal_type User: CI cannot
# grant these, so apply changes to this list locally as a subscription Owner.
secret_officer_user_object_ids = []
acr_push_principal_ids         = [] # build identities (service principals) only
