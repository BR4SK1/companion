{{/* Chart-level helpers. Resource names derive from the Helm release name,
so one release per environment yields one coherent set of resources in that
release's namespace. */}}

{{- define "companion.labels" -}}
app.kubernetes.io/part-of: companion
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "companion.webName" -}}
{{ printf "%s-web" .Release.Name }}
{{- end -}}

{{- define "companion.workerName" -}}
{{ printf "%s-worker" .Release.Name }}
{{- end -}}
