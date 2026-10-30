import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The preview page is a fully static client surface: no dynamic APIs, no
  // server data. Cache Components' extra prerender pass duplicated every
  // server-inserted Emotion style block in the HTML, so it is off here.
  cacheComponents: false,
};

export default nextConfig;
