# OpenRouter integration boundary

## Responsibilities

Future shared provider transport may own connection-level concerns such as request transport, common error translation, and provider configuration. It exposes separate typed chat and decision adapters; shared transport does not collapse distinct capability contracts.

## Boundaries and dependencies

Decision outputs are probability distributions over the offered choices, not independent match or confidence scores. Applications supply decision inputs and own application policy; this library defines transport and typed capability contracts only.

## Scope

This is documentation only: no credentials, client, endpoint, model, provider assumptions, or working integration are included. Verify that the required structured decision capability and model are available through the selected provider path before implementation. Chat and decisions may be composed by the worker without becoming one untyped interface.

## Open questions

Which provider/model combinations support the required typed decision flow? Define adapter contracts, malformed/unusable distribution handling, fallback and calibration, timeout/retry/partial-failure behavior, and diagnostic retention. No provider endpoint or model is selected here.
