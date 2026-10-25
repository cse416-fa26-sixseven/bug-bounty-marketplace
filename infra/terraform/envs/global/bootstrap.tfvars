# stacks/bootstrap — applied once by a subscription Owner (who can also create
# Entra app registrations). Example values only; no secrets belong here.
subscription_id = "b31dcf50-ff11-4bcb-905a-eaeeca6c1f1a"
# Home region: tfstate, the shared RG (ACR, shared Log Analytics / Key Vault,
# parent DNS zone). infra/up.sh --location <region> rewrites location /
# location_abbr here, in global.tfvars and in the backend .hcl state RG
# (Azure for Students allows only francecentral, belgiumcentral, denmarkeast,
# northcentralus and canadacentral; up.sh checks the subscription's policy).
location      = "northcentralus"
location_abbr = "ncus" # modules/naming local.location_abbrs

# Region of each env's resource groups (ADR 0002 section 8): one region per
# env, because Azure for Students has 6 vCPUs per region. Copied by infra/up.sh
# from envs/<env>/data.tfvars (the source of truth; --env-location <env>=<region>
# rewrites it) here and into global.tfvars. Keep one line per env.
env_locations = {
  test    = { location = "canadacentral", location_abbr = "cac" }
  staging = { location = "denmarkeast", location_abbr = "dke" }
  prod    = { location = "northcentralus", location_abbr = "ncus" }
}

github_repo = "cse416-fa26-sixseven/bug-bounty-marketplace" # infra/up.sh syncs it with gh repo view
# OIDC subject prefix GitHub sends (immutable subjects use numeric ids); infra/up.sh keeps it current.
github_oidc_subject_prefix = "repo:cse416-fa26-sixseven@343170626/bug-bounty-marketplace@1398822185"

# Object ID of the bbm-admins Entra group (az ad group show -g bbm-admins --query id -o tsv).
admin_object_ids          = ["bf41ada0-7cb4-48ca-9c34-c2616abf5b54"]
power_operator_object_ids = []

alert_emails               = ["alerts@bug-bounty.cse416-group.pranavjothivel.com"]
subscription_budget_amount = 50
budget_start_date          = "2026-10-01T00:00:00Z"

# Numeric GitHub user IDs (gh api users/<login> --jq .id) for required reviewers.
github_reviewer_ids = [321178584]

# Namespaces already registered on the subscription (az provider list
# --query "[?registrationState=='Registered'].namespace" -o tsv); they are
# imported instead of re-registered.
preregistered_resource_providers = ["Microsoft.AlertsManagement", "Microsoft.Compute", "Microsoft.Consumption", "Microsoft.ContainerRegistry", "Microsoft.ContainerService", "Microsoft.CostManagement", "Microsoft.DBforPostgreSQL", "Microsoft.KeyVault", "Microsoft.ManagedIdentity", "Microsoft.Network", "Microsoft.OperationalInsights", "Microsoft.OperationsManagement", "Microsoft.Storage"]

# Parent DNS zone for every env host (ADR 0002), e.g. "bug-bounty.example.com".
# Required: infra/up.sh --zone <zone> (or its prompt) writes it here.
dns_zone_name = "bug-bounty.cse416-group.pranavjothivel.com"

# Mail for the parent zone (alerts@<zone> receives the budget alerts), forwarded
# by ImprovMX. Swap these when changing mail provider; empty lists remove them.
dns_mx_records = [
  { preference = 10, exchange = "mx1.improvmx.com" },
  { preference = 20, exchange = "mx2.improvmx.com" },
]
dns_txt_records = ["v=spf1 include:spf.improvmx.com ~all"]
