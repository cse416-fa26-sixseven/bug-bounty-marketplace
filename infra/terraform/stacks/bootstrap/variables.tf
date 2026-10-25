variable "subscription_id" {
  description = "Target Azure subscription GUID."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", var.subscription_id))
    error_message = "subscription_id must be a lowercase GUID."
  }
}

variable "location" {
  description = "Azure region (full name), e.g. northcentralus. infra/up.sh --location writes it into every tfvars."
  type        = string
  default     = "northcentralus"
}

variable "location_abbr" {
  description = "Short region code used in names (e.g. ncus). Null derives it from location (modules/naming local.location_abbrs)."
  type        = string
  default     = null
}

variable "github_repo" {
  description = "GitHub repository (owner/name) trusted by the OIDC identities."
  type        = string
  default     = "cse416-fa26-sixseven/bug-bounty-marketplace"

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must be owner/name (infra/up.sh writes it from gh repo view)."
  }
}

variable "admin_object_ids" {
  description = "Entra object IDs (e.g. the bbm-admins group) granted AKS RBAC Cluster Admin on the compute RGs and state access."
  type        = list(string)
  default     = []
}

variable "power_operator_object_ids" {
  description = "Entra object IDs granted the custom 'BBM Power Operator' role on the test/staging/prod RGs (pause/resume without Contributor)."
  type        = list(string)
  default     = []
}

variable "alert_emails" {
  description = "Emails that receive subscription budget alerts."
  type        = list(string)
}

variable "subscription_budget_amount" {
  description = "Monthly subscription budget in USD."
  type        = number
  default     = 50
}

variable "budget_start_date" {
  description = "Budget start (first of the month, RFC3339). Ignored after creation."
  type        = string
  default     = "2026-10-01T00:00:00Z"
}

variable "github_reviewer_ids" {
  description = "GitHub user IDs (numeric) added as required reviewers on infra-global, prod and contracts-sepolia in gh_setup_commands. Empty = add reviewers manually."
  type        = list(number)
  default     = []
}

variable "dns_zone_name" {
  description = "Parent DNS zone for every env host, e.g. bug-bounty.example.com (ADR 0002). Bootstrap creates it plus the prod/staging/test/preview child zones."
  type        = string

  validation {
    condition     = var.dns_zone_name != ""
    error_message = "dns_zone_name is empty: set it in envs/global/bootstrap.tfvars (e.g. dns_zone_name = \"bug-bounty.example.com\") or run infra/up.sh --zone <zone>."
  }

  validation {
    condition     = var.dns_zone_name == "" || (can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$", var.dns_zone_name)) && length(var.dns_zone_name) <= 200)
    error_message = "dns_zone_name must be a lowercase DNS name with at least two labels and no trailing dot, e.g. bug-bounty.example.com."
  }
}

variable "preregistered_resource_providers" {
  description = "Resource provider namespaces that are ALREADY registered on the subscription; they are imported instead of created (avoids 'already registered' errors)."
  type        = list(string)
  default     = []
}
