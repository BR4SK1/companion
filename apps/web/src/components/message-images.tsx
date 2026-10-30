"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";

import type { MessageImage } from "@/lib/messages";

interface MessageImageLightboxProps {
  image: MessageImage | null;
  onClose: () => void;
}

/**
 * Full-screen view for an inline fixture image. Image assets are local
 * static files; there is no upload or fetch behavior here.
 */
export function MessageImageLightbox({ image, onClose }: MessageImageLightboxProps) {
  return (
    <Dialog
      open={image !== null}
      onClose={onClose}
      aria-label="Image preview"
      slotProps={{
        paper: {
          sx: { maxWidth: { xs: "100%", sm: "80vw" }, my: { xs: 0, sm: 4 } },
        },
      }}
    >
      {image === null ? null : (
        <>
          <DialogTitle
            sx={{
              pr: 7,
              typography: "subtitle1",
              wordBreak: "break-word",
            }}
          >
            {image.alt}
          </DialogTitle>
          <IconButton
            aria-label="Close image preview"
            onClick={onClose}
            sx={(theme) => ({
              position: "absolute",
              right: 8,
              top: `calc(env(safe-area-inset-top, 0px) + 8px)`,
              color: theme.palette.grey[500],
            })}
          >
            <CloseIcon />
          </IconButton>
          <DialogContent dividers sx={{ p: 1 }}>
            <Box
              component="img"
              src={image.src}
              alt={image.alt}
              width={image.width}
              height={image.height}
              sx={{
                display: "block",
                width: "100%",
                height: "auto",
                maxHeight: { xs: "70dvh", sm: "80dvh" },
                objectFit: "contain",
                borderRadius: 2,
              }}
            />
          </DialogContent>
        </>
      )}
    </Dialog>
  );
}

interface MessageImageThumbProps {
  image: MessageImage;
  onOpen: (image: MessageImage) => void;
}

/** Inline image inside a bubble. Dimensions are reserved to avoid layout shift. */
export function MessageImageThumb({ image, onOpen }: MessageImageThumbProps) {
  return (
    <Box
      component="button"
      type="button"
      onClick={() => onOpen(image)}
      aria-label={`Open image: ${image.alt}`}
      sx={{
        display: "block",
        width: "100%",
        maxWidth: 280,
        p: 0,
        border: "none",
        background: "none",
        cursor: "zoom-in",
        borderRadius: 2,
        overflow: "hidden",
      }}
    >
      <Box
        component="img"
        src={image.src}
        alt={image.alt}
        width={image.width}
        height={image.height}
        loading="lazy"
        sx={{
          display: "block",
          width: "100%",
          height: "auto",
          borderRadius: 2,
        }}
      />
    </Box>
  );
}

