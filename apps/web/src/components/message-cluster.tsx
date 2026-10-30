"use client";

import Avatar from "@mui/material/Avatar";
import Box from "@mui/material/Box";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import type { Message, MessageCluster, MessageImage } from "@/lib/messages";
import { formatClockTime } from "@/lib/time";

import { MessageImageThumb } from "./message-images";

interface MessageClusterViewProps {
  cluster: MessageCluster;
  /** True when this cluster contains the newest message of the thread. */
  isThreadEnd: boolean;
  onOpenImage: (image: MessageImage) => void;
}

interface BubbleProps {
  message: Message;
  isStart: boolean;
  isEnd: boolean;
  isUser: boolean;
  markAsThreadEnd: boolean;
  onOpenImage: (image: MessageImage) => void;
}

/** Corner radii that visually connect consecutive bubbles, messenger-style. */
function bubbleRadius(isUser: boolean, isStart: boolean, isEnd: boolean): string {
  if (isUser) {
    return `${isStart ? 4 : 16}px 16px 16px ${isEnd ? 4 : 16}px`;
  }
  return `16px ${isStart ? 4 : 16}px ${isEnd ? 4 : 16}px 16px`;
}

function Bubble({
  message,
  isStart,
  isEnd,
  isUser,
  markAsThreadEnd,
  onOpenImage,
}: BubbleProps) {
  const text = message.text ?? "";
  const images = message.images ?? [];

  if (text.length === 0 && images.length > 0) {
    return (
      <Box
        data-last-bubble={markAsThreadEnd ? "" : undefined}
        tabIndex={markAsThreadEnd ? -1 : undefined}
        sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}
      >
        {images.map((image) => (
          <MessageImageThumb key={image.src} image={image} onOpen={onOpenImage} />
        ))}
      </Box>
    );
  }

  return (
    <Box
      data-last-bubble={markAsThreadEnd ? "" : undefined}
      tabIndex={markAsThreadEnd ? -1 : undefined}
      sx={{
        px: 1.5,
        py: 1,
        maxWidth: "100%",
        overflowWrap: "anywhere",
        borderRadius: bubbleRadius(isUser, isStart, isEnd),
        ...(isUser
          ? { bgcolor: "primary.main", color: "primary.contrastText" }
          : {
              bgcolor: "background.paper",
              color: "text.primary",
              border: 1,
              borderColor: "divider",
            }),
      }}
    >
      {text.length > 0 && (
        <Typography
          variant="body1"
          component="p"
          sx={{ whiteSpace: "pre-line", m: 0, fontSize: "0.9375rem", lineHeight: 1.45 }}
        >
          {text}
        </Typography>
      )}
      {images.length > 0 && (
        <Stack spacing={0.5} sx={{ mt: text.length > 0 ? 1 : 0 }}>
          {images.map((image) => (
            <MessageImageThumb key={image.src} image={image} onOpen={onOpenImage} />
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * One rendered group of consecutive same-role messages. The owner's messages
 * sit on the right in the primary color; the companion's sit on the left with
 * an avatar. Inline images render inside the bubble flow, never as separate
 * fragments of the thread.
 */
export function MessageClusterView({
  cluster,
  isThreadEnd,
  onOpenImage,
}: MessageClusterViewProps) {
  const isUser = cluster.role === "user";
  const count = cluster.messages.length;

  return (
    <Stack
      direction={isUser ? "row-reverse" : "row"}
      spacing={1}
      sx={{ width: "100%", alignItems: "flex-start" }}
    >
      {isUser ? (
        <Box sx={{ width: 32, flexShrink: 0 }} aria-hidden="true" />
      ) : (
        <Avatar
          sx={{ bgcolor: "primary.main", width: 32, height: 32, fontSize: "0.8rem", flexShrink: 0 }}
        >
          C
        </Avatar>
      )}
      <Stack
        spacing={0.5}
        sx={{
          maxWidth: { xs: "82%", sm: 520 },
          alignItems: isUser ? "flex-end" : "flex-start",
          minWidth: 0,
        }}
      >
        {cluster.messages.map((message, index) => (
          <Box
            key={message.id}
            sx={{ display: "flex", flexDirection: "column", gap: 0.25, maxWidth: "100%" }}
          >
            <Bubble
              message={message}
              isStart={index === 0}
              isEnd={index === count - 1}
              isUser={isUser}
              markAsThreadEnd={isThreadEnd && index === count - 1}
              onOpenImage={onOpenImage}
            />
            {index === count - 1 && (
              <Typography
                variant="caption"
                component="time"
                dateTime={message.sentAt}
                sx={{
                  px: 0.5,
                  color: "text.secondary",
                  textAlign: isUser ? "right" : "left",
                }}
              >
                {formatClockTime(message.sentAt)}
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}
