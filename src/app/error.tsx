"use client";

import { useEffect } from "react";

/**
 * Route-level error boundary. Without it a render error shows the framework's default page,
 * which on a trading dashboard is genuinely alarming — a blank screen reads as "did it place
 * an order?". This says plainly that nothing was traded.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(JSON.stringify({ level: "error", event: "ui.render_error", message: error.message, digest: error.digest }));
  }, [error]);

  return (
    <div className="fallback">
      <div className="fallback-card">
        <span className="fallback-badge">Interface error</span>
        <h1>The dashboard failed to render</h1>
        <p>
          This is a display problem, not a trading one. VolGuard places orders only from the
          server, only in paper mode, and only after its risk checks pass — a broken screen
          cannot cause a trade.
        </p>
        <p className="fallback-detail">{error.message}</p>
        <div className="fallback-actions">
          <button className="btn primary" onClick={reset}>Try again</button>
          <a className="btn ghost" href="/api/health">Check system health</a>
        </div>
        {error.digest && <p className="fallback-digest">Reference: {error.digest}</p>}
      </div>
    </div>
  );
}
