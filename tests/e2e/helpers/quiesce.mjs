/**
 * Cross-test quiescence for the end-to-end suite.
 *
 * A turn's lifecycle spans the BFF, the worker, and the fake provider, so
 * "the previous test is done" must be observed, not assumed: provider
 * scripting (record resets, failure modes, latency) and pattern-table
 * changes (seeding, disabling) must never race a turn that is still in
 * flight. Two independent signals are required, sampled twice in a row for
 * stability:
 *
 * - the worker's durable thread status: no unassigned user message
 *   (`queued === 0`) and no in-flight turn (`generating === false`);
 * - the fake provider holds no capability call that has not completed
 *   (`/__control/pending`), covering the window between the worker's
 *   claim and the call's completion under artificial latency.
 */

import { config } from "./config.mjs";
import { providerPending } from "./provider.mjs";

const gateOrigin = () => `http://127.0.0.1:${String(config.gatePort)}`;

let sessionCookie = null;

async function sessionHeader() {
  if (sessionCookie !== null) {
    return { cookie: sessionCookie };
  }
  // Manual redirects: undici has no cookie jar, so following the issuance
  // redirect chain cookie-less would loop until the redirect limit. The
  // issuance response itself carries the session cookie (a 303 here).
  const response = await fetch(`${gateOrigin()}/api/test-gate/session`, { redirect: "manual" });
  if (response.status >= 400) {
    throw new Error(`test-gate session issuance failed: ${String(response.status)}`);
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  const pair = cookies
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith("companion_test_session="));
  if (pair === undefined) {
    throw new Error("test-gate session issuance returned no session cookie");
  }
  sessionCookie = pair;
  return { cookie: sessionCookie };
}

/**
 * The worker's durable thread status, read over HTTP without a browser:
 * `{queued, generating, highestAllocatedSeq, hasRecentFailure}`.
 */
export async function workerStatus() {
  const headers = await sessionHeader();
  const response = await fetch(`${gateOrigin()}/api/thread`, {
    headers,
    redirect: "manual",
  });
  if (response.status === 401) {
    // The session may have expired between runs: re-issue once.
    sessionCookie = null;
    const retryHeaders = await sessionHeader();
    const retry = await fetch(`${gateOrigin()}/api/thread`, {
      headers: retryHeaders,
      redirect: "manual",
    });
    if (!retry.ok) {
      throw new Error(`thread status read failed: ${String(retry.status)}`);
    }
    return (await retry.json()).status;
  }
  if (!response.ok) {
    throw new Error(`thread status read failed: ${String(response.status)}`);
  }
  const body = await response.json();
  return body.status;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until the worker has no queued or in-flight turn and the provider
 * holds no unfinished call — sampled twice in a row (250 ms apart) so a
 * sample taken in the gap between an ingest commit and the worker's claim
 * cannot pass as quiescent. Transient read errors (stack still starting,
 * session hiccup) are retried until the deadline; a timeout throws with the
 * last observed signals so the failure is diagnosable.
 */
export async function waitForQuiescent(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let stable = false;
  let lastStatus = null;
  let lastPending = null;
  for (;;) {
    try {
      lastStatus = await workerStatus();
      lastPending = await providerPending();
      const quiescent =
        lastStatus.queued === 0 &&
        lastStatus.generating === false &&
        lastPending.chat === 0 &&
        lastPending.decisions === 0;
      if (quiescent) {
        if (stable) {
          return;
        }
        stable = true;
      } else {
        stable = false;
      }
    } catch {
      // Not readable yet (or the stack is gone): keep retrying until the
      // deadline. A persistent failure times out below with the last
      // observations.
      stable = false;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the stack did not become quiescent within ${String(timeoutMs)} ms ` +
          `(worker status: ${JSON.stringify(lastStatus)}, provider pending: ${JSON.stringify(lastPending)})`,
      );
    }
    await sleep(250);
  }
}
