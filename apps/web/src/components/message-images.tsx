"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";

import type { MessageImage } from "@/lib/messages";

interface MessageImageLightboxProps {
  image: MessageImage | null;
  onClose: () => void;
}

/**
 * Full-screen lightbox for an inline thread image. Keeps the viewport clear of
 * caption chrome so the image scales as large as possible on mobile screens.
 */
export function MessageImageLightbox({ image, onClose }: MessageImageLightboxProps) {
  return (
    <Dialog
      open={image !== null}
      onClose={onClose}
      fullScreen
      aria-label="Image preview"
      slotProps={{
        paper: {
          sx: {
            bgcolor: "rgba(0, 0, 0, 0.94)",
            backgroundImage: "none",
            boxShadow: "none",
            overflow: "hidden",
          },
        },
      }}
    >
      {image === null ? null : (
        <Box
          onClick={onClose}
          sx={{
            position: "relative",
            width: "100%",
            height: "100dvh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            p: 0,
          }}
        >
          <IconButton
            aria-label="Close image preview"
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            sx={{
              position: "absolute",
              right: "calc(env(safe-area-inset-right, 0px) + 12px)",
              top: "calc(env(safe-area-inset-top, 0px) + 12px)",
              zIndex: 1,
              color: "common.white",
              bgcolor: "rgba(0, 0, 0, 0.55)",
              "&:hover": {
                bgcolor: "rgba(0, 0, 0, 0.78)",
              },
            }}
          >
            <CloseIcon />
          </IconButton>
          <Box
            component="img"
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            sx={{
              display: "block",
              width: "100%",
              height: "100%",
              objectFit: "contain",
              userSelect: "none",
            }}
          />
        </Box>
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

