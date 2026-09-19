import Link from "next/link";
import type { Metadata, Viewport } from "next";
import "./globals.css";

// Next moved themeColor out of `metadata` into its own export; leaving it in
// metadata compiles but emits nothing.
export const viewport: Viewport = {
  themeColor: "#fbfaf8",
};

const TITLE = "hoodoracle — session-aware price feeds for tokenised equities";
const DESCRIPTION =
  "Tokenised equities trade 24/7. The shares behind them price 6.5 hours a day. hoodoracle publishes the price, how it was obtained, and how much to trust it right now.";

export const metadata: Metadata = {
  // Relative image paths in the metadata below resolve against this, so
  // without it a shared link renders with no preview card at all.
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://hoodoracle-neon.vercel.app",
  ),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    title: TITLE,
    description: DESCRIPTION,
    siteName: "hoodoracle",
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

const NAV = [
  { href: "/", label: "Feeds" },
  { href: "/why", label: "The gap" },
  { href: "/docs", label: "Docs" },
  { href: "/playground", label: "Playground" },
  { href: "/integrate", label: "Integrate" },
];

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin=""
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500;600&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <nav className="nav">
          <div className="shell nav-in">
            <Link className="brand" href="/">
              {/* The mark, inline so it needs no request and cannot 404.
                  Geometry is generated in scripts/brand.mts; the banners and
                  the favicon are the same drawing at other sizes. */}
              <svg
                className="brand-mark"
                viewBox="0 0 100 100"
                aria-hidden="true"
              >
                <rect
                  x="48.5"
                  y="23"
                  width="3"
                  height="54"
                  rx="1.5"
                  fill="currentColor"
                  opacity=".38"
                />
                <rect x="10" y="31" width="80" height="6" rx="3" fill="currentColor" />
                <rect x="10" y="23" width="6" height="22" rx="3" fill="currentColor" />
                <rect x="84" y="23" width="6" height="22" rx="3" fill="currentColor" />
                <rect x="27" y="63" width="46" height="6" rx="3" fill="currentColor" />
                <rect x="27" y="55" width="6" height="22" rx="3" fill="currentColor" />
                <rect x="67" y="55" width="6" height="22" rx="3" fill="currentColor" />
                <circle cx="50" cy="34" r="7" fill="var(--accent)" />
                <circle cx="50" cy="66" r="7" fill="var(--accent)" />
              </svg>
              hoodoracle
            </Link>
            <div className="nav-links">
              {NAV.map((n) => (
                <Link key={n.href} className="nav-link" href={n.href}>
                  {n.label}
                </Link>
              ))}
            </div>
          </div>
        </nav>

        <main className="shell">{children}</main>

        <footer className="footer">
          <div className="shell">
            <div
              style={{
                display: "flex",
                gap: 32,
                flexWrap: "wrap",
                justifyContent: "space-between",
              }}
            >
              <div style={{ maxWidth: "46ch" }}>
                <strong>hoodoracle</strong> — an independent oracle for
                tokenised equities. Not affiliated with, endorsed by, or
                operated by Robinhood Markets, Inc.
              </div>
              <div style={{ textAlign: "right" }}>
                Evaluation build. Not for settlement.
                <br />
                Betas fitted on 2y of realised gaps. Contract unaudited.
              </div>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
