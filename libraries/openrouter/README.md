# OpenRouter integration boundary

## Responsibilities

This library area is the home for OpenRouter integration code. Shared provider transport — connection-level concerns such as request transport, common error translation, and provider configuration — is kept separate from the typed capability adapters; shared transport does not collapse distinct capability contracts.

### Shared transport (`src/transport.ts`)

`postJson` performs one JSON POST with optional bearer authentication and a timeout, and translates failures into typed `OpenRouterTransportError` errors (`network`, `timeout`, `http_status`, `invalid_json`). It knows nothing about capability contracts: payloads stay opaque, response validation belongs to the capability modules or the composing application. No retries, backoff, fallback routing, model/provider selection, or credential storage are included; the caller injects credentials and (for tests) the fetch implementation.

### Chat contract (`src/chat.ts`)

The typed Chat Completions contract (`POST /api/v1/chat/completions`, non-streaming, OpenAI-compatible) validates requests and responses without transport or policy:

- Requests require `model` and at least one message with role `system`, `user`, or `assistant` and string content; multimodal content-part arrays are outside this contract's text-only scope and are rejected explicitly rather than silently dropped. Optional `temperature` (finite number) and `max_tokens` (integer ≥ 1) stay optional and are never invented or defaulted.
- Responses require `model` and at least one choice whose message role is `assistant` with string content; `id`, `finish_reason`, and `usage` are optional and are read through presence checks, never fabricated. Unknown extra properties are accepted but not surfaced.
- Tool calls, streaming deltas, logprobs, and image inputs are outside the approved contract scope and are rejected as invalid rather than approximated. No normalization is applied: content and counts are preserved as returned.

### Decisions contract (`src/decisions.ts`)

The Decisions contract is implemented in [`src/decisions.ts`](src/decisions.ts): the typed request and answer variants of OpenRouter's Decisions API (`POST /api/alpha/decisions`, same body as `/api/v1/systemone`), validated against the published schema without defaults or coercion.

- Distinct `choice`, `noul`, and `score` question variants with distinct matching answer variants, preserving native results.
- `choice` answers carry the selected option and optional `probabilities` and `confidence`. `score` answers carry the probability-weighted position on an ordered scale (criteria are ordered lowest level first), the optional level `legend`, and optional level `probabilities` and `confidence`.
- A `noul` answer's probability stays a number. It is never coerced to a Boolean; a near-0.5 value means yes and no are similarly likely, not a medium amount of anything.
- Optional fields (`probabilities`, `confidence`, `legend`, `noul.criteria`, `id`, `provider`, `usage.cost`, and the optional request fields `provider`, `session_id`, `user`, `trace`) stay optional: they are read through presence checks and never fabricated.
- Published schema constraints are enforced where they exist: `score` criteria require at least one level (`minItems: 1`), and `session_id`/`user` honor `maxLength: 256`. The request `provider` field follows the published `ProviderPreferences` schema (`object | null`): an explicit `null` is valid and preserved. The top-level `assets` image-reference map is in the published schema but outside this contract's approved scope (text-only decisions); requests containing it are rejected explicitly rather than accepted with the field silently dropped, since dropping it would change the meaning of asset references inside `state`, `instructions`, or `criteria`.
- Map-shaped values (questions, answers, criteria, probabilities, legend, and the `provider`/`trace` pass-through copies) preserve every own enumerable string key, including keys named `__proto__`, `constructor`, or `toString`: entries are defined with `Object.defineProperty` rather than `[[Set]]` assignment, iteration is own-key-only, and membership checks use `Object.hasOwn`, so inherited prototype names are never mistaken for entries.
- Validation rejects what the published schema rejects — missing required fields, unknown or unexpected `type` discriminants, wrong field types, and non-finite numbers — and deliberately does not enforce semantic quality rules: probability ranges or sums, correspondence between criteria keys and probability keys, whether a `choice` value names an offered option, thresholds, calibration, top-choice or top-N selection, or fallback. Those belong to application policy above this contract, which must not silently normalize or coerce numbers.
- `parseDecisionsExchange` additionally checks that answers correspond one-to-one to the asked question IDs with matching answer types; a missing answer, an extra answer, or a mismatched type is an error rather than a default, per the official Decisions guidance.

The `box` primitive (image questions, Jev 1.14) is outside the approved contract scope and is rejected as an unexpected question or answer type, as is the top-level `assets` image-reference map.

## Boundaries and dependencies

Applications supply decision inputs and own application policy; this library defines transport and typed capability contracts only. No credentials, client construction, endpoint defaults-as-policy, model IDs, provider selection, capability probing, retries, or fallback are included. The contract tests are deterministic and run against inline fake payloads with no network; transport tests inject `fetch` and make no network calls.

## Verification

- `pnpm test:unit` runs the contract tests ([`tests/unit/openrouter-decisions.test.mjs`](../../tests/unit/openrouter-decisions.test.mjs), [`tests/unit/openrouter-chat.test.mjs`](../../tests/unit/openrouter-chat.test.mjs)) and the transport tests ([`tests/unit/openrouter-transport.test.mjs`](../../tests/unit/openrouter-transport.test.mjs)) on Node's built-in test runner; they import the TypeScript source directly through Node's built-in type stripping, so no build step is needed for tests.
- `pnpm typecheck` type-checks the contract and transport sources with `tsc` (`libraries/openrouter/tsconfig.json`, strict, `--noEmit`).

## Open questions

Which provider/model combinations support the required typed decision flow remains unverified — live-provider capability checks are separate from these contracts, and schema-constrained chat output is not automatically equivalent to native decision probabilities. Whether the `box` primitive or later schema additions should join the contracts is open. Whether parsed values should retain unknown extra response fields (currently accepted but not surfaced) is open. Application policy for unusable answers, fallback and calibration, timeout/retry/partial-failure behavior, and diagnostic retention are also unresolved. Streaming and multimodal chat content remain outside the chat contract's scope; extending it is a separate decision.
