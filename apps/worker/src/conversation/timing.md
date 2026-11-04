# Conversation timing

Client-reported send times for user messages: classification, provenance, and
the persisted effective message time.

## Contract

- Both clocks are preserved: the raw client-reported send time (as received on
  the wire) and the server receive time are always recorded on the message.
- The **effective message time** drives engagement bands and ordering.
  - `client` source: the client send time is used as the effective time when
    it is present, parses to a finite instant, is not further ahead of the
    server receive time than the configured ahead-tolerance, and is not
    below the acceptance/order bound.
  - `server` source: for every other status the effective time is the
    actual recorded server receive time — identical to
    `server_received_at`, never clamped or otherwise modified. No synthetic
    effective timestamp is ever produced.
- **Acceptance/order bound.** A separate, monotonically tracked bound — the
  maximum effective time recorded so far on user messages (fallbacks
  included), read inside the serialized ingest transaction — validates
  client candidates only: a candidate below the bound is rejected as
  `out_of_order` (equality allowed). The bound never modifies a chosen
  value. Assistant messages are excluded: they are not user activity.
- Provenance is explicit and persisted per message:
  - `client_sent_at` — the raw client-reported time when it was representable
    as a timestamp (kept even when not trusted); null when absent or
    unparseable.
  - `server_received_at` — the server's clock reading at ingest, kept
    honest; on fallbacks it is identical to the effective time.
  - `effective_at` — the trusted working time chosen at ingest.
  - `time_source` — `client` or `server`.
  - `client_time_status` — why: `absent` (no client time supplied), `valid`
    (client time used), `future_skew` (client time too far ahead of the
    server clock), `out_of_order` (client time below the acceptance/order
    bound), or `invalid` (unparseable client value). The statuses are
    preserved independently: `absent` and `invalid` stay distinguishable,
    and no fallback reason is ever overwritten.
- This is provenance, not a claim of the perfect original send time: a
  `client` source means the client-reported time was plausible at ingest,
  nothing more. Clock skew and delivery delay are recorded, not corrected.
  An accepted client time may sit ahead of later server receipts; the
  effective timeline is therefore advisory — consumers treat negative gaps
  defensively rather than the store fabricating monotonicity.
- Ingest `seq` assignment remains the durable thread order; effective times
  never reorder the thread.
- Idempotent replays return the originally recorded values untouched: an
  ingest retry never re-classifies the client time and never re-runs the
  engagement assessment.
- Assistant messages carry no client time at all; only user messages ingest
  a client-reported send time, and only user messages anchor engagement.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORKER_CLIENT_TIME_MAX_AHEAD_MS` | `10000` | Tolerance for a client clock running ahead of the server clock when accepting the client send time as effective. `0` disables the tolerance. |
