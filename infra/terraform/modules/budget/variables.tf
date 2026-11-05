variable "name" {
  description = "Budget name."
  type        = string
}

variable "amount" {
  description = "Monthly budget amount in the billing currency (USD)."
  type        = number
  default     = 50
}

variable "subscription_id" {
  description = "Subscription GUID. Used when resource_group_id is null (subscription-scoped budget)."
  type        = string
  default     = null
}

variable "resource_group_id" {
  description = "Resource group ID. When set, an RG-scoped budget is created instead of a subscription budget."
  type        = string
  default     = null
}

variable "filter_resource_group_names" {
  description = "Subscription budget only: count spend in these resource groups only. Empty = the whole subscription."
  type        = list(string)
  default     = []
}

variable "start_date" {
  description = "Budget start (first of a month, RFC3339). Changes are ignored after creation, so a stale value is harmless."
  type        = string
  default     = "2026-10-01T00:00:00Z"

  validation {
    condition     = can(regex("^[0-9]{4}-[0-9]{2}-01T00:00:00Z$", var.start_date))
    error_message = "start_date must be the first of a month, e.g. 2026-10-01T00:00:00Z."
  }
}

variable "alert_emails" {
  description = "Email addresses notified at 50/80/100% actual and 100% forecasted spend."
  type        = list(string)

  validation {
    condition     = length(var.alert_emails) > 0
    error_message = "At least one alert email is required."
  }
}

variable "actual_thresholds" {
  description = "Percentages of actual spend that trigger a notification."
  type        = list(number)
  default     = [50, 80, 100]
}

variable "forecasted_thresholds" {
  description = "Percentages of forecasted spend that trigger a notification."
  type        = list(number)
  default     = [100]
}
