import type { MetadataRoute } from "next";

/**
 * Served at /robots.txt.
 *
 * The relayer endpoint is excluded: it is authenticated and spends gas, so
 * there is nothing for a crawler there but 401s.
 */
export default function robots(): MetadataRoute.Robots {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://hoodoracle-neon.vercel.app";
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/cron/" },
    sitemap: `${base}/sitemap.xml`,
  };
}
