# Monthly cost budget with email alerts. Scope is the subscription unless
# resource_group_id is set. Azure allows at most 5 notifications per budget.
# A subscription budget can be limited to some RGs with
# filter_resource_group_names (counts only their spend; ADR 0003).

locals {
  rg_scoped = var.resource_group_id != null

  notifications = concat(
    [for t in var.actual_thresholds : { threshold = t, threshold_type = "Actual" }],
    [for t in var.forecasted_thresholds : { threshold = t, threshold_type = "Forecasted" }],
  )
}

resource "azurerm_consumption_budget_subscription" "this" {
  count = local.rg_scoped ? 0 : 1

  name            = var.name
  subscription_id = "/subscriptions/${var.subscription_id}"
  amount          = var.amount
  time_grain      = "Monthly"

  time_period {
    start_date = var.start_date
  }

  dynamic "filter" {
    for_each = length(var.filter_resource_group_names) > 0 ? [1] : []
    content {
      dimension {
        name     = "ResourceGroupName"
        operator = "In"
        values   = var.filter_resource_group_names
      }
    }
  }

  dynamic "notification" {
    for_each = local.notifications
    content {
      enabled        = true
      threshold      = notification.value.threshold
      threshold_type = notification.value.threshold_type
      operator       = "GreaterThanOrEqualTo"
      contact_emails = var.alert_emails
    }
  }

  lifecycle {
    # start_date forces replacement and Azure rejects past start dates outside
    # the current grain, so never touch it after creation.
    ignore_changes = [time_period[0].start_date]

    precondition {
      condition     = length(var.filter_resource_group_names) == 0 || !local.rg_scoped
      error_message = "filter_resource_group_names only applies to subscription-scoped budgets."
    }

    precondition {
      condition     = var.subscription_id != null
      error_message = "subscription_id is required for a subscription-scoped budget."
    }

    precondition {
      condition     = length(local.notifications) <= 5
      error_message = "Azure budgets support at most 5 notifications."
    }
  }
}

resource "azurerm_consumption_budget_resource_group" "this" {
  count = local.rg_scoped ? 1 : 0

  name              = var.name
  resource_group_id = var.resource_group_id
  amount            = var.amount
  time_grain        = "Monthly"

  time_period {
    start_date = var.start_date
  }

  dynamic "notification" {
    for_each = local.notifications
    content {
      enabled        = true
      threshold      = notification.value.threshold
      threshold_type = notification.value.threshold_type
      operator       = "GreaterThanOrEqualTo"
      contact_emails = var.alert_emails
    }
  }

  lifecycle {
    ignore_changes = [time_period[0].start_date]

    precondition {
      condition     = length(local.notifications) <= 5
      error_message = "Azure budgets support at most 5 notifications."
    }
  }
}
