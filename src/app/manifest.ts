import type { MetadataRoute } from "next";

/**
 * Served at /manifest.webmanifest.
 *
 * Without it Android has no home-screen icon to use and falls back to a
 * screenshot of the page, and no browser has a theme colour to tint its
 * chrome with.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "hoodoracle — session-aware price feeds",
    short_name: "hoodoracle",
    description:
      "Price any equity. Publish the error bar with it. Session-aware price feeds for tokenised equities.",
    start_url: "/",
    display: "standalone",
    background_color: "#fbfaf8",
    // Matches the page ground, so the browser chrome does not sit as a
    // differently coloured strip above a paper-white document.
    theme_color: "#fbfaf8",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        // The launcher may crop this to a circle, so it carries more padding.
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
