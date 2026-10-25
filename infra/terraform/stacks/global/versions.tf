terraform {
  required_version = ">= 1.9, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.81, < 5.0" # 4.81: azurerm_container_registry.role_assignment_mode
    }
  }

  # Partial config: envs/global/backend.hcl + key=global.tfstate (scripts/tf.sh).
  backend "azurerm" {}
}
