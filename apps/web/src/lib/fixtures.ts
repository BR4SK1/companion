/**
 * Fixture thread for the local-only preview.
 *
 * Everything here is static, local, and never sent anywhere: there is no
 * backend, no durable storage, and no live chat behind this data. Local
 * messages the owner types exist only in memory for the session and reset on
 * reload. Image attachments are static SVG fixtures served by this app —
 * image generation itself is an out-of-scope external capability, not
 * integrated here.
 */

import type { Message } from "./messages";

export const fixtureThread: readonly Message[] = [
  {
    id: "f-01",
    role: "user",
    text: "Morning! The house plants are looking dramatic again.",
    sentAt: "2026-10-29T08:12:00Z",
  },
  {
    id: "f-02",
    role: "assistant",
    text: "Good morning. Dramatic how — drooping, or has the monstera staged another escape?",
    sentAt: "2026-10-29T08:12:14Z",
  },
  {
    id: "f-03",
    role: "user",
    text: "Mostly drooping. I watered them last night like the schedule said.",
    sentAt: "2026-10-29T08:14:02Z",
  },
  {
    id: "f-04",
    role: "assistant",
    text: "Let's check the usual suspects before changing anything:\n\n1. Pot weight — a heavy pot right after watering is normal; a light one means the water ran straight through.\n2. Drainage — standing water in the saucer is a common droop cause.\n3. Light — has anything moved near the window recently?",
    sentAt: "2026-10-29T08:14:40Z",
  },
  {
    id: "f-05",
    role: "user",
    text: "Pot felt heavy, and the saucer had a puddle. I'll empty it.",
    sentAt: "2026-10-29T08:31:10Z",
  },
  {
    id: "f-06",
    role: "assistant",
    text: "That points to soggy roots rather than thirst. Empty the saucer, let the top couple of centimetres dry out, and hold off on the next watering until the pot feels noticeably lighter.",
    sentAt: "2026-10-29T08:31:38Z",
  },
  {
    id: "f-07",
    role: "assistant",
    text: "For reference, here's the dry-soil check I mentioned earlier.",
    sentAt: "2026-10-29T08:32:05Z",
    images: [
      {
        src: "/fixtures/render-01.svg",
        alt: "Fixture image: abstract sunset over calm water",
        width: 800,
        height: 600,
      },
    ],
  },
  {
    id: "f-08",
    role: "user",
    text: "That makes sense. The window spot gets great afternoon light, by the way — you were right that it's the brightest spot in the flat.",
    sentAt: "2026-10-29T13:05:44Z",
  },
  {
    id: "f-09",
    role: "assistant",
    text: "Bright afternoon light suits most of what you have there. Just watch for leaf scorch on the thin-leafed ones during the strongest weeks of summer.",
    sentAt: "2026-10-29T13:06:21Z",
  },
  {
    id: "f-10",
    role: "user",
    text: "New topic for today: I want a quick mood board for the reading corner.",
    sentAt: "2026-10-30T09:02:00Z",
  },
  {
    id: "f-11",
    role: "assistant",
    text: "Happy to. Three directions to react to:",
    sentAt: "2026-10-30T09:02:18Z",
    images: [
      {
        src: "/fixtures/render-02.svg",
        alt: "Fixture image: overlapping botanical leaf shapes in greens",
        width: 800,
        height: 800,
      },
      {
        src: "/fixtures/render-03.svg",
        alt: "Fixture image: aurora bands over a dark mountain ridge",
        width: 800,
        height: 1000,
      },
    ],
  },
  {
    id: "f-12",
    role: "user",
    text: "The green one. Warm lamp, one plant, nothing else on the shelf.",
    sentAt: "2026-10-30T09:20:47Z",
  },
  {
    id: "f-13",
    role: "assistant",
    text: "Noted — one plant, warm lamp, negative space as a feature. I'll keep that palette in mind next time.",
    sentAt: "2026-10-30T09:21:05Z",
  },
] as const;
