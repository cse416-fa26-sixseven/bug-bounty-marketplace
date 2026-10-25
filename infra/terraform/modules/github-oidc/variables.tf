variable "repo" {
  description = "GitHub repository in owner/name form; federated subjects are built as repo:<repo>:<subject>."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repo))
    error_message = "repo must look like owner/name."
  }
}

variable "identities" {
  description = <<-EOT
    Map of app registration display name => identity config:
      environments     - GitHub Environments trusted (subject repo:<repo>:environment:<env>)
      extra_subjects   - other subject suffixes after "repo:<repo>:", e.g. "pull_request", "ref:refs/heads/main"
      role_assignments - Azure RBAC grants for the service principal. Give each a stable `key`
                         (used in resource addresses; falls back to the list index).
                         Set exactly one of role_definition_name / role_definition_id.
                         `condition` + `condition_version` support ABAC-constrained delegation.
  EOT
  type = map(object({
    environments   = optional(list(string), [])
    extra_subjects = optional(list(string), [])
    role_assignments = optional(list(object({
      key                  = optional(string)
      scope                = string
      role_definition_name = optional(string)
      role_definition_id   = optional(string)
      condition            = optional(string)
      condition_version    = optional(string)
    })), [])
  }))

  validation {
    condition = alltrue(flatten([
      for _, id in var.identities : [
        for ra in id.role_assignments :
        (ra.role_definition_name == null) != (ra.role_definition_id == null)
      ]
    ]))
    error_message = "Each role assignment must set exactly one of role_definition_name or role_definition_id."
  }

  validation {
    condition     = alltrue([for _, id in var.identities : length(id.environments) + length(id.extra_subjects) > 0])
    error_message = "Each identity needs at least one environment or extra subject."
  }
}

variable "owner_object_ids" {
  description = "Extra Entra object IDs to own the app registrations/service principals (the caller is always an owner)."
  type        = list(string)
  default     = []
}

variable "subject_prefix" {
  description = "OIDC subject prefix GitHub sends for this repo, e.g. repo:owner@123/name@456 when the repo uses immutable subjects (gh api repos/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix). Empty = repo:<repo>."
  type        = string
  default     = ""

  validation {
    condition     = var.subject_prefix == "" || can(regex("^repo:[A-Za-z0-9_.-]+(@[0-9]+)?/[A-Za-z0-9_.-]+(@[0-9]+)?$", var.subject_prefix))
    error_message = "subject_prefix must look like repo:owner/name or repo:owner@<id>/name@<id>."
  }
}
