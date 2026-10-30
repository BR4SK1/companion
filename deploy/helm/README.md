# Helm documentation

The intended chart area is [`companion`](companion/README.md), with [`environments`](environments/README.md) for non-production and production configuration responsibilities. All future application containers deploy to K3s; PostgreSQL and Keycloak are external existing services and must not be provisioned as part of this application.

**Important:** this is a README-only placeholder, not a usable Helm chart. There is no `Chart.yaml`, values file, template manifest, installable release, controller, or deployment trigger. The `templates` directory documents future boundaries but contains no YAML.
