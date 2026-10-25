# Partial azurerm backend config for stacks/compute (staging). scripts/tf.sh adds
# key=staging/compute.tfstate and overrides resource_group_name /
# storage_account_name from $TFSTATE_RG / $TFSTATE_ACCOUNT when set (CI repo vars).
resource_group_name  = "rg-bbm-tfstate-ncus"
storage_account_name = "stbbmtfstatexx3m" # replace with bootstrap output tfstate_storage_account
container_name       = "tfstate"
key                  = "staging/compute.tfstate"
use_oidc             = true # CI: GitHub OIDC; locally falls through to `az login`
use_azuread_auth     = true # the account has shared keys disabled
