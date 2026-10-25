# stacks/data for test — data layer of the test cluster that hosts CI-run and
# PR-preview namespaces (ADR 0002). No PostgreSQL server: each namespace runs
# in-cluster Postgres. dns_zone_name is read from global state.
subscription_id = "b31dcf50-ff11-4bcb-905a-eaeeca6c1f1a"
env             = "test"
location        = "canadacentral" # this env's region: infra/up.sh --env-location test=<region>
location_abbr   = "cac"
suffix          = "xx3m" # bootstrap output: suffix (same as envs/global/global.tfvars)

vnet_cidr = "10.10.0.0/16"
subnet_cidrs = {
  aks  = "10.10.0.0/20"  # AKS nodes
  psql = "10.10.16.0/24" # not delegated (no PG here); Helm networkPolicy.postgresCidr
  pe   = "10.10.17.0/24" # private endpoints (reserved)
}

postgres_enabled = false

law_daily_quota_gb = 0.25
ingress_pip_zones  = ["1", "2", "3"] # set by infra/up.sh from the env region's availability zones

# Key Vault Secrets Officer on the env KV (llm-api-key is set out of band).
# gh-bbm-test already has Secrets Officer on the data RG via bootstrap.
secret_officer_sp_object_ids = [] # extra service principals (CI can apply)
# principal_type User: apply changes to this list locally as a subscription Owner.
secret_officer_user_object_ids = ["bf41ada0-7cb4-48ca-9c34-c2616abf5b54"]
