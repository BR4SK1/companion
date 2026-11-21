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

{{- define "companion.webLbName" -}}
{{ printf "%s-web-lb" .Release.Name }}
{{- end -}}

{{- define "companion.workerName" -}}
{{ printf "%s-worker" .Release.Name }}
{{- end -}}

{{- define "companion.imageRef" -}}
{{- /* Image reference for one deployable: repository@digest when a digest
pin is set (verified content), otherwise repository:tag. The digest, when
present, must be exactly sha256:<64 lowercase hex>; anything else fails
rendering rather than producing an ambiguous reference. */}}
{{- $repository := .repository -}}
{{- $tag := .tag -}}
{{- $digest := .digest | default "" -}}
{{- if $digest -}}
{{- if not (regexMatch "^sha256:[0-9a-f]{64}$" $digest) -}}
{{- fail (printf "image digest must be sha256:<64 hex>, got %s" $digest) -}}
{{- end -}}
{{- printf "%s@%s" $repository $digest -}}
{{- else -}}
{{- printf "%s:%s" $repository $tag -}}
{{- end -}}
{{- end -}}
