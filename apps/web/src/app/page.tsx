"use client";

import Box from "@mui/material/Box";
import { useCallback, useState } from "react";

import { AppHeader } from "@/components/app-header";
import { Composer } from "@/components/composer";
import { MessageImageLightbox } from "@/components/message-images";
import { PreviewNotice } from "@/components/preview-notice";
import { Thread } from "@/components/thread";
import { fixtureThread } from "@/lib/fixtures";
import { nextLocalMessageId } from "@/lib/local-ids";
import type { Message, MessageImage } from "@/lib/messages";

/**
 * First web-client slice: a local-only, fixture-backed messenger preview.
 *
 * - The thread is static fixture data; messages typed here are appended to
 *   in-memory state for this page load only. Nothing is sent, stored, or
 *   fetched — there is no backend behind this screen.
 * - No authentication flow exists here; real owner authorization belongs to
 *   the future BFF edge (apps/web/AGENTS.md).
 */

export default function HomePage() {
  const [messages, setMessages] = useState<readonly Message[]>(fixtureThread);
  const [lightboxImage, setLightboxImage] = useState<MessageImage | null>(null);

  const handleSend = useCallback((text: string) => {
    setMessages((previous) => [
      ...previous,
      {
        id: nextLocalMessageId(),
        role: "user",
        text,
        sentAt: new Date().toISOString(),
      },
    ]);
    // No imperative scroll here: the thread follows the newest message only
    // when the reader is already near the bottom. Scrolled up into history,
    // the viewport stays put and the jump-to-latest button appears instead.
  }, []);

  return (
    <Box className="app-shell" sx={{ display: "flex", flexDirection: "column" }}>
      <AppHeader />
      <PreviewNotice />
      <Thread messages={messages} onOpenImage={setLightboxImage} />
      <Composer onSend={handleSend} />
      <MessageImageLightbox
        image={lightboxImage}
        onClose={() => setLightboxImage(null)}
      />
    </Box>
  );
}
