variable "project" {
  description = "Short project code used as the name prefix."
  type        = string
  default     = "bbm"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,5}$", var.project))
    error_message = "project must be 2-6 lowercase alphanumeric characters starting with a letter."
  }
}

variable "env" {
  description = "Environment the names/tags are for: global, test, staging or prod."
  type        = string
  default     = "global"

  validation {
    condition     = contains(["global", "test", "staging", "prod"], var.env)
    error_message = "env must be one of global, test, staging, prod."
  }
}

variable "location" {
  description = "Azure region (full name), e.g. northcentralus."
  type        = string
  default     = "northcentralus"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]+$", var.location))
    error_message = "location must be an Azure region name like northcentralus (lowercase, no spaces)."
  }
}

variable "location_abbr" {
  description = "Short region code used in names, e.g. ncus. Null derives it from the built-in map in main.tf (local.location_abbrs); required for regions not in that map, and must match the map for regions in it."
  type        = string
  default     = null

  validation {
    condition     = var.location_abbr == null || can(regex("^[a-z][a-z0-9]{1,5}$", var.location_abbr))
    error_message = "location_abbr must be 2-6 lowercase alphanumeric characters starting with a letter."
  }

  validation {
    condition     = var.location_abbr != null || contains(keys(local.location_abbrs), var.location)
    error_message = "location has no built-in abbreviation (modules/naming local.location_abbrs): set location_abbr explicitly, or add the region to the map."
  }

  validation {
    condition     = var.location_abbr == null || lookup(local.location_abbrs, var.location, var.location_abbr) == var.location_abbr
    error_message = "location_abbr does not match the built-in abbreviation for location (modules/naming local.location_abbrs); a mismatch would name resources after another region."
  }
}

variable "suffix" {
  description = "4-char lowercase alphanumeric suffix (bootstrap random_string) for globally unique names."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]{4}$", var.suffix))
    error_message = "suffix must be exactly 4 lowercase alphanumeric characters."
  }
}

variable "layer" {
  description = "Layer tag for the `tags` output: global, data or compute."
  type        = string
  default     = "global"

  validation {
    condition     = contains(["global", "data", "compute"], var.layer)
    error_message = "layer must be one of global, data, compute."
  }
}

variable "dns_zone_name" {
  description = "Parent DNS zone (e.g. bug-bounty.example.com) for the `dns` output. Null leaves the DNS names empty."
  type        = string
  default     = null
}

variable "repo" {
  description = "GitHub repository (owner/name) recorded in the repo tag."
  type        = string
  default     = "cse416-fa26-sixseven/bug-bounty-marketplace"
}

variable "extra_tags" {
  description = "Additional tags merged over the standard set."
  type        = map(string)
  default     = {}
}
