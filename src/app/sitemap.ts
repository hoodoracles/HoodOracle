import type { MetadataRoute } from "next";
import { UNIVERSE } from "@/lib/universe";

/** Served at /sitemap.xml. Static pages plus one entry per tracked feed. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://hoodoracle-neon.vercel.app";
  const now = new Date();

  const pages = [
    "",
    "/why",
    "/coverage",
    "/docs",
    "/playground",
    "/integrate",
  ].map((p) => ({
    url: `${base}${p}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: p === "" ? 1 : 0.7,
  }));

  const feeds = UNIVERSE.map((i) => ({
    url: `${base}/feed/${i.ticker}`,
    lastModified: now,
    changeFrequency: "hourly" as const,
    priority: 0.6,
  }));

  return [...pages, ...feeds];
}
