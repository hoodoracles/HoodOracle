import Link from "next/link";
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "hoodoracle — session-aware price feeds for tokenised equities",
  description:
    "Tokenised equities trade 24/7. The shares behind them price 6.5 hours a day. hoodoracle publishes the price, how it was obtained, and how much to trust it right now.",
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
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800;900&family=JetBrains+Mono:wght@300;400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <nav className="nav">
          <div className="shell nav-in">
            <Link className="brand" href="/">
              <span className="brand-mark">
                <i />
              </span>
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
                gap: 24,
                flexWrap: "wrap",
                justifyContent: "space-between",
              }}
            >
              <div style={{ maxWidth: "46ch" }}>
                <strong style={{ color: "var(--text-2)" }}>hoodoracle</strong> —
                an independent oracle for tokenised equities. Not affiliated
                with, endorsed by, or operated by Robinhood Markets, Inc.
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
