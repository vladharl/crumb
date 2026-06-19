import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

// Inter carries all working text. Italic is a real face here (loaded below), not
// a synthesized shear — General Sans has no italic master, so every italic in the
// app (the workspace tag, quoted replies, the .italic util) resolves to Inter's
// true italic. 700 was dropped: nothing rendered it but a single arrow glyph;
// 600 is the heaviest weight the design uses.
const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-body-loaded",
  display: "swap",
});

const jbMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono-loaded",
  display: "swap",
});

// General Sans — the display face (headings, wordmark, KPI numerals) — self-hosted
// from our own origin via next/font instead of a render-blocking third-party
// <link> to Fontshare. That link sat in <head> and blocked first paint on a
// cross-origin CSS fetch, then a second hop for the woff2; self-hosting removes
// both round-trips, auto-preloads the files, and synthesizes a metric-matched
// fallback so the swap from system-ui doesn't shift layout. It also drops a
// hard runtime dependency on Fontshare being reachable from every self-hosted
// deployment's end users. Only the weight actually in use is shipped: 600 — every
// heading, the wordmark, and the KPI numerals are 600, and nothing renders the
// display face lighter (the italic tags now use Inter's true italic, not a
// faux-sheared General Sans).
const generalSans = localFont({
  src: [
    { path: "./fonts/general-sans-600.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-display-loaded",
  display: "swap",
  fallback: ["GT Walsheim", "Söhne", "system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: "Crumb · Follow the trail",
  description: "Open-source B2B feedback platform. Embed, triage, ship, notify.",
};

// viewport-fit=cover lets the cream surface bleed under the notch / home
// indicator; the safe-area insets the app honors (topbar, nav sheet, toasts,
// bottom sheets) keep controls clear of them. initialScale without maximumScale
// so pinch-zoom stays available (accessibility).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#FBF7F0",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jbMono.variable} ${generalSans.variable}`}>
      <body>{children}</body>
    </html>
  );
}
