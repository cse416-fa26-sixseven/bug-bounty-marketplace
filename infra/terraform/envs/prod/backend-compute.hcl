# Partial azurerm backend config for stacks/compute (prod). scripts/tf.sh adds
# key=prod/compute.tfstate and overrides resource_group_name /
# storage_account_name from $TFSTATE_RG / $TFSTATE_ACCOUNT when set (CI repo vars).
resource_group_name  = "rg-bbm-tfstate-eus2"
storage_account_name = "stbbmtfstatet9vd" # replace with bootstrap output tfstate_storage_account
container_name       = "tfstate"
key                  = "prod/compute.tfstate"
use_oidc             = true # CI: GitHub OIDC; locally falls through to `az login`
use_azuread_auth     = true # the account has shared keys disabled
