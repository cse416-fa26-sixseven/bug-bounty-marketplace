# Partial azurerm backend config for stacks/data (test).
# scripts/tf.sh adds key=test/data.tfstate, and overrides resource_group_name /
# storage_account_name from $TFSTATE_RG / $TFSTATE_ACCOUNT when set (CI repo vars).
resource_group_name  = "rg-bbm-tfstate-ncus"
storage_account_name = "stbbmtfstate0000" # replace with bootstrap output tfstate_storage_account
container_name       = "tfstate"
use_oidc             = true # CI: GitHub OIDC; locally falls through to `az login`
use_azuread_auth     = true # the account has shared keys disabled
