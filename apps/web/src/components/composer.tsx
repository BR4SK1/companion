"use client";

import SendIcon from "@mui/icons-material/Send";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Stack from "@mui/material/Stack";
import TextField from "@mui/material/TextField";
import { useId, useRef, useState, type KeyboardEvent } from "react";
interface ComposerProps {
  /**
   * Called with the composed text. In this preview the callback appends to
   * the in-memory fixture thread only; nothing is transmitted or stored.
   */
  onSend: (text: string) => void;
}

/**
 * Message composer. Enter sends, Shift+Enter inserts a newline, and the
 * field grows to five lines before scrolling. There is deliberately no
 * attachment control: uploads are out of scope for this slice.
 */
export function Composer({ onSend }: ComposerProps) {
  const [draft, setDraft] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const labelId = useId();

  const trimmed = draft.trim();
  const canSend = trimmed.length > 0;

  const submit = () => {
    if (!canSend) {
      return;
    }
    onSend(trimmed);
    setDraft("");
    // Keep the pointer where the owner is typing.
    fieldRef.current?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <Box
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      sx={{
        px: 1.5,
        pt: 1,
        pb: `calc(8px + env(safe-area-inset-bottom, 0px))`,
        bgcolor: "background.paper",
        borderTop: 1,
        borderColor: "divider",
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: "flex-end", width: "100%", maxWidth: 860, mx: "auto" }}
      >
      <TextField
        id={labelId}
        aria-label="Message"
        inputRef={fieldRef}
        multiline
        fullWidth
        minRows={1}
        maxRows={5}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message"
        sx={{
          "& .MuiOutlinedInput-root": { borderRadius: 24, alignItems: "flex-end" },
        }}
      />
      <IconButton
        type="submit"
        color="primary"
        aria-label="Send message"
        disabled={!canSend}
        sx={{ mb: 0.5 }}
      >
        <SendIcon />
      </IconButton>
      </Stack>
    </Box>
  );
}
