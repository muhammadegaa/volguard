import Link from "next/link";

export default function NotFound() {
  return (
    <div className="fallback">
      <div className="fallback-card">
        <span className="fallback-badge">404</span>
        <h1>No such page</h1>
        <p>VolGuard is a single dashboard. Everything lives on one screen.</p>
        <div className="fallback-actions">
          <Link className="btn primary" href="/">Back to the dashboard</Link>
        </div>
      </div>
    </div>
  );
}
