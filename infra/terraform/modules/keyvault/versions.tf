terraform {
  required_version = ">= 1.9, < 2.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.12"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }
}
