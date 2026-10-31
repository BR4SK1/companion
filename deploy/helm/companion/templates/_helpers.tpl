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

{{- define "companion.validateDeployment" -}}
{{- /* Deployment-purpose attestation, fail closed: every release must
declare exactly what it is and where it runs. The purpose gates
deployment-specific capabilities (the non-production-only test-entry gate
renders only for "non-production" and the application refuses to open it
elsewhere), and the declared namespace must equal the release namespace so
a values file cannot silently land in another namespace. Unknown or missing
values never render. */}}
{{- $purpose := required "deployment.purpose is required (exactly \"non-production\" or \"production\")" .Values.deployment.purpose -}}
{{- if and (ne $purpose "non-production") (ne $purpose "production") -}}
{{- fail (printf "deployment.purpose must be exactly \"non-production\" or \"production\", got %s" $purpose) -}}
{{- end -}}
{{- $declaredNamespace := required "deployment.namespace is required (the exact namespace this release is installed into)" .Values.deployment.namespace -}}
{{- if ne $declaredNamespace .Release.Namespace -}}
{{- fail (printf "deployment.namespace (%s) must equal the release namespace (%s)" $declaredNamespace .Release.Namespace) -}}
{{- end -}}
{{- end -}}
