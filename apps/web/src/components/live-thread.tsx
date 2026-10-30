"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CircularProgress from "@mui/material/CircularProgress";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Composer } from "@/components/composer";
import { AppHeader } from "@/components/app-header";
import { MessageImageLightbox } from "@/components/message-images";
import { Thread } from "@/components/thread";
import type { Message, MessageImage } from "@/lib/messages";
import {
  appendPending,
  createClientKey,
  detectThreadGaps,
  dropConfirmedPending,
  mayHaveEarlierHistory,
  mergeThreadMessages,
  nextGapWalkStep,
  parseThreadSnapshotResponse,
  removePending,
  updatePending,
  type PendingSend,
  type ThreadMessage,
  type ThreadPage,
  type ThreadStatus,
} from "@/lib/thread-state";

/** Snapshot poll cadence while the page is open. */
const POLL_INTERVAL_MS = 2_000;

/**
 * History bounds for a refresh: after the newest page, up to this many
 * pages are fetched back per cycle until the bottom of the history is
 * reached; older history stays reachable through the "load earlier"
 * control. An interrupted walk (a failed fetch) resumes from where it
 * stopped on a later cycle, still bounded per cycle.
 */
const BACKFILL_MAX_PAGES = 5;

/**
 * At most this many page fetches per poll cycle are spent reconciling gaps
 * in the loaded range. The budget is shared across gaps and spent
 * round-robin so no gap can starve another; walk cursors persist between
 * cycles, so progress through a wide gap is monotonic.
 */
const MAX_RECONCILE_PAGES_PER_CYCLE = 3;

function toUiMessage(message: ThreadMessage): Message {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    sentAt: message.sentAt,
  };
}

/**
 * The live, durable conversation.
 *
 * Data flow: this component reads the BFF's paged thread endpoint and
 * reconciles what it holds (see `thread-state.ts` for the correctness
 * rules). Per cycle it polls the newest page and merges it by message id;
 * it walks history backwards (up to `BACKFILL_MAX_PAGES` per cycle until
 * the bottom, interrupted walks resuming later; older pages behind a "load
 * earlier" control); and it re-derives the gaps between its loaded seqs
 * every cycle and spends a bounded page budget walking those gaps downward
 * — recovering late-committed messages buried under later traffic and
 * waiting out in-flight transactions for as long as they take, with no
 * timing assumption and no hole ever discarded. A seq burned by a
 * rolled-back insert never resolves; its cost is bounded probing, never a
 * missed message. Composed messages post with one stable idempotency key
 * each.
 *
 * States kept visible: first-load loading, connection errors with
 * automatic retry plus an explicit retry control, ended sessions,
 * per-message send failures with retry (same key) or discard, and a
 * sanitized notice when the trailing conversation includes a failed
 * generation.
 */
