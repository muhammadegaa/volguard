import type { Metadata, Viewport } from "next";
import "./globals.css";

const description =
  "An autonomous options agent that buys movement only when implied volatility is cheap against what the underlying actually delivers. Defined-risk spreads, 27 deterministic risk gates, Alpaca paper trading only.";

export const metadata: Metadata = {
  title: {
    default: "VolGuard — Defined-Risk Options Agent",
    template: "%s · VolGuard",
  },
  description,
  applicationName: "VolGuard",
  authors: [{ name: "VolGuard" }],
  keywords: ["options", "volatility", "variance risk premium", "Alpaca", "paper trading", "trading agent"],
  openGraph: {
    title: "VolGuard — Defined-Risk Options Agent",
    description,
    type: "website",
    siteName: "VolGuard",
  },
  twitter: { card: "summary_large_image", title: "VolGuard", description },
  // Nothing here should be indexed: it renders a specific paper account's balances.
  robots: { index: false, follow: false },
  icons: {
    icon: [{ url: "/icon.svg", type: "image/svg+xml" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0b0d",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // Browser extensions (password managers, Grammarly, recorders) inject attributes onto
    // <html>/<body> before React hydrates, which otherwise surfaces as a hydration warning
    // that has nothing to do with this app.
    <html lang="en" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <a className="skip-link" href="#decision">Skip to the current decision</a>
        {children}
      </body>
    </html>
  );
}
