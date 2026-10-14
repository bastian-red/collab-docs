import Link from 'next/link';

/**
 * One page for "does not exist" and "you have no access", deliberately identical:
 * the API answers both with 404 so a guessed id reveals nothing (docs/SPECS.md
 * 4.5), and a page that worded them differently would be the leak.
 */
export default function NotFound() {
  return (
    <main id="main" className="auth-page">
      <div className="auth-card">
        <p className="brand">collab-docs</p>
        <h1 className="auth-title">Document not found</h1>
        <p className="muted">
          It may have been deleted, or it may not be shared with you. If someone sent you a link,
          ask them for a new one.
        </p>
        <p>
          <Link className="button button-primary" href="/">
            Back to your documents
          </Link>
        </p>
      </div>
    </main>
  );
}