export function LiveThread() {
  const router = useRouter();
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [status, setStatus] = useState<ThreadStatus>({
    queued: 0,
    generating: false,
    highestAllocatedSeq: 0,
    hasRecentFailure: false,
  });
  const [connection, setConnection] = useState<"loading" | "live" | "error">(
    "loading",
  );
  const [sessionEnded, setSessionEnded] = useState(false);
  const [pending, setPending] = useState<readonly PendingSend[]>([]);
  const [lightboxImage, setLightboxImage] = useState<MessageImage | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);

  const pollingRef = useRef(false);
  const mountedRef = useRef(true);
  const pendingRef = useRef<readonly PendingSend[]>([]);
  const messagesRef = useRef<readonly ThreadMessage[]>([]);
  const statusRef = useRef<ThreadStatus>({
    queued: 0,
    generating: false,
    highestAllocatedSeq: 0,
    hasRecentFailure: false,
  });
  const oldestLoadedRef = useRef<number | null>(null);
  const historyLoadedRef = useRef(false);
  const loadingEarlierRef = useRef(false);
  /**
   * Gap-walk cursors, keyed by the gap's upper neighbor seq: the `before`
   * bound the walk will resume from. Persists between cycles so a walk
   * interrupted by the per-cycle budget or by a fetch failure makes
   * monotonic progress instead of restarting.
   */
  const gapWalkRef = useRef<Map<number, number>>(new Map());
  /**
   * Round-robin offset into the gap list: the index the next cycle starts
   * spending the reconciliation budget at, so a wide gap cannot starve
   * fresher ones.
   */
  const gapRoundRobinRef = useRef(0);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const applySnapshot = useCallback(
    (parsed: {
      messages: readonly ThreadMessage[];
      status: ThreadStatus;
      page: ThreadPage;
    }) => {
      const merged = mergeThreadMessages(messagesRef.current, parsed.messages);
      messagesRef.current = merged;
      oldestLoadedRef.current =
        merged.length > 0 ? (merged[0]?.seq ?? null) : null;
      statusRef.current = parsed.status;
      setMessages(merged);
      setStatus(parsed.status);
      setPending((previous) => dropConfirmedPending(previous, parsed.messages));
    },
    [],
  );

  /**
   * One authenticated page read from the BFF. Reports outcomes as values so
   * the callers (poll, backfill, gap walk, load-earlier) share the same
   * session/error handling.
   */
  const fetchPage = useCallback(
    async (before?: number) => {
      try {
        const url =
          before === undefined
            ? "/api/thread"
            : `/api/thread?before=${String(before)}`;
        const response = await fetch(url, { cache: "no-store" });
        if (!mountedRef.current) {
          return { kind: "stopped" } as const;
        }
        if (response.status === 401) {
          setSessionEnded(true);
          return { kind: "stopped" } as const;
        }
        if (!response.ok) {
          setConnection("error");
          return { kind: "error" } as const;
        }
        const parsed = parseThreadSnapshotResponse(await response.json());
        if (!mountedRef.current) {
          return { kind: "stopped" } as const;
        }
        if (parsed === null) {
          setConnection("error");
          return { kind: "error" } as const;
        }
        setConnection("live");
        setSessionEnded(false);
        return { kind: "ok", parsed } as const;
      } catch {
        if (mountedRef.current) {
          setConnection("error");
        }
        return { kind: "error" } as const;
      }
    },
    [],
  );

  /**
   * Page backwards from `startCursor` (the oldest loaded seq) until the
   * bottom of the history is reached or the per-cycle bound is hit. Returns
   * whether the walk ran to a definite stop (bottom, or bound exhausted) —
   * a failed fetch returns false so the caller retries on a later cycle
   * from where this walk stopped, rather than stranding the progress. The
   * remaining bound is kept in `historyHasMore` and surfaced as the "load
   * earlier" control; `mayHaveEarlierHistory` keeps it visible while
   * allocated-but-uncommitted seqs may still exist below, so committed
   * history is never unreachable through the UI.
   */
  const backfillFrom = useCallback(
    async (startCursor: number): Promise<boolean> => {
      let cursor: number | null = startCursor;
      let more = true;
      for (
        let pageIndex = 0;
        more && cursor !== null && pageIndex < BACKFILL_MAX_PAGES;
        pageIndex += 1
      ) {
        const requested = cursor;
        const result = await fetchPage(requested);
        if (result.kind !== "ok") {
          // The walk stopped above history that may exist, so the control
          // must stay available for the user rather than silently hiding
          // older history.
          setHistoryHasMore(true);
          return false;
        }
        applySnapshot(result.parsed);
        more = mayHaveEarlierHistory(
          result.parsed.page,
          statusRef.current.highestAllocatedSeq,
          requested,
        );
        cursor = result.parsed.page.oldestSeq;
      }
      setHistoryHasMore(more);
      return true;
    },
    [applySnapshot, fetchPage],
  );

  /**
   * Reconcile the loaded range: re-derive the gaps between loaded seqs
   * (cheap, O(loaded messages)) and spend a bounded page budget walking
   * them downward, round-robin so no gap starves another. A gap is either
   * committed-but-unfetched history (the walk recovers it), in flight (the
   * walk recovers it whenever the transaction commits — minutes or hours,
   * no deadline), or burned by a rollback (never resolves; its cost is a
   * bounded share of probing each cycle, never a missed message). Walk
   * cursors persist between cycles, so progress through a wide gap is
   * monotonic across cycles.
   */
  const reconcileGaps = useCallback(async () => {
    const gaps = detectThreadGaps(messagesRef.current);
    // Drop walk cursors for gaps that no longer exist (filled or superseded).
    if (gaps.length === 0) {
      gapWalkRef.current.clear();
      gapRoundRobinRef.current = 0;
      return;
    }
    const liveBounds = new Set(gaps.map((gap) => gap.before));
    for (const key of gapWalkRef.current.keys()) {
      if (!liveBounds.has(key)) {
        gapWalkRef.current.delete(key);
      }
    }
    let budget = MAX_RECONCILE_PAGES_PER_CYCLE;
    const start = gapRoundRobinRef.current % gaps.length;
    // Rotate so each cycle begins where the last one stopped spending.
    const ordered = [...gaps.slice(start), ...gaps.slice(0, start)];
    let examined = 0;
    for (const gap of ordered) {
      if (budget <= 0) {
        break;
      }
      examined += 1;
      let cursor = gapWalkRef.current.get(gap.before) ?? gap.before;
      while (budget > 0) {
        const result = await fetchPage(cursor);
        if (result.kind !== "ok") {
          // Keep the cursor: the next cycle resumes this walk where it
          // stopped, so progress stays monotonic.
          return;
        }
        budget -= 1;
        applySnapshot(result.parsed);
        const step = nextGapWalkStep(result.parsed.page, gap);
        if (step.kind === "continue") {
          cursor = step.cursor;
          gapWalkRef.current.set(gap.before, cursor);
          continue;
        }
        // Stop case: the gap is fully loaded, or everything committed below
        // the cursor is loaded and the remainder is in flight or burned.
        // Either way the walk is done; detection re-derives the gap next
        // cycle if a later commit re-opens it.
        gapWalkRef.current.delete(gap.before);
        break;
      }
    }
    gapRoundRobinRef.current = (start + examined) % gaps.length;
  }, [applySnapshot, fetchPage]);

  const poll = useCallback(async () => {
    if (pollingRef.current) {
      return;
    }
    pollingRef.current = true;
    try {
      const result = await fetchPage();
      if (result.kind !== "ok") {
        return;
      }
      applySnapshot(result.parsed);
      // Walk the history back (bounded per cycle) until the bottom is
      // reached. An interrupted walk marks history not-yet-loaded and
      // resumes from where it stopped on a later cycle.
      if (!historyLoadedRef.current) {
        const startCursor = oldestLoadedRef.current;
        if (
          startCursor === null ||
          !mayHaveEarlierHistory(
            result.parsed.page,
            statusRef.current.highestAllocatedSeq,
          )
        ) {
          // Empty thread, or the newest page demonstrably reaches the
          // bottom (its oldest seq is 1 and nothing is committed below):
          // nothing to walk back; later commits arrive through the
          // newest-page poll.
          historyLoadedRef.current = true;
        } else if (await backfillFrom(startCursor)) {
          historyLoadedRef.current = true;
        }
      }
      await reconcileGaps();
    } finally {
      pollingRef.current = false;
    }
  }, [applySnapshot, backfillFrom, fetchPage, reconcileGaps]);

  useEffect(() => {
    mountedRef.current = true;
    const interval = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      void poll();
    }, POLL_INTERVAL_MS);
    // First snapshot: deferred to a task so state updates happen in a
    // callback, not synchronously within the effect body.
    const initial = setTimeout(() => void poll(), 0);
    return () => {
      mountedRef.current = false;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [poll]);

  const handleLoadEarlier = useCallback(async () => {
    const oldest = oldestLoadedRef.current;
    if (loadingEarlierRef.current || oldest === null) {
      return;
    }
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const result = await fetchPage(oldest);
      if (result.kind === "ok") {
        applySnapshot(result.parsed);
        setHistoryHasMore(
          mayHaveEarlierHistory(
            result.parsed.page,
            statusRef.current.highestAllocatedSeq,
            oldest,
          ),
        );
      }
    } finally {
      loadingEarlierRef.current = false;
      if (mountedRef.current) {
        setLoadingEarlier(false);
      }
    }
  }, [applySnapshot, fetchPage]);

  const dispatchSend = useCallback(
    async (entry: PendingSend) => {
      setPending((previous) =>
        updatePending(previous, entry.clientKey, (current) => ({
          ...current,
          kind: "in_flight",
          needsNewKey: false,
        })),
      );
      let failedNeedsNewKey = false;
      let failed = true;
      try {
        const response = await fetch("/api/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: entry.text, clientKey: entry.clientKey }),
        });
        if (response.ok) {
          failed = false;
          const raw: unknown = await response.json();
          const serverId =
            typeof raw === "object" && raw !== null
              ? ((raw as Record<string, unknown>).message as
                  | Record<string, unknown>
                  | undefined)?.id
              : undefined;
          const confirmedId = typeof serverId === "string" ? serverId : undefined;
          setPending((previous) =>
            updatePending(previous, entry.clientKey, (current) => ({
              ...current,
              kind: "confirmed",
              ...(confirmedId !== undefined ? { serverId: confirmedId } : {}),
            })),
          );
          void poll();
        } else if (response.status === 409) {
          // The key is bound to different content server-side; only a fresh
          // key can recover this composed message.
          failedNeedsNewKey = true;
        }
      } catch {
        // Network failure: keep the same key so the retry stays idempotent.
      }
      if (failed) {
        setPending((previous) =>
          updatePending(previous, entry.clientKey, (current) => ({
            ...current,
            kind: "failed",
            needsNewKey: failedNeedsNewKey,
          })),
        );
      }
    },
    [poll],
  );

  const handleSend = useCallback(
    (text: string) => {
      const entry: PendingSend = {
        clientKey: createClientKey(),
        text,
        sentAt: new Date().toISOString(),
        kind: "in_flight",
        needsNewKey: false,
      };
      setPending((previous) => appendPending(previous, entry));
      void dispatchSend(entry);
    },
    [dispatchSend],
  );

  const handleRetry = useCallback(() => {
    const failedEntries = pendingRef.current.filter(
      (entry) => entry.kind === "failed",
    );
    for (const entry of failedEntries) {
      // A conflicting key reuse is bound to different content server-side;
      // only a fresh key can recover that composed message. Other failures
      // keep the same key so the retry stays idempotent.
      const retried: PendingSend = entry.needsNewKey
        ? { ...entry, clientKey: createClientKey(), needsNewKey: false }
        : entry;
      setPending((current) => {
        const readied = updatePending(current, retried.clientKey, (e) => ({
          ...e,
          kind: "in_flight",
          needsNewKey: false,
        }));
        if (entry.clientKey === retried.clientKey) {
          return readied;
        }
        // Fresh key: replace the failed entry with the re-keyed one.
        return appendPending(removePending(readied, entry.clientKey), {
          ...retried,
          kind: "in_flight",
          needsNewKey: false,
        });
      });
      void dispatchSend(retried);
    }
  }, [dispatchSend]);

  const handleDiscardFailed = useCallback(() => {
    setPending((previous) =>
      previous.filter((entry) => entry.kind !== "failed"),
    );
  }, []);

  const uiMessages = useMemo(() => {
    const durable = messages.map(toUiMessage);
    const inFlight = pending.map(
      (entry): Message => ({
        id: `pending-${entry.clientKey}`,
        role: "user",
        text: entry.text,
        sentAt: entry.sentAt,
      }),
    );
    return [...durable, ...inFlight];
  }, [messages, pending]);

  const failedSends = pending.filter((entry) => entry.kind === "failed");
  const composing = status.generating || status.queued > 0;

  if (sessionEnded) {
    return (
      <Box
        sx={{
          flexGrow: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 2,
          px: 3,
          textAlign: "center",
        }}
      >
        <Typography variant="subtitle1">Your session has ended.</Typography>
        <Button variant="contained" href="/api/auth/login">
          Sign in again
        </Button>
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", flexGrow: 1, minHeight: 0 }}>
      <AppHeader
        onSignOut={() => {
          void (async () => {
            try {
              await fetch("/api/auth/logout", { method: "POST" });
            } catch {
              // Sign-out is best effort: an uncleared cookie is handled by
              // its expiry.
            }
            // Re-render the server components with the cleared session.
            router.refresh();
          })();
        }}
      />
      {historyHasMore && connection !== "loading" && (
        <Box sx={{ display: "flex", justifyContent: "center", py: 0.5 }}>
          {loadingEarlier ? (
            <CircularProgress size={18} aria-label="Loading earlier messages" />
          ) : (
            <Button size="small" onClick={() => void handleLoadEarlier()}>
              Load earlier messages
            </Button>
          )}
        </Box>
      )}
      {connection === "loading" ? (
        <Box
          sx={{
            flexGrow: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
          }}
        >
          <CircularProgress size={28} aria-label="Loading conversation" />
          <Typography variant="body2" color="text.secondary">
            Loading conversation…
          </Typography>
        </Box>
      ) : (
        <Thread messages={uiMessages} onOpenImage={setLightboxImage} />
      )}
      {connection === "live" && composing && (
        <Box sx={{ px: 2, pb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Companion is composing…
          </Typography>
        </Box>
      )}
      {connection === "live" && status.hasRecentFailure && (
        <Box sx={{ px: 2, pb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Some recent messages could not get a reply. You can keep the
            conversation going.
          </Typography>
        </Box>
      )}
      {connection === "error" && (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            px: 2,
            py: 1,
            alignItems: "center",
            bgcolor: "action.selected",
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
            Connection problem — messages may be delayed. Retrying automatically.
          </Typography>
          <Button size="small" onClick={() => void poll()}>
            Retry now
          </Button>
        </Stack>
      )}
      {failedSends.length > 0 && (
        <Stack
          direction="row"
          spacing={1}
          sx={{
            px: 2,
            py: 1,
            alignItems: "center",
            bgcolor: "action.selected",
          }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
            {failedSends.length === 1
              ? "A message could not be sent."
              : `${String(failedSends.length)} messages could not be sent.`}
          </Typography>
          <Button size="small" onClick={handleRetry}>
            Retry
          </Button>
          <Button size="small" onClick={handleDiscardFailed}>
            Discard
          </Button>
        </Stack>
      )}
      <Composer onSend={handleSend} />
      <MessageImageLightbox
        image={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    </Box>
  );
}
