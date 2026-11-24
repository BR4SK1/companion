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
  dropConfirmedPending,
  mergeThreadMessages,
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

function toUiMessage(message: ThreadMessage): Message {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    sentAt: message.sentAt,
    ...(message.images !== undefined && message.images.length > 0
      ? { images: message.images }
      : {}),
  };
}

export function LiveThread() {
  const router = useRouter();
  const [messages, setMessages] = useState<readonly ThreadMessage[]>([]);
  const [timezone, setTimezone] = useState<string | null>(null);
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

  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const newestSeen = useRef<number | undefined>(undefined);
  const pollingRef = useRef(false);
  const mountedRef = useRef(true);
  const pendingRef = useRef<readonly PendingSend[]>([]);
  const messagesRef = useRef<readonly ThreadMessage[]>([]);
  const loadingEarlierRef = useRef(false);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const applySnapshot = useCallback(
    (parsed: {
      messages: readonly ThreadMessage[];
      status: ThreadStatus;
      page: ThreadPage;
      timezone: string | null;
    }) => {
      if (parsed.messages.length > 0) {
        const merged = mergeThreadMessages(messagesRef.current, parsed.messages);
        messagesRef.current = merged;
        setMessages(merged);
        setPending(previous => dropConfirmedPending(previous, merged));
      }
      setTimezone(parsed.timezone);
      setStatus(parsed.status);
    },
    [],
  );

  /**
   * One authenticated page read from the BFF. Reports outcomes as values so
   * the callers (poll and load-earlier) share the same
   * session/error handling.
   */
  const fetchPage = useCallback(
    async (cursor?: { before: number } | { after: number }) => {
      try {
        const url =
          cursor === undefined
            ? "/api/thread"
            : `/api/thread?${"before" in cursor ? "before=" + cursor.before : "after=" + cursor.after}`;
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

  const poll = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    try {
      let newest = newestSeen.current;
      do {
        const result = await fetchPage(newest === undefined ? undefined : { after: newest });
        if (result.kind !== "ok") return;
        applySnapshot(result.parsed);
        newestSeen.current = result.parsed.messages.at(-1)?.seq ?? newest ?? 0;
        if (newest === undefined) {
          setHistoryHasMore(result.parsed.page.hasMore);
          return;
        }
        newest = result.parsed.messages.at(-1)?.seq;
        if (!result.parsed.page.hasMore) return;
      } while (newest !== undefined && mountedRef.current);
    } finally {
      pollingRef.current = false;
    }
  }, [applySnapshot, fetchPage]);

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
    const oldest = messagesRef.current[0]?.seq;
    if (loadingEarlierRef.current || oldest === undefined) {
      return;
    }
    loadingEarlierRef.current = true;
    setLoadingEarlier(true);
    try {
      const result = await fetchPage({ before: oldest });
      if (result.kind === "ok") {
        applySnapshot(result.parsed);
        setHistoryHasMore(result.parsed.page.hasMore);
      }
    } finally {
      loadingEarlierRef.current = false;
      if (mountedRef.current) {
        setLoadingEarlier(false);
      }
    }
  }, [applySnapshot, fetchPage]);

  async function retryGeneration() {
    if (!status.retryAttemptId || retrying) return;
    setRetrying(true);
    setRetryError(false);
    try {
      const response = await fetch(`/api/thread?attempt=${encodeURIComponent(status.retryAttemptId)}`, { method: "POST" });
      if (response.status === 401) setSessionEnded(true);
      else if (!response.ok && response.status !== 409) setRetryError(true);
      await poll();
    } catch {
      setRetryError(true);
    } finally {
      setRetrying(false);
    }
  }

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
          body: JSON.stringify({
            text: entry.text,
            clientKey: entry.clientKey,
            // The original compose/send time, captured once per composed
            // message and reused across retries so the worker records the
            // original send time, never the retry time.
            clientSentAt: entry.sentAt,
          }),
        });
        if (response.ok) {
          const raw: unknown = await response.json();
          const serverId =
            typeof raw === "object" && raw !== null
              ? ((raw as Record<string, unknown>).message as
                  | Record<string, unknown>
                  | undefined)?.id
              : undefined;
          if (typeof serverId !== "string" || !serverId) throw new Error("Missing message ID");
          failed = false;
          if (messagesRef.current.some(message => message.id === serverId)) {
            setPending(previous => removePending(previous, entry.clientKey));
            return;
          }
          setPending((previous) =>
            updatePending(previous, entry.clientKey, (current) => ({
              ...current,
              kind: "confirmed",
              serverId,
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
        <Thread messages={uiMessages} timezone={timezone} onOpenImage={setLightboxImage} />
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
          {status.retryAttemptId && (
            <Button size="small" disabled={retrying} onClick={() => void retryGeneration()}>
              Retry reply
            </Button>
          )}
          {retryError && <Typography role="alert">Could not request a retry.</Typography>}
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
