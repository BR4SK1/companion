# Application deployables

This area contains the application containers. All application containers run on K3s. PostgreSQL and Keycloak remain external services and are not application deployables.

The [web/BFF](web/README.md) owns browser sessions, owner authorization and the live conversation. The [worker](worker/README.md) serves the private API and owns durable conversation work, memory, relationship learning, engagement, articles, routines and prompt modules. The [configuration manager](config-manager/README.md) runs locally as an operator tool bound to one environment.
