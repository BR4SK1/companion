/**
 * Lease/heartbeat timing alignment for the worker engine.
 *
 * The engine heartbeats while a turn is in flight, renewing the lease well
 * before it expires. The heartbeat cadence is derived from the lease: one
 * third of the lease, never below one second (Node timer granularity and
 * scheduler jitter make sub-second renewal unreliable). For that cadence to
 * fit inside the lease with margin, a lease must be at least three seconds:
 * below that, the clamped heartbeat fires at or after lease expiry and every
 * turn would be reclaimed and fenced mid-flight.
 *
 * Configuration (`config.ts`) validates the configured lease against the
 * same constant, so the valid configuration range and the engine's actual
 * timing cannot drift apart.
 */

/** Minimum lease duration in seconds; see the module comment for why. */
export const MIN_LEASE_SECONDS = 3;

/** Heartbeat interval for a lease, in milliseconds. */
export function heartbeatIntervalMs(leaseSeconds: number): number {
  return Math.max(1000, (leaseSeconds * 1000) / 3);
}
