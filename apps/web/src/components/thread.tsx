"use client";

import KeyboardDoubleArrowDownIcon from "@mui/icons-material/KeyboardDoubleArrowDown";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Fab from "@mui/material/Fab";
import Stack from "@mui/material/Stack";
import { useEffect, useMemo, useRef, useState } from "react";

import { groupThread } from "@/lib/grouping";
import type { Message, MessageImage } from "@/lib/messages";
import { isFollowingBottom, type ScrollGeometry } from "@/lib/scroll";
import { formatDayLabel } from "@/lib/time";

import { MessageClusterView } from "./message-cluster";

interface ThreadProps {
  messages: readonly Message[];
  onOpenImage: (image: MessageImage) => void;
}

function geometryOf(element: HTMLElement): ScrollGeometry {
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
}

/**
 * The continuous visible thread.
 *
 * Scroll anchoring: the list follows the newest message only while the
 * reader is already near the bottom. Scrolled up into history, the viewport
 * is never pulled down — a "jump to latest" button appears instead. This is
 * the core "don't pull the owner away from older messages" behavior.
 */
export function Thread({ messages, onOpenImage }: ThreadProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const followRef = useRef(true);
  const [following, setFollowing] = useState(true);

  const items = useMemo(() => groupThread(messages), [messages]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) {
      return;
    }
    const onScroll = () => {
      const near = isFollowingBottom(geometryOf(element));
      followRef.current = near;
      setFollowing(near);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  // Anchor to the newest message after content changes, but only when the
  // reader was at the bottom; otherwise leave the viewport untouched.
  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || !followRef.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [messages]);

  const focusNewest = () => {
    const element = scrollerRef.current;
    if (!element) {
      return;
    }
    element
      .querySelector<HTMLElement>("[data-last-bubble]")
      ?.focus({ preventScroll: true });
  };

  const jumpToLatest = () => {
    const element = scrollerRef.current;
    if (!element) {
      return;
    }
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    followRef.current = true;
    setFollowing(true);
    focusNewest();
  };

  let lastClusterIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].kind !== "divider") {
      lastClusterIndex = index;
      break;
    }
  }

  return (
    <Box sx={{ position: "relative", flexGrow: 1, minHeight: 0 }}>
      <Box
        ref={scrollerRef}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        tabIndex={0}
        sx={{
          height: "100%",
          overflowY: "auto",
          overscrollBehavior: "contain",
          px: { xs: 1.5, sm: 3 },
          py: 2,
        }}
      >
        <Stack
          spacing={1.25}
          useFlexGap
          sx={{ width: "100%", maxWidth: 860, mx: "auto" }}
        >
          {items.map((item, index) =>
            item.kind === "divider" ? (
              <Box
                key={`divider-${item.at}-${index}`}
                sx={{ display: "flex", alignItems: "center", gap: 1, my: 1 }}
              >
                <Divider sx={{ flex: 1 }} />
                <Chip
                  size="small"
                  variant="outlined"
                  label={
                    <time dateTime={item.at}>{formatDayLabel(item.at)}</time>
                  }
                />
                <Divider sx={{ flex: 1 }} />
              </Box>
            ) : (
              <MessageClusterView
                key={item.messages[0].id}
                cluster={item}
                isThreadEnd={index === lastClusterIndex}
                onOpenImage={onOpenImage}
              />
            ),
          )}
        </Stack>
      </Box>
      {!following && (
        <Fab
          size="small"
          color="primary"
          aria-label="Jump to latest messages"
          onClick={jumpToLatest}
          sx={{ position: "absolute", right: 16, bottom: 16 }}
        >
          <KeyboardDoubleArrowDownIcon fontSize="small" />
        </Fab>
      )}
    </Box>
  );
}
