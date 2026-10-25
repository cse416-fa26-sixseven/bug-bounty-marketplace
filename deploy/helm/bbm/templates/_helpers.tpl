{{/*
Resource name prefix. Fixed to "bbm" (not the release name) because workload
identity federated credentials reference fixed ServiceAccount names.
*/}}
{{- define "bbm.fullname" -}}
{{- default "bbm" .Values.fullnameOverride | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{/* Component resource name: bbm.componentName (dict "root" $ "component" "api") */}}
{{- define "bbm.componentName" -}}
{{- printf "%s-%s" (include "bbm.fullname" .root) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bbm.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Common labels: bbm.labels (dict "root" $ "component" "api") ; component optional */}}
{{- define "bbm.labels" -}}
helm.sh/chart: {{ include "bbm.chart" .root }}
app.kubernetes.io/name: {{ include "bbm.fullname" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
app.kubernetes.io/part-of: bbm
{{- with .component }}
app.kubernetes.io/component: {{ . }}
{{- end }}
{{- end -}}

{{/* Selector labels: bbm.selectorLabels (dict "root" $ "component" "api") */}}
{{- define "bbm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bbm.fullname" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/*
Image reference: bbm.image (dict "root" $ "image" .Values.api.image)
Renders [registry/]repository:tag. The tag falls back to global.image.tag,
which is required.
*/}}
{{- define "bbm.image" -}}
{{- $g := .root.Values.global.image -}}
{{- $tag := .image.tag | default $g.tag | required "global.image.tag is required (e.g. --set global.image.tag=sha-abc1234)" -}}
{{- $repo := .image.repository -}}
{{- if $g.registry -}}
{{- printf "%s/%s:%s" (trimSuffix "/" $g.registry) $repo (toString $tag) -}}
{{- else -}}
{{- printf "%s:%s" $repo (toString $tag) -}}
{{- end -}}
{{- end -}}

{{/* Pull policy: bbm.imagePullPolicy (dict "root" $ "image" .Values.api.image) */}}
{{- define "bbm.imagePullPolicy" -}}
{{- .image.pullPolicy | default .root.Values.global.image.pullPolicy -}}
{{- end -}}

{{/*
Workload identity pod label (azure.workload.identity/use: "true"). Returns
"true" only when workload identity is enabled AND the pod's ServiceAccount has
a client ID to federate with (web has none, so it is never labelled).
Usage:
  {{- if include "bbm.useWorkloadIdentity" (dict "root" $ "clientId" .Values.azure.apiClientId) }}
  azure.workload.identity/use: "true"
  {{- end }}
*/}}
{{- define "bbm.useWorkloadIdentity" -}}
{{- if and .root.Values.azure.workloadIdentity.enabled .clientId }}true{{ end -}}
{{- end -}}

{{/* Fail fast on missing terraform-provided values when global.requireInfraValues. */}}
{{- define "bbm.requireInfra" -}}
{{- if .root.Values.global.requireInfraValues -}}
{{- required (printf "%s is required (normally from values-infra.yaml / terraform helm_values)" .key) .value -}}
{{- end -}}
{{- end -}}

{{/* Is the CSI secret provider in use? */}}
{{- define "bbm.csi" -}}
{{- if eq .Values.secrets.provider "csi" }}true{{ end -}}
{{- end -}}

{{/*
Secret that the migrations Job reads DATABASE_URL from. Hook resources run
before regular release resources exist, so plain/csi use a dedicated
hook-managed copy; "existing" is pre-created and used directly.
*/}}
{{- define "bbm.migrationsSecretName" -}}
{{- if eq .Values.secrets.provider "existing" -}}
{{- .Values.secrets.name -}}
{{- else -}}
{{- printf "%s-migrations" .Values.secrets.name -}}
{{- end -}}
{{- end -}}

{{/* Secret that the analysis worker reads LLM_API_KEY from. */}}
{{- define "bbm.analysisSecretName" -}}
{{- if eq .Values.secrets.provider "csi" -}}
{{- printf "%s-analysis" .Values.secrets.name -}}
{{- else -}}
{{- .Values.secrets.name -}}
{{- end -}}
{{- end -}}

{{/* nodeSelector: global merged with component (component wins). */}}
{{- define "bbm.nodeSelector" -}}
{{- $ns := merge (deepCopy (.values.nodeSelector | default dict)) (deepCopy (.root.Values.global.nodeSelector | default dict)) -}}
{{- with $ns }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* tolerations: global + component */}}
{{- define "bbm.tolerations" -}}
{{- $t := concat (.root.Values.global.tolerations | default list) (.values.tolerations | default list) -}}
{{- with $t }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Shared pod scheduling block (nodeSelector, tolerations, affinity, topology
spread): bbm.scheduling (dict "root" $ "values" .Values.api "component" "api")
*/}}
{{- define "bbm.scheduling" -}}
{{- include "bbm.nodeSelector" . }}
{{- include "bbm.tolerations" . }}
{{- with .values.affinity }}
affinity:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- if .values.topologySpread }}
topologySpreadConstraints:
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "bbm.selectorLabels" (dict "root" .root "component" .component) | nindent 8 }}
    matchLabelKeys:
      - pod-template-hash
{{- end }}
{{- end -}}

