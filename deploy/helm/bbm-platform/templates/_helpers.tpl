{{- define "bbm-platform.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "bbm-platform.labels" -}}
helm.sh/chart: {{ include "bbm-platform.chart" . }}
app.kubernetes.io/name: bbm-platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: bbm
{{- end -}}

{{/* Non-empty env zones (fails if there are none). */}}
{{- define "bbm-platform.envZones" -}}
{{- $zones := compact (.Values.dns.envZones | default list) -}}
{{- if not $zones }}{{ fail "dns.envZones is required (values-infra.yaml / terraform helm_values)" }}{{ end -}}
{{- toJson $zones -}}
{{- end -}}

{{- define "bbm-platform.requireInfra" -}}
{{- required (printf "%s is required (values-infra.yaml / terraform helm_values)" .key) .value -}}
{{- end -}}
