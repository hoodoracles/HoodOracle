import type { Metadata } from "next";
import { UNIVERSE } from "@/lib/universe";

/**
 * The feed page itself is a client component, which cannot export metadata,
 * so a shared /feed/HOOD link inherited the site-wide title and read as if
 * it were the homepage. This layout exists only to name the instrument.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticker: string }>;
}): Promise<Metadata> {
  const { ticker } = await params;
  const symbol = ticker.toUpperCase();
  const instrument = UNIVERSE.find((i) => i.ticker === symbol);

  if (!instrument) {
    return {
      title: `${symbol} — hoodoracle`,
      description: `hoodoracle does not currently price ${symbol}.`,
    };
  }

  const title = `${symbol} — ${instrument.name} — hoodoracle`;
  const description = `Session-aware price for ${symbol}, with its provenance and a 95% confidence band fitted on two years of realised close-to-open gaps.`;

  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary_large_image", title, description },
  };
}

/** Static params so the eight tracked feeds prerender their metadata. */
export function generateStaticParams() {
  return UNIVERSE.map((i) => ({ ticker: i.ticker }));
}

export default function FeedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
