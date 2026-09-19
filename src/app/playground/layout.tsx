import type { Metadata } from "next";

// The playground is a client component and cannot export metadata itself.
const title = "Playground — hoodoracle";
const description =
  "Call the oracle live. No key required. Every response is signed, so the price and its confidence band travel together.";

export const metadata: Metadata = {
  title,
  description,
  openGraph: { title, description },
  twitter: { card: "summary_large_image", title, description },
};

export default function PlaygroundLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
