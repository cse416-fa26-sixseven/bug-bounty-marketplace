# stacks/data for staging — persistent data layer (VNet, PG, KV, storage, UAMIs, PIP, LAW).
subscription_id = "b31dcf50-ff11-4bcb-905a-eaeeca6c1f1a"
env             = "staging"
location        = "denmarkeast" # this env's region: infra/up.sh --env-location staging=<region>
location_abbr   = "dke"
suffix          = "xx3m" # bootstrap output: suffix (same as envs/global/global.tfvars)

vnet_cidr = "10.20.0.0/16"
subnet_cidrs = {
  aks  = "10.20.0.0/20"  # AKS nodes
  psql = "10.20.16.0/24" # delegated to PostgreSQL Flexible Server (Helm networkPolicy.postgresCidr)
  pe   = "10.20.17.0/24" # private endpoints (reserved)
}

postgres_sku_name              = "B_Standard_B1ms"
postgres_storage_mb            = 32768
postgres_backup_retention_days = 7

law_daily_quota_gb = 0.5
ingress_pip_zones  = ["1", "2", "3"] # set by infra/up.sh from the env region's availability zones

# Key Vault Secrets Officer on the env KV (mirrors envs/global/global.tfvars).
# gh-bbm-staging already has Secrets Officer on the data RG via bootstrap.
secret_officer_sp_object_ids = [] # extra service principals (CI can apply)
# Users who apply locally or set llm-api-key out of band
# (az keyvault secret set --vault-name <kv> --name llm-api-key --value ...).
# principal_type User: CI cannot grant these, so apply changes to this list
# locally as a subscription Owner first; CI then sees no diff.
secret_officer_user_object_ids = ["bf41ada0-7cb4-48ca-9c34-c2616abf5b54"]
