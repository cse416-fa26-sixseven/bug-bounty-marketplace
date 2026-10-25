# stacks/bootstrap — applied once by a subscription Owner (who can also create
# Entra app registrations). Example values only; no secrets belong here.
subscription_id = "00000000-0000-0000-0000-000000000000"
location        = "eastus2"
location_abbr   = "eus2"
github_repo     = "LoistCloist/bug-bounty-marketplace"

# Object ID of the bbm-admins Entra group (az ad group show -g bbm-admins --query id -o tsv).
admin_object_ids          = []
power_operator_object_ids = []

alert_emails               = ["bbm-admins@example.com"]
subscription_budget_amount = 50
budget_start_date          = "2026-10-01T00:00:00Z"

# Numeric GitHub user IDs (gh api users/<login> --jq .id) for required reviewers.
github_reviewer_ids = []

# Namespaces already registered on the subscription (az provider list
# --query "[?registrationState=='Registered'].namespace" -o tsv); they are
# imported instead of re-registered.
preregistered_resource_providers = []

# Parent DNS zone for every env host (ADR 0002), e.g. "bug-bounty.example.com".
# Required: infra/up.sh --zone <zone> (or its prompt) writes it here.
dns_zone_name = ""