{{/* Pod-level securityContext: bbm.podSecurityContext (dict "uid" 1000 "gid" 1000) */}}
{{- define "bbm.podSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: {{ .uid }}
  runAsGroup: {{ .gid }}
  fsGroup: {{ .gid }}
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{/* Container-level securityContext */}}
{{- define "bbm.containerSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
  seccompProfile:
    type: RuntimeDefault
{{- end -}}

{{/* imagePullSecrets */}}
{{- define "bbm.imagePullSecrets" -}}
{{- with .Values.global.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* CSI volume: bbm.csiVolume (dict "name" "secrets-store" "spc" "bbm-kv") */}}
{{- define "bbm.csiVolume" -}}
- name: secrets-store
  csi:
    driver: secrets-store.csi.k8s.io
    readOnly: true
    volumeAttributes:
      secretProviderClass: {{ .spc }}
{{- end -}}

{{/* Effective minimum replicas for a component (used for PDB gating). */}}
{{- define "bbm.minReplicas" -}}
{{- if .hpa.enabled -}}{{ .hpa.minReplicas }}{{- else -}}{{ .replicaCount }}{{- end -}}
{{- end -}}

{{/* Checksum annotations so pods roll when config/plain secrets change. */}}
{{- define "bbm.checksums" -}}
checksum/config: {{ include (print .Template.BasePath "/configmap.yaml") . | sha256sum }}
{{- if eq .Values.secrets.provider "plain" }}
checksum/secret: {{ include (print .Template.BasePath "/secret.yaml") . | sha256sum }}
{{- end }}
{{- end -}}

{{/*
DATABASE_URL for secrets.provider=plain: secrets.plain.databaseUrl when set,
else the in-cluster Postgres Service when postgres.inCluster.enabled, else
the kind/CI dummy.
*/}}
{{- define "bbm.databaseUrl" -}}
{{- $pg := .Values.postgres.inCluster -}}
{{- if .Values.secrets.plain.databaseUrl -}}
{{- .Values.secrets.plain.databaseUrl -}}
{{- else if $pg.enabled -}}
{{- printf "postgres://%s:%s@%s:5432/%s" $pg.user (include "bbm.postgresPassword" .) (include "bbm.componentName" (dict "root" . "component" "postgres")) $pg.database -}}
{{- else -}}
postgres://bbm:bbm@postgres:5432/bbm
{{- end -}}
{{- end -}}

{{/* In-cluster Postgres password (required when postgres.inCluster.enabled). */}}
{{- define "bbm.postgresPassword" -}}
{{- required "postgres.inCluster.password is required when postgres.inCluster.enabled=true" .Values.postgres.inCluster.password -}}
{{- end -}}

{{/* Egress rules to Postgres: the PG subnet CIDR and/or the in-cluster pods. */}}
{{- define "bbm.postgresEgressRules" -}}
{{- with .Values.networkPolicy.postgresCidr }}
- to:
    - ipBlock:
        cidr: {{ . }}
  ports:
    - port: 5432
      protocol: TCP
{{- end }}
{{- if .Values.postgres.inCluster.enabled }}
- to:
    - podSelector:
        matchLabels:
          {{- include "bbm.selectorLabels" (dict "root" . "component" "postgres") | nindent 10 }}
  ports:
    - port: 5432
      protocol: TCP
{{- end }}
{{- end -}}

{{/*
NetworkPolicy peer for the Gateway data plane: the Envoy pods the app routing
Gateway API implementation (approuting-istio) provisions for Gateway
<ingress.gateway.name> in its namespace. Istio labels them
gateway.networking.k8s.io/gateway-name=<gateway name>.
*/}}
{{- define "bbm.gatewayPeer" -}}
namespaceSelector:
  matchLabels:
    kubernetes.io/metadata.name: {{ .Values.ingress.gateway.namespace }}
podSelector:
  matchLabels:
    gateway.networking.k8s.io/gateway-name: {{ .Values.ingress.gateway.name }}
{{- end -}}
